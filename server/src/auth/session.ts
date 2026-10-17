import type { FastifyReply, FastifyRequest } from 'fastify';
import { openJson, sealJson } from '../crypto.js';

export const SESSION_COOKIE = 'rk_session';
export const LOGIN_COOKIE = 'rk_login';
const SESSION_TTL = 14 * 24 * 3600;
const LOGIN_TTL = 10 * 60;

export interface SessionData {
  uid: string;
  /** id_token for RP-initiated logout, if the provider supports it. */
  idt?: string;
}

export interface LoginTransaction {
  state: string;
  nonce: string;
  verifier: string;
}

/**
 * Sessions are stateless, AES-GCM encrypted cookies (no server-side session store needed, which
 * keeps the "one container, one SQLite file" promise). HttpOnly + SameSite=Lax, Secure on https.
 */
export class Sessions {
  constructor(
    private readonly key: Buffer,
    private readonly secure: boolean,
  ) {}

  private cookieOpts(path: string, maxAge: number) {
    return { path, httpOnly: true, sameSite: 'lax' as const, secure: this.secure, maxAge };
  }

  read(req: FastifyRequest): SessionData | null {
    return openJson<SessionData>(this.key, req.cookies[SESSION_COOKIE], 'session');
  }

  write(reply: FastifyReply, data: SessionData) {
    reply.setCookie(SESSION_COOKIE, sealJson(this.key, data, SESSION_TTL, 'session'), this.cookieOpts('/', SESSION_TTL));
  }

  clear(reply: FastifyReply) {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  writeLogin(reply: FastifyReply, tx: LoginTransaction) {
    reply.setCookie(LOGIN_COOKIE, sealJson(this.key, tx, LOGIN_TTL, 'login'), this.cookieOpts('/auth', LOGIN_TTL));
  }

  takeLogin(req: FastifyRequest, reply: FastifyReply): LoginTransaction | null {
    reply.clearCookie(LOGIN_COOKIE, { path: '/auth' });
    return openJson<LoginTransaction>(this.key, req.cookies[LOGIN_COOKIE], 'login');
  }
}
