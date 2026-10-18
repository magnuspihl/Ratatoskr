import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AccountInput, ActionResult, ComposePayload, Me, MessageRef } from '../../../shared/types.js';
import { accountDefaultsFor, withDefaultPassword, type TemplateValues } from '../accountDefaults.js';
import type { Config } from '../config.js';
import type { Store, User } from '../db.js';
import { MailServerError, testConnection } from '../imap/connect.js';
import { MessageGoneError, StaleError, type ListSource, type MailService } from '../imap/mail.js';
import { NotFoundError, type ImapPool } from '../imap/pool.js';
import { RemoteImageCache, type RemoteImage } from '../net/remoteImages.js';
import { displayDomain, MAX_ALLOWED_DOMAINS, normaliseDomain } from '../mail/imageAllowlist.js';
import { FailureLimiter, hashPassword, passwordSchema, verifyPassword } from '../auth/password.js';
import type { Sessions } from '../auth/session.js';
import { ComposeError, type ComposeService } from '../mail/send.js';
import { SnoozeError, type SnoozeService } from '../mail/snooze.js';
import { PushSubscriptionError, validateSubscription, type PushService } from '../push/service.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
  }
}

// ---- validation schemas -----------------------------------------------------

const tls = z.enum(['tls', 'starttls', 'none']);
const host = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[a-zA-Z0-9.\-:[\]]+$/, 'Invalid host name');
const server = z.object({
  host,
  port: z.coerce.number().int().min(1).max(65535),
  tls,
  user: z.string().max(320),
  password: z.string().max(1024).optional(),
});
const accountSchema = z.object({
  name: z.string().trim().min(1).max(100),
  displayName: z.string().trim().max(200),
  email: z.string().trim().min(3).max(320),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  imap: server,
  smtp: server,
  appendSent: z.boolean(),
});

const refSchema = z.object({
  accountId: z.string().min(1).max(64),
  folder: z.string().min(1).max(1000),
  uid: z.coerce.number().int().positive(),
  uidValidity: z.string().regex(/^\d+$/),
});

const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('seen'), value: z.boolean() }),
  z.object({ type: z.literal('flagged'), value: z.boolean() }),
  z.object({ type: z.literal('move'), destination: z.string().min(1).max(1000) }),
  z.object({ type: z.literal('archive') }),
  z.object({ type: z.literal('delete') }),
  z.object({ type: z.literal('snooze'), until: z.string().max(64) }),
  z.object({ type: z.literal('unsnooze') }),
]);

const swipe = z.enum(['none', 'delete', 'archive', 'toggleRead', 'toggleFlag']);
export const prefsSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']),
  pageSize: z.number().int().min(10).max(200),
  markReadOnOpen: z.boolean(),
  swipeLeft: swipe,
  swipeRight: swipe,
  notificationContent: z.enum(['full', 'minimal']).default('full'),
  squirrelTransitions: z.boolean().default(true),
});

const pushSubscriptionSchema = z.object({
  endpoint: z.string().max(2000),
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
});

const composeSchema = z.object({
  accountId: z.string().min(1).max(64),
  to: z.string().max(10_000),
  cc: z.string().max(10_000),
  bcc: z.string().max(10_000),
  subject: z.string().max(1000),
  html: z.string().max(5_000_000),
  inReplyTo: z.string().max(1000).nullable(),
  references: z.array(z.string().max(1000)).max(100),
  forwardFrom: refSchema.extend({ indices: z.array(z.number().int().min(0)).max(100) }).nullable(),
  replaceDraft: refSchema.nullable(),
  answering: refSchema.nullable(),
});

// ---- helpers ------------------------------------------------------------------

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof z.ZodError) {
    return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
  }
  if (err instanceof NotFoundError || err instanceof MessageGoneError) return reply.code(404).send({ error: err.message });
  if (err instanceof StaleError) return reply.code(409).send({ error: err.message, stale: true });
  if (err instanceof ComposeError || err instanceof PushSubscriptionError || err instanceof SnoozeError) return reply.code(400).send({ error: err.message });
  if (err instanceof MailServerError) return reply.code(502).send({ error: err.message });
  reply.log.error({ err }, 'request failed');
  return reply.code(500).send({ error: 'Internal error' });
}

function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export interface ApiDeps {
  config: Config;
  store: Store;
  sessions: Sessions;
  pool: ImapPool;
  mail: MailService;
  compose: ComposeService;
  push: PushService;
  snooze: SnoozeService;
  /** VAPID public key, the browser's applicationServerKey. */
  vapidPublicKey: string;
  /** Replaces the DNS check of push service hosts (tests only). */
  pushHostCheck?: (host: string) => Promise<void>;
  /** Replaces the real remote image fetcher (tests only). */
  fetchImage?: (url: string) => Promise<RemoteImage>;
}

