import type { VercelRequest, VercelResponse } from '@vercel/node';
import { extractSessionToken, isValidSessionToken } from '../../lib/dashboardAuth.js';
import { getDailyJournal } from '../../lib/journal.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const token = extractSessionToken(req.headers.cookie);
  const password = process.env.DASHBOARD_PASSWORD;

  if (!password || !isValidSessionToken(token, password)) {
    res.status(401).json({ error: 'Non authentifié' });
    return;
  }

  const requestedDate = Array.isArray(req.query.date) ? req.query.date[0] : req.query.date;
  const date = requestedDate && DATE_PATTERN.test(requestedDate) ? requestedDate : new Date().toLocaleDateString('en-CA');

  const journal = await getDailyJournal(date);
  res.status(200).json(journal);
}
