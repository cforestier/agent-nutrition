import type { VercelRequest, VercelResponse } from '@vercel/node';
import { extractSessionToken, isValidSessionToken } from '../../lib/dashboardAuth.js';
import { getTodaySummary } from '../../lib/todaySummary.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const token = extractSessionToken(req.headers.cookie);
  const password = process.env.DASHBOARD_PASSWORD;

  if (!password || !isValidSessionToken(token, password)) {
    res.status(401).json({ error: 'Non authentifié' });
    return;
  }

  const date = new Date().toLocaleDateString('en-CA');
  const summary = await getTodaySummary(date);
  res.status(200).json(summary);
}