export async function registerApiRoutes(app: FastifyInstance, deps: ApiDeps) {
  const { config, store, sessions, pool, mail, compose, push, snooze, vapidPublicKey, pushHostCheck, fetchImage } = deps;

  app.decorateRequest('user', null);

  // Authentication + CSRF protection for the whole /api namespace.
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    const session = sessions.read(req);
    const user = session ? store.getUser(session.uid) : null;
    if (!user) return reply.code(401).send({ error: 'Not logged in' });
    req.user = user;
    // State-changing requests must carry a custom header. Browsers only allow that from our own
    // origin (it would require a CORS preflight, which we never grant).
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-ratatoskr'] !== '1') {
      return reply.code(403).send({ error: 'Missing CSRF header' });
    }
  });

  const uid = (req: FastifyRequest) => req.user!.id;
  /** Values for {username}, {email} and {name} in the admin's default account settings. */
  const templateValues = (u: User): TemplateValues => ({
    // OIDC providers don't always send a preferred_username; the email's local part is the next best thing.
    username: u.username || (u.email.includes('@') ? u.email.slice(0, u.email.lastIndexOf('@')) : ''),
    email: u.email,
    name: u.name,
  });
  const ownsAccount = (userId: string, accountId: string) => store.listAccounts(userId).some((a) => a.id === accountId);
  const requireAccount = (userId: string, accountId: string) => {
    if (!ownsAccount(userId, accountId)) throw new NotFoundError('Account not found');
  };
  // Fetched remote images, shared across requests (per-user keys, short TTL, size-capped).
  const imageCache = new RemoteImageCache();
  /** When a message in a Snoozed folder comes back, as an ISO time (undefined if not snoozed). */
  const snoozedUntil = (userId: string) => {
    const cache = new Map<string, Map<number, number>>();
    return (m: MessageRef): string | undefined => {
      const k = `${m.accountId}\u0000${m.folder}\u0000${m.uidValidity}`;
      let byUid = cache.get(k);
      if (!byUid) cache.set(k, (byUid = store.snoozesIn(userId, m.accountId, m.folder, m.uidValidity)));
      const t = byUid.get(m.uid);
      return t === undefined ? undefined : new Date(t).toISOString();
    };
  };

  // ---- me / preferences -----------------------------------------------------

  app.get('/api/me', async (req): Promise<Me> => {
    const u = req.user!;
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      preferences: u.preferences,
      hasPassword: u.hasPassword,
      accountDefaults: accountDefaultsFor(config.accountDefaults, templateValues(u)),
    };
  });

  const passwordChangeSchema = z.object({ current: z.string().max(1000), next: passwordSchema });
  const passwordFailures = new FailureLimiter(10, 15 * 60 * 1000);

  app.put('/api/password', async (req, reply) => {
    const userId = uid(req);
    const stored = store.getPasswordHash(userId);
    if (!stored) return reply.code(400).send({ error: 'This account signs in with single sign-on' });
    const body = passwordChangeSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]!.message });
    if (passwordFailures.blocked(userId)) return reply.code(429).send({ error: 'Too many failed attempts. Try again in a few minutes.' });
    if (!(await verifyPassword(body.data.current, stored))) {
      passwordFailures.fail(userId);
      return reply.code(403).send({ error: 'Current password is wrong' });
    }
    passwordFailures.reset(userId);
    store.setPasswordHash(userId, await hashPassword(body.data.next));
    return { ok: true };
  });

  app.put('/api/preferences', async (req, reply) => {
    try {
      const prefs = prefsSchema.parse(req.body);
      store.setPreferences(uid(req), prefs);
      return prefs;
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---- Web Push (phone notifications) -------------------------------------------

  app.get('/api/push', async () => ({ publicKey: vapidPublicKey }));

  app.post('/api/push/subscriptions', async (req, reply) => {
    try {
      const sub = pushSubscriptionSchema.parse(req.body);
      await validateSubscription(sub, pushHostCheck);
      store.addPushSubscription(uid(req), sub);
      pool.setBackground(uid(req), true, true);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete('/api/push/subscriptions', async (req, reply) => {
    try {
      const { endpoint } = z.object({ endpoint: z.string().max(2000) }).parse(req.body);
      store.removePushSubscription(uid(req), endpoint);
      if (store.listPushSubscriptions(uid(req)).length === 0) pool.setBackground(uid(req), false);
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/push/test', async (req) => ({ delivered: await push.sendTest(uid(req)) }));

  // ---- sender domains allowed to show images ----------------------------------

  const domainBody = z.object({ domain: z.string().max(400) });
  const parseDomain = (raw: string) => {
    const domain = normaliseDomain(raw);
    if (!domain) throw new ComposeError('Not a valid domain name');
    return domain;
  };
  const listDomains = (userId: string) => store.listImageDomains(userId).map(displayDomain);

  app.get('/api/image-domains', async (req) => listDomains(uid(req)));

  app.post('/api/image-domains', async (req, reply) => {
    try {
      const domain = parseDomain(domainBody.parse(req.body).domain);
      if (!store.addImageDomain(uid(req), domain, MAX_ALLOWED_DOMAINS)) {
        throw new ComposeError(`You can allow at most ${MAX_ALLOWED_DOMAINS} domains`);
      }
      return listDomains(uid(req));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { domain: string } }>('/api/image-domains/:domain', async (req, reply) => {
    try {
      if (!store.removeImageDomain(uid(req), parseDomain(req.params.domain))) {
        return reply.code(404).send({ error: 'Domain not in the list' });
      }
      return listDomains(uid(req));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---- accounts ---------------------------------------------------------------

  app.get('/api/accounts', async (req) => store.listAccounts(uid(req)));

  const verify = async (input: AccountInput, existing?: { imap: string; smtp: string }) => {
    const imapPw = input.imap.password || existing?.imap || '';
    const smtpPw = input.smtp.password || existing?.smtp || imapPw;
    await testConnection(
      { ...input.imap, password: imapPw },
      { ...input.smtp, password: smtpPw },
      config.blockPrivateMailHosts,
    );
  };

  app.post('/api/accounts/test', async (req, reply) => {
    try {
      const body = z.object({ account: accountSchema, id: z.string().optional() }).parse(req.body);
      const existing = body.id ? store.getAccountSecret(uid(req), body.id) : null;
      if (existing) await verify(body.account, { imap: existing.imap.password, smtp: existing.smtp.password });
      else await verify(withDefaultPassword(config.accountDefaults, templateValues(req.user!), body.account));
      return { ok: true };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/accounts', async (req, reply) => {
    try {
      const input = withDefaultPassword(config.accountDefaults, templateValues(req.user!), accountSchema.parse(req.body));
      if (!input.imap.password) throw new ComposeError('IMAP password is required');
      await verify(input);
      const account = store.createAccount(uid(req), input);
      pool.accountAdded(uid(req), account.id);
      return account;
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.put<{ Params: { id: string } }>('/api/accounts/:id', async (req, reply) => {
    try {
      const input = accountSchema.parse(req.body);
      const existing = store.getAccountSecret(uid(req), req.params.id);
      if (!existing) throw new NotFoundError('Account not found');
      await verify(input, { imap: existing.imap.password, smtp: existing.smtp.password });
      const account = store.updateAccount(uid(req), req.params.id, input);
      pool.invalidate(uid(req), req.params.id);
      return account;
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/accounts/:id', async (req, reply) => {
    if (!store.deleteAccount(uid(req), req.params.id)) return reply.code(404).send({ error: 'Account not found' });
    pool.invalidate(uid(req), req.params.id);
    return { ok: true };
  });

  // ---- folders ----------------------------------------------------------------

  app.get('/api/folders', async (req) => {
    const accounts = store.listAccounts(uid(req));
    return Promise.all(accounts.map((a) => mail.listFolders(uid(req), a.id)));
  });

  // ---- message list -----------------------------------------------------------

  app.get('/api/messages', async (req, reply) => {
    try {
      const q = z
        .object({
          accountId: z.string().optional(),
          folder: z.string().max(1000).optional(),
          cursor: z.string().max(10_000).optional(),
          q: z.string().trim().max(500).optional(),
          unread: z.enum(['0', '1']).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        })
        .parse(req.query);
      const userId = uid(req);
      let sources: ListSource[];
      if (q.accountId) {
        requireAccount(userId, q.accountId);
        sources = [{ accountId: q.accountId, folder: q.folder || 'INBOX' }];
      } else {
        // Unified view: every account's INBOX.
        sources = store.listAccounts(userId).map((a) => ({ accountId: a.id, folder: 'INBOX' }));
      }
      const limit = q.limit ?? req.user!.preferences.pageSize;
      const list = await mail.listMessages(userId, sources, q.cursor ?? null, limit, { text: q.q ?? '', unread: q.unread === '1' });
      const until = snoozedUntil(userId);
      for (const m of list.messages) {
        const t = until(m);
        if (t) m.snoozedUntil = t;
      }
      return list;
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---- single message -----------------------------------------------------------

  app.get('/api/message', async (req, reply) => {
    try {
      // remote=1: the user asked to load images; remote=0: keep them blocked (e.g. for quoting);
      // absent: the server decides from the user's sender-domain allowlist.
      const q = refSchema.extend({ remote: z.enum(['0', '1']).optional() }).parse(req.query);
      requireAccount(uid(req), q.accountId);
      const detail = await mail.getMessage(uid(req), q, {
        allowRemote: q.remote === undefined ? undefined : q.remote === '1',
        imageDomains: q.remote === undefined ? store.listImageDomains(uid(req)) : [],
        imageCache,
        fetchImage,
        maxBytes: config.maxMessageBytes,
      });
      const until = snoozedUntil(uid(req))(q);
      if (until) detail.snoozedUntil = until;
      reply.header('cache-control', 'private, no-store');
      return detail;
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/attachment', async (req, reply) => {
    try {
      const q = refSchema.extend({ index: z.coerce.number().int().min(0) }).parse(req.query);
      requireAccount(uid(req), q.accountId);
      const att = await mail.getAttachment(uid(req), q, q.index, config.maxMessageBytes);
      // Always a download, never rendered by the browser on our origin.
      return reply
        .header('content-type', 'application/octet-stream')
        .header('content-disposition', contentDisposition(att.filename))
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .header('cache-control', 'private, no-store')
        .send(att.content);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/messages/actions', async (req, reply) => {
    try {
      const body = z.object({ messages: z.array(refSchema).min(1).max(1000), action: actionSchema }).parse(req.body);
      const userId = uid(req);
      // Group by (account, folder, uidValidity): one IMAP command per group.
      const groups = new Map<string, { ref: MessageRef; uids: number[] }>();
      for (const m of body.messages) {
        requireAccount(userId, m.accountId);
        const k = `${m.accountId}\u0000${m.folder}\u0000${m.uidValidity}`;
        const g = groups.get(k) ?? { ref: m, uids: [] };
        g.uids.push(m.uid);
        groups.set(k, g);
      }
      const result: ActionResult = { undo: [], permanent: false, createdFolders: [] };
      const action = body.action;
      for (const { ref, uids } of groups.values()) {
        let r;
        if (action.type === 'snooze') r = await snooze.snooze(userId, ref, uids, action.until);
        else if (action.type === 'unsnooze') r = await snooze.unsnooze(userId, ref, uids);
        else {
          r = await mail.applyAction(userId, ref.accountId, ref.folder, ref.uidValidity, uids, action);
          // Snoozed messages moved or deleted by hand no longer come back on their own.
          if (action.type === 'move' || action.type === 'archive' || action.type === 'delete') {
            store.deleteSnoozes(userId, ref.accountId, ref.folder, ref.uidValidity, uids);
          }
        }
        if (r.undo) result.undo.push(r.undo);
        if (r.permanent) result.permanent = true;
        if (r.createdFolder) result.createdFolders.push(r.createdFolder);
      }
      return result;
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---- compose ----------------------------------------------------------------------

  const readCompose = async (req: FastifyRequest) => {
    let payload: unknown = null;
    const files: { filename: string; contentType: string; content: Buffer }[] = [];
    let total = 0;
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        const content = await part.toBuffer();
        total += content.length;
        if (total > config.maxUploadBytes) throw new ComposeError('Attachments are too large');
        files.push({ filename: part.filename || 'attachment', contentType: part.mimetype || 'application/octet-stream', content });
      } else if (part.fieldname === 'payload') {
        payload = JSON.parse(String(part.value));
      }
    }
    const parsed = composeSchema.parse(payload) as ComposePayload;
    requireAccount(uid(req), parsed.accountId);
    if (parsed.forwardFrom) requireAccount(uid(req), parsed.forwardFrom.accountId);
    if (parsed.replaceDraft) requireAccount(uid(req), parsed.replaceDraft.accountId);
    if (parsed.answering) requireAccount(uid(req), parsed.answering.accountId);
    return { payload: parsed, files };
  };

  app.post('/api/send', async (req, reply) => {
    try {
      const { payload, files } = await readCompose(req);
      return await compose.send(uid(req), payload, files);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/drafts', async (req, reply) => {
    try {
      const { payload, files } = await readCompose(req);
      return await compose.saveDraft(uid(req), payload, files);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/recipients', async (req) => {
    const q = z.object({ q: z.string().max(200).default('') }).parse(req.query);
    return store.searchRecipients(uid(req), q.q);
  });
}
