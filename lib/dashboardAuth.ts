import { createHmac, timingSafeEqual } from 'crypto';

export const DASHBOARD_SESSION_COOKIE = 'dashboard_session';

export function signSession(password: string): string {
  return createHmac('sha256', password).update('dashboard-session').digest('hex');
}

export function isValidSessionToken(token: string | undefined, password: string): boolean {
  if (!token) return false;
  const expected = signSession(password);
  const tokenBuf = Buffer.from(token);
  const expectedBuf = Buffer.from(expected);
  if (tokenBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(tokenBuf, expectedBuf);
}

export function buildSessionCookieHeader(password: string): string {
  const token = signSession(password);
  return `${DASHBOARD_SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000; Path=/`;
}

export function extractSessionToken(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  const match = cookieHeader
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${DASHBOARD_SESSION_COOKIE}=`));
  if (!match) return undefined;
  return match.slice(`${DASHBOARD_SESSION_COOKIE}=`.length);
}
