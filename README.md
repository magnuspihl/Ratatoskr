# Ratatoskr

A simple, good-looking, self-hosted webmail client for **any IMAP/SMTP account**.

- **Thin client.** Your IMAP/SMTP servers stay the source of truth. Ratatoskr has no local mail
  store, no message cache and no sync engine. The only state it keeps is users, their encrypted
  account settings and preferences (plus, for notifications, push subscriptions and the newest
  INBOX UID already notified about), in one SQLite file.
- **One container.** Configured by environment variables, with a volume for the SQLite file. No
  Redis, no Postgres, no sidecars.
- **Modern UI.** Clean three-pane layout, first-class dark mode, usable on a phone.
- **Every email is treated as hostile.** See [Security model](#security-model).

## Features

- Several IMAP/SMTP accounts per user (host, port, TLS/STARTTLS, credentials, separate SMTP
  settings, display name, colour). Connections are tested when you save. Passwords are encrypted
  at rest (AES-256-GCM) and never sent back to the browser.
- Login with any OpenID Connect provider (Authentik, Keycloak, …). Each OIDC user owns their own
  accounts, with strict per-user isolation.
- Unified inbox across all accounts (merged by date, paginated with per-account cursors), plus
  per-account folder trees with unread counts. Live updates via IMAP IDLE pushed over one
  WebSocket per browser session.
- Message list with sender, subject, snippet, date, unread/flagged/answered/attachment
  indicators, and an account colour tag in the unified view.
- Reading plain text and HTML, with inline (`cid:`) images and attachment downloads. Remote
  images are blocked by default; "Load images" has the server fetch them and embed them in the
  message, so the sender never sees your IP address. "Always load from example.com" adds the
  sender's domain (and its subdomains) to a per-user list whose mail loads images automatically;
  manage the list in Settings.
- Mark read/unread, flag, move, archive, delete (to Trash, expunge only from Trash), multi-select.
- Compose, reply, reply-all, and forward (with the original attachments). Includes a light
  rich-text editor, an automatic plain-text alternative, attachments, drafts (saved to the
  account's Drafts folder), a copy in Sent, and recipient autocomplete from recently used
  addresses. Special-use folders (`\Sent`, `\Drafts`, `\Trash`, `\Archive`, `\Junk`) are detected
  with name fallbacks.
- Server-side IMAP search in the current folder, or across all inboxes in the unified view.
- Dark mode that follows the system, with a manual override. Simple HTML and plain-text mail get
  dark styling. Heavily designed mail (newsletters) is shown on a light "paper" card instead of
  being force-inverted, with a per-message toggle.
- Notifications for new mail on phones and desktops (Web Push), and an unread badge on the app
  icon. Install Ratatoskr as an app (PWA) from the browser; see [Notifications](#notifications).
- Keyboard shortcuts: `j`/`k` to move, `r` reply, `a` reply all, `f` forward, `e` archive,
  `#` delete, `s` flag, `u` mark unread, `c` compose, `Ctrl/Cmd+Enter` to send.

## Quick start (Docker)

1. Register an OIDC client at your identity provider (see [OIDC setup](#oidc-setup)).
2. Create a `.env` next to `docker-compose.yml`:

   ```sh
   RATATOSKR_SECRET_KEY=$(openssl rand -base64 48)
   OIDC_CLIENT_SECRET=the-client-secret-from-your-provider
   ```

3. Adjust `RATATOSKR_BASE_URL` and `OIDC_*` in [`docker-compose.yml`](docker-compose.yml), then run:

   ```sh
   docker compose up -d
   ```

4. Put a TLS-terminating reverse proxy in front (see below), open `https://mail.example.com`,
   sign in, and add your first mail account.

The image is published to `ghcr.io/<owner>/ratatoskr` by the GitHub Actions workflow on every
push to `main`. You can also build it yourself with `docker build -t ratatoskr .`.

## Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `RATATOSKR_BASE_URL` | yes (prod) | `http://localhost:8080` | Public URL of the app. Used for the OIDC redirect URI, cookie `Secure` flag and WebSocket origin check. |
| `RATATOSKR_SECRET_KEY` | yes | – | Master secret, at least 32 characters (`openssl rand -base64 48`). Subkeys for credential encryption, session cookies and URL signing are derived from it with HKDF. **If you change it, stored account passwords can no longer be decrypted.** |
| `OIDC_ISSUER_URL` | yes | – | Issuer URL; `/.well-known/openid-configuration` is discovered from it. |
| `OIDC_CLIENT_ID` | yes | – | Client ID. |
| `OIDC_CLIENT_SECRET` | usually | – | Client secret (confidential client). |
| `OIDC_SCOPES` | no | `openid email profile` | Requested scopes. |
| `RATATOSKR_TRUST_PROXY` | no | `false` | Trust `X-Forwarded-*` headers. Set to `true` behind a reverse proxy. |
| `RATATOSKR_DATA_DIR` | no | `./data` (`/data` in the image) | Where `ratatoskr.db` (SQLite) lives. |
| `PORT` / `HOST` | no | `8080` / `0.0.0.0` | Listen address. |
| `RATATOSKR_BLOCK_PRIVATE_MAIL_HOSTS` | no | `false` | Refuse IMAP/SMTP hosts that resolve to private/internal addresses. Turn on if untrusted users can log in. Leave off if your mail server is on your LAN. |
| `RATATOSKR_IMAP_IDLE_TIMEOUT` | no | `300` | Seconds before an unused pooled IMAP connection is closed. |
| `RATATOSKR_MAX_MESSAGE_MB` | no | `50` | Largest message the server downloads for display. |
| `RATATOSKR_MAX_UPLOAD_MB` | no | `25` | Largest total attachment upload when composing. |
| `RATATOSKR_VAPID_SUBJECT` | no | `RATATOSKR_BASE_URL` if it is `https://`, else `mailto:postmaster@<host>` | Contact sent to push services (Apple, Google, Mozilla) with every notification: a `mailto:` or `https:` URL. |
| `LOG_LEVEL` | no | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace`. |
| `RATATOSKR_DEV_LOGIN` | no | `false` | Development only: log in as a local dev user without OIDC. Ignored when `NODE_ENV=production` (always set in the image). |
| `RATATOSKR_DEV_ALLOWED_HOST_SUFFIX` | no | – | Development only: also serve the dev server on any host ending in this suffix (see [Development](#development)). Ignored when `NODE_ENV=production` and by the production build. |

### Notifications

Ratatoskr is an installable web app (PWA) and can send notifications for new mail through the
browsers' standard Web Push services. No native app, no Firebase or Apple developer account and
no extra configuration are needed. The push keys (VAPID) are derived from
`RATATOSKR_SECRET_KEY`. HTTPS is required.

Each user turns notifications on per device in **Settings → Notifications**:

- **Android** (Chrome, Firefox, Edge, Samsung Internet) and **desktop browsers**: turn the switch on.
  Installing the app ("Add to Home screen" / "Install app") is optional.
- **iPhone and iPad** (iOS/iPadOS 16.4 or newer): open the site in Safari, tap *Share → Add to
  Home Screen*, open Ratatoskr from the Home Screen, then turn the switch on. A Safari tab can't
  receive notifications.

What you get:

- One notification per new **unread** message in any account's INBOX (several messages that
  arrive together are summarised in one). Tapping it opens the message.
- Nothing while the app is open and focused on any of your devices, since the list updates live
  anyway.
- Users choose whether notifications show **sender and subject** or only "New message" and the
  account name. The payload is end-to-end encrypted to the device (RFC 8291), but it does pass
  through Apple's, Google's or Mozilla's push service.
- The app icon shows the number of unread messages across all inboxes, where the platform
  supports badges.

How it works: while a user has notifications on at least one device, the server keeps one IMAP
IDLE connection per account open on INBOX, even when no browser is open. Mind your provider's
connection limits (Gmail allows 15 simultaneous IMAP connections per account). The server
remembers the newest INBOX UID it has notified about, so after a restart it reports mail that
arrived while it was down, but never old mail when notifications are switched on. Subscriptions
that the push service reports as expired are removed automatically. Signing out stops
notifications on that device.

### OIDC setup

Create an OAuth2/OpenID Connect application (confidential client, authorization code flow) with:

- Redirect URI: `https://mail.example.com/auth/callback`
- Post-logout redirect URI (optional): `https://mail.example.com/`
- Scopes: `openid email profile`

**Authentik:** create an *OAuth2/OpenID Provider* and an *Application*. The issuer URL looks like
`https://auth.example.com/application/o/<application-slug>/`. Use Authentik's application
bindings/policies to decide who may log in.

**Keycloak:** create a client with *Client authentication* on and *Standard flow* enabled. The
issuer URL looks like `https://auth.example.com/realms/<realm>`.

Anyone your provider lets through can use Ratatoskr. Users are identified by issuer and `sub`
claim, and each user sees only the mail accounts they added themselves. Ratatoskr uses PKCE,
`state` and `nonce`, and supports RP-initiated logout if the provider advertises an
`end_session_endpoint`.

### Reverse proxy notes

- Terminate TLS at the proxy and set `RATATOSKR_BASE_URL` to the public `https://` URL and
  `RATATOSKR_TRUST_PROXY=true`.
- **WebSockets** must be proxied on `/api/ws` (live updates). Nginx:

  ```nginx
  location / {
      proxy_pass http://127.0.0.1:8080;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection $connection_upgrade;  # map $http_upgrade, see nginx docs
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_read_timeout 1h;
      client_max_body_size 30m;   # attachments
  }
  ```

  Caddy and Traefik proxy WebSockets automatically.
- Allow request bodies at least as large as `RATATOSKR_MAX_UPLOAD_MB` (plus a little overhead).
- Serve Ratatoskr on its own (sub)domain, not under a path prefix.

## Security model

Every message is assumed to be hostile.

- **HTML mail** is sanitized on the server with `sanitize-html` and a `postcss`-based CSS
  sanitizer. Removed: scripts, event handlers, forms, frames, objects, SVG/MathML,
  meta/base/link, comments, `javascript:`/`data:` links, CSS expressions, `@import`,
  behaviours, and anything hidden behind CSS escapes. Links are limited to
  `http`/`https`/`mailto`/`tel` and open in a new tab with `noopener noreferrer`.
- The result is rendered in an `<iframe sandbox>` **without** `allow-scripts` and
  `allow-same-origin`. That gives it an opaque origin, so it can't reach the app, its cookies or
  storage. A strict Content-Security-Policy inside the frame (`default-src 'none'; img-src data:`)
  blocks scripts, forms, frames and **every** network request: the rendered message never
  contacts any server, which also means it works behind cookie-based auth proxies.
- **Remote content is blocked by default.** "Load images" makes the server download the images
  (`<img>`, `background=` and CSS `url()`) and embed them as `data:` URIs, so senders never see the
  reader's IP address, cookies or referrer. The fetcher only fetches `http(s)` on ports 80/443.
  It resolves DNS itself and refuses loopback/private/link-local/CGNAT/ULA/multicast/reserved
  addresses, including IPv4-mapped IPv6 and IP literals. It connects to the address it checked
  (no DNS-rebinding window), re-checks every redirect, and only accepts raster image types (no
  SVG). Limits per message: 6 parallel fetches, 10 MB per image, 15 MB and 100 images in total,
  and a 20 s budget. Anything over a limit, failing or blocked is left out, keeping its size and
  alt text as a placeholder. Fetched images sit in a small in-memory cache (per user, 10
  minutes, 64 MB) so toggling or reopening a message doesn't download them again.
- **Sender-domain allowlist.** The server decides when it fetches a message: if the From domain
  is on the user's list (exact match or a subdomain; case-insensitive, IDN normalised to
  punycode), images load automatically through the same fetcher. From is easy to forge, so as a
  cheap guard nothing auto-loads when the topmost `Authentication-Results` header (the one added
  by your own mail server) records `dmarc=fail` for the From domain; the user can still click
  "Load images". Without that header, or with `pass`/`none`, the allowlist applies as normal.
- `cid:` images are inlined as `data:` URLs. Attachments are always served as downloads
  (`Content-Disposition: attachment`, `application/octet-stream`, `nosniff`, sandbox CSP).
- The app sends a strict CSP (`script-src 'self'`), `frame-ancestors 'none'`, `nosniff`,
  `no-referrer`, and other hardening headers.
- **Credentials:** AES-256-GCM with a random IV, and the ciphertext bound to its user and account
  (AAD), so a copied database row doesn't decrypt elsewhere. Passwords are never returned by the
  API.
- **Notifications:** push subscription endpoints come from the browser, so the server only
  accepts and POSTs to the known browser push services (`fcm.googleapis.com`,
  `*.push.apple.com`, `*.push.services.mozilla.com`, `*.notify.windows.com`, ...) over HTTPS,
  never to arbitrary URLs. Payloads are encrypted for the receiving device. The service worker
  only shows notifications. It caches nothing and only opens paths of the app itself.
- **Sessions** are encrypted, HttpOnly, SameSite=Lax cookies. State-changing API calls also
  require a custom header, which cross-site pages can't send. WebSocket upgrades check
  `Origin`.

## Development

Requirements: Node.js ≥ 22.13 (uses the built-in `node:sqlite`) and Docker (for integration
tests).

```sh
npm install
cp .env.example .env          # set RATATOSKR_SECRET_KEY; for local work you can use RATATOSKR_DEV_LOGIN=true
PORT=5173 npm run dev         # Vite on $PORT, backend on $PORT+1 (proxied under /api and /auth)
```

If you open the dev server through a reverse proxy, set `RATATOSKR_BASE_URL` to that public URL.
Vite only accepts that host name (plus `localhost`).

If the same setup is reached through several proxied hostnames that differ only in a leading part
(e.g. one per port: `5173--myworkspace--me.dev.example.com`, `40140--myworkspace--me.dev.example.com`),
also set `RATATOSKR_DEV_ALLOWED_HOST_SUFFIX=--myworkspace--me.dev.example.com`. The suffix must
start with `.` or `--` and is matched exactly at the end of the host name, so lookalikes such as
`…dev.example.com.evil.test` are refused. In development the WebSocket origin check then follows
the request host, and dev login works on each of those hosts (cookies are per host, so log in once
per host). OIDC still needs the real `RATATOSKR_BASE_URL`: its redirect URI is built from it, so OIDC
logins always return to that one host.

| Command | What it does |
| --- | --- |
| `npm run typecheck` | Type-check server and web client. |
| `npm test` | Unit tests: sanitizer (hostile fixtures), MIME parsing, credential encryption, SSRF guards, unified-inbox merging, Web Push encryption (RFC 8291 test vector) and notifications. |
| `npm run test:integration` | Starts a throwaway [GreenMail](https://greenmail-mail-test.github.io/greenmail/) container (Docker), runs the full HTTP API against real IMAP/SMTP, and removes the container. |
| `npm run build` | Compiles the server to `dist/server` and the web client to `dist/web`. |
| `npm start` | Runs the production build. |

### Architecture

```
server/src
  app.ts            Fastify setup, security headers, static files
  auth/             OIDC login (openid-client) and encrypted session cookies
  db.ts             SQLite store: users, encrypted accounts, preferences, recent recipients
  imap/pool.ts      Lazy per-account IMAP connections with idle timeout; IDLE watchers
  imap/mail.ts      Folders, unified listing (k-way merge with per-account UID cursors), actions
  mail/sanitize.ts  HTML sanitizer; mail/css.ts CSS sanitizer
  mail/compose.ts   MIME building (Nodemailer MailComposer); mail/send.ts SMTP + Sent/Drafts
  net/              SSRF guards and the server-side remote image fetcher
shared/             Types and the sandboxed iframe document builder (used by both sides)
web/src             React + TanStack Query client
```

Paging the unified inbox: each source (account + folder) is consumed newest-UID-first. Pages are
merged by date, and the cursor stores, per source, the UIDVALIDITY and the lowest UID returned so
far. If a folder's UIDVALIDITY changes, the server tells the client to reload the list. Message
actions carry the UIDVALIDITY too and are refused (HTTP 409) if it no longer matches.

## Limitations

- No conversation threading yet. Messages are listed individually.
- Live updates (IDLE) cover each account's INBOX. Other folders refresh when you open them, when
  the window regains focus, and every couple of minutes.
- Sent copies are appended without the Bcc header.
- No OAuth2 IMAP (XOAUTH2 for Gmail/Microsoft 365). Use app passwords where the provider
  supports them.
- Out of scope: server-side filters, calendar/contacts, JMAP, PGP, local full-text search.
