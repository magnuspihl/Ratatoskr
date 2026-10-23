import { ApiError } from './api';

/** How far along an attachment download is: shown on its chip while it runs. */
export type DownloadState =
  | { status: 'idle' }
  /** Waiting for the server, which fetches the message from the mail server first. */
  | { status: 'preparing' }
  | { status: 'receiving'; received: number; total: number | null }
  | { status: 'done' }
  | { status: 'error'; message: string };

/** 0–100, or null while there is nothing to measure yet. */
export function downloadPercent(s: DownloadState): number | null {
  if (s.status !== 'receiving' || !s.total) return null;
  return Math.min(100, Math.round((s.received / s.total) * 100));
}

/** Short text for the chip, e.g. "Preparing…", "42%", "Saved". */
export function downloadLabel(s: DownloadState): string | null {
  switch (s.status) {
    case 'preparing':
      return 'Preparing…';
    case 'receiving': {
      const pct = downloadPercent(s);
      return pct === null ? 'Downloading…' : `${pct}%`;
    }
    case 'done':
      return 'Saved';
    case 'error':
      return 'Failed';
    default:
      return null;
  }
}

/** Hands the finished file to the browser's downloads (default: a click on a blob link). */
export type SaveFile = (blob: Blob, filename: string) => void;

const saveWithLink: SaveFile = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a moment to start the download before the URL goes away.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
};

/**
 * Fetch an attachment and save it, reporting progress on the way, so a click gives immediate
 * feedback instead of the file silently appearing in the downloads folder much later.
 */
export async function downloadFile(
  url: string,
  filename: string,
  onState: (s: DownloadState) => void,
  opts: { fetch?: typeof fetch; save?: SaveFile; signal?: AbortSignal } = {},
): Promise<void> {
  const doFetch = opts.fetch ?? fetch;
  const save = opts.save ?? saveWithLink;
  onState({ status: 'preparing' });
  try {
    const res = await doFetch(url, { credentials: 'same-origin', signal: opts.signal });
    if (!res.ok) {
      let msg = res.statusText || `HTTP ${res.status}`;
      try {
        msg = ((await res.json()) as { error?: string }).error ?? msg;
      } catch {
        /* not JSON */
      }
      throw new ApiError(msg, res.status);
    }
    const header = Number(res.headers.get('content-length'));
    const total = Number.isFinite(header) && header > 0 ? header : null;
    let received = 0;
    onState({ status: 'receiving', received, total });
    const chunks: BlobPart[] = [];
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.byteLength;
        onState({ status: 'receiving', received, total });
      }
    } else {
      chunks.push(await res.arrayBuffer());
    }
    save(new Blob(chunks, { type: res.headers.get('content-type') ?? 'application/octet-stream' }), filename);
    onState({ status: 'done' });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      onState({ status: 'idle' });
      return;
    }
    onState({ status: 'error', message: (err as Error).message || 'Download failed' });
  }
}
