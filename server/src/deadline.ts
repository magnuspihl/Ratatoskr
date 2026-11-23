/** A request took longer than it may: answered with 504 so the browser stops waiting. */
export class DeadlineError extends Error {}

/** How long opening a message may take before the browser gets an error instead. */
export const MESSAGE_DEADLINE_MS = 60_000;

/**
 * Settle with `work`, or reject with a DeadlineError after `ms`. The work itself keeps running
 * (an IMAP command can't be taken back), so whatever it caches still helps the next attempt.
 */
export function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(message)), ms);
  });
  // A late failure must not become an unhandled rejection once the deadline has answered.
  work.catch(() => undefined);
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}
