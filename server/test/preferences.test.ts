import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES } from '../src/db.js';
import { prefsSchema } from '../src/routes/api.js';

const base = { theme: 'system', pageSize: 50, markReadOnOpen: true, swipeLeft: 'delete', swipeRight: 'archive', notificationContent: 'full' };

describe('screen transitions preference', () => {
  it('is Fast by default for new users', () => {
    expect(DEFAULT_PREFERENCES.screenTransitions).toBe('fast');
  });
  it('stays Fast when saved by a client that does not know about it yet', () => {
    expect(prefsSchema.parse(base).screenTransitions).toBe('fast');
  });
  it('accepts Off, Fast, Medium and Slow and rejects anything else', () => {
    for (const v of ['off', 'fast', 'medium', 'slow']) expect(prefsSchema.parse({ ...base, screenTransitions: v }).screenTransitions).toBe(v);
    expect(prefsSchema.safeParse({ ...base, screenTransitions: 'ludicrous' }).success).toBe(false);
    expect(prefsSchema.safeParse({ ...base, screenTransitions: false }).success).toBe(false);
  });
});

describe('contact pictures preference', () => {
  it('stays on when saved by a client that does not know about it yet', () => {
    expect(prefsSchema.parse(base).contactPhotos).toBe(true);
  });
  it('can be turned off', () => {
    expect(prefsSchema.parse({ ...base, contactPhotos: false }).contactPhotos).toBe(false);
    expect(prefsSchema.safeParse({ ...base, contactPhotos: 'no' }).success).toBe(false);
  });
});
