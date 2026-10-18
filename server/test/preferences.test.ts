import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES } from '../src/db.js';
import { prefsSchema } from '../src/routes/api.js';

const base = { theme: 'system', pageSize: 50, markReadOnOpen: true, swipeLeft: 'delete', swipeRight: 'archive', notificationContent: 'full' };

describe('squirrel transitions preference', () => {
  it('is on by default for new users', () => {
    expect(DEFAULT_PREFERENCES.squirrelTransitions).toBe(true);
  });
  it('stays on when saved by a client that does not know about it yet', () => {
    expect(prefsSchema.parse(base).squirrelTransitions).toBe(true);
  });
  it('can be switched off and rejects non-boolean values', () => {
    expect(prefsSchema.parse({ ...base, squirrelTransitions: false }).squirrelTransitions).toBe(false);
    expect(prefsSchema.safeParse({ ...base, squirrelTransitions: 'no' }).success).toBe(false);
  });
});
