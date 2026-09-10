import type { VercelRequest, VercelResponse } from '@vercel/node';
import { extractSessionToken, isValidSessionToken } from '../../lib/dashboardAuth.js';
import { getRecentDailyStates } from '../../lib/notificationStore.js';

const MACRO_HISTORY_DAYS = 30;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const token = extractSessionToken(req.headers.cookie);
  const password = process.env.DASHBOARD_PASSWORD;

  if (!password || !isValidSessionToken(token, password)) {
    res.status(401).json({ error: 'Non authentifié' });
    return;
  }

  const macros = await getRecentDailyStates(MACRO_HISTORY_DAYS);
  res.status(200).json(macros);
}
