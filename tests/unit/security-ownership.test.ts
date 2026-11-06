import { describe, expect, it } from 'vitest';
import { ownerEmail, ownerOr, escapeRegex } from '../../apps/api/src/util';
import { notificationOwnerMatch, ownerMatch } from '../../packages/core/src/domain/customer360/privacy';
import { isReturnOwner } from '../../packages/core/src/domain/aftersales/evidence';

const unverified = { id: 'u1', email: 'victim@example.com', emailVerified: false };
const verified = { ...unverified, emailVerified: true };

describe('ownership keys: an unverified email must not claim guest records', () => {
  it('ownerEmail is only returned for verified accounts', () => {
    expect(ownerEmail(unverified)).toBeUndefined();
    expect(ownerEmail(verified)).toBe('victim@example.com');
    expect(ownerEmail(undefined)).toBeUndefined();
  });

  it('ownerOr selects by id only until the email is verified', () => {
    expect(ownerOr(unverified)).toEqual([{ userId: 'u1' }]);
    expect(ownerOr(verified)).toEqual([{ userId: 'u1' }, { email: 'victim@example.com' }]);
  });

  it('privacy export / anonymization ownership filters follow the same rule', () => {
    expect(ownerMatch('u1', 'victim@example.com', false)).toEqual({ $or: [{ userId: 'u1' }] });
    expect(ownerMatch('u1', 'victim@example.com', true)).toEqual({ $or: [{ userId: 'u1' }, { email: 'victim@example.com' }] });
    expect(notificationOwnerMatch('u1', 'victim@example.com', false)).toEqual({ $or: [{ userId: 'u1' }] });
    expect(notificationOwnerMatch('u1', 'victim@example.com', true)).toEqual({ $or: [{ userId: 'u1' }, { to: 'victim@example.com' }] });
  });

  it('isReturnOwner denies an unverified account (routes pass no email) but allows the owner id', () => {
    const rec = { userId: 'owner-1', email: 'victim@example.com' };
    expect(isReturnOwner(rec, { userId: 'attacker', email: ownerEmail(unverified) })).toBe(false);
    expect(isReturnOwner(rec, { userId: 'attacker', email: ownerEmail(verified) })).toBe(true); // verified email owner (documented contract)
    expect(isReturnOwner(rec, { userId: 'owner-1', email: undefined })).toBe(true);
  });
});

describe('regex escaping used for staff search', () => {
  it('neutralises operators so user input cannot widen a query', () => {
    const rx = new RegExp(`^${escapeRegex('.*')}`);
    expect(rx.test('abc')).toBe(false);
    expect(rx.test('.*x')).toBe(true);
    expect(() => new RegExp(escapeRegex('(a+)+$['))).not.toThrow();
  });
});
