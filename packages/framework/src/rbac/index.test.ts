import { describe, it, expect } from 'vitest';

import { createRole, checkLocalPermission } from './index.ts';

// Domain statement instantiation — mirrors how a consumer would define it.
const statement = {
  listings: ['create', 'read', 'update', 'delete'],
  bookings: ['create', 'read', 'update', 'delete'],
  jobs: ['read', 'cancel'],
} as const;

describe('createRole / authorize', () => {
  const admin = createRole<typeof statement>({
    listings: ['create', 'read', 'update', 'delete'],
    bookings: ['create', 'read', 'update', 'delete'],
    jobs: ['read', 'cancel'],
  });

  it('authorizes a granted resource + action subset', () => {
    expect(admin.authorize({ listings: ['read'] }).success).toBe(true);
    expect(admin.authorize({ bookings: ['create', 'update'] }).success).toBe(true);
  });

  it('authorizes an empty request', () => {
    expect(admin.authorize({}).success).toBe(true);
  });

  it('denies an ungranted resource', () => {
    const reader = createRole<typeof statement>({ listings: ['read'] });
    expect(reader.authorize({ bookings: ['read'] }).success).toBe(false);
  });

  it('denies an ungranted action on a granted resource', () => {
    const reader = createRole<typeof statement>({ listings: ['read'] });
    expect(reader.authorize({ listings: ['read', 'delete'] }).success).toBe(false);
  });

  it('exposes the granted permissions', () => {
    const reader = createRole<typeof statement>({ jobs: ['read'] });
    expect(reader.permissions).toEqual({ jobs: ['read'] });
  });
});

describe('checkLocalPermission', () => {
  const admin = createRole<typeof statement>({
    listings: ['create', 'read', 'update', 'delete'],
    jobs: ['read', 'cancel'],
  });
  const roles = { admin };

  it('returns true when the role grants the requested permission', () => {
    expect(checkLocalPermission(roles, 'admin', { listings: ['read'] })).toBe(true);
  });

  it('returns false for an unknown role', () => {
    expect(checkLocalPermission(roles, 'ghost', { listings: ['read'] })).toBe(false);
  });

  it('returns false when the role lacks the requested permission', () => {
    expect(checkLocalPermission(roles, 'admin', { bookings: ['read'] })).toBe(false);
  });
});
