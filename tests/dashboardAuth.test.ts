import { describe, it, expect } from 'vitest';
import {
  DASHBOARD_SESSION_COOKIE,
  signSession,
  isValidSessionToken,
  buildSessionCookieHeader,
  extractSessionToken,
} from '../lib/dashboardAuth.js';

describe('signSession', () => {
  it('is deterministic for the same password', () => {
    expect(signSession('correct-horse')).toBe(signSession('correct-horse'));
  });

  it('differs for different passwords', () => {
    expect(signSession('correct-horse')).not.toBe(signSession('other-password'));
  });
});

describe('isValidSessionToken', () => {
  it('accepts a token produced by signSession for the same password', () => {
    const token = signSession('correct-horse');
    expect(isValidSessionToken(token, 'correct-horse')).toBe(true);
  });

  it('rejects a token signed with a different password', () => {
    const token = signSession('correct-horse');
    expect(isValidSessionToken(token, 'wrong-password')).toBe(false);
  });

  it('rejects an undefined token', () => {
    expect(isValidSessionToken(undefined, 'correct-horse')).toBe(false);
  });

  it('rejects a tampered token', () => {
    const token = signSession('correct-horse');
    const tampered = token.slice(0, -1) + (token.at(-1) === 'a' ? 'b' : 'a');
    expect(isValidSessionToken(tampered, 'correct-horse')).toBe(false);
  });
});

describe('buildSessionCookieHeader', () => {
  it('builds a cookie header with the expected name, token and attributes', () => {
    const header = buildSessionCookieHeader('correct-horse');
    const expectedToken = signSession('correct-horse');
    expect(header).toContain(`${DASHBOARD_SESSION_COOKIE}=${expectedToken}`);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Max-Age=2592000');
    expect(header).toContain('Path=/');
  });
});

describe('extractSessionToken', () => {
  it('returns undefined when there is no cookie header', () => {
    expect(extractSessionToken(undefined)).toBeUndefined();
  });

  it('extracts the token when it is the only cookie', () => {
    expect(extractSessionToken('dashboard_session=abc123')).toBe('abc123');
  });

  it('extracts the token when other cookies are present', () => {
    expect(extractSessionToken('foo=bar; dashboard_session=abc123; baz=qux')).toBe('abc123');
  });

  it('returns undefined when the cookie is not present among others', () => {
    expect(extractSessionToken('foo=bar; baz=qux')).toBeUndefined();
  });
});
