import type { VercelRequest, VercelResponse } from '@vercel/node';
import { buildSessionCookieHeader } from '../../lib/dashboardAuth.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  const { password } = (req.body ?? {}) as { password?: string };
  const expected = process.env.DASHBOARD_PASSWORD;

  if (!expected || password !== expected) {
    res.status(401).json({ error: 'Mot de passe incorrect' });
    return;
  }

  res.setHeader('Set-Cookie', buildSessionCookieHeader(expected));
  res.status(200).json({ ok: true });
}
