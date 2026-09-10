import type { VercelRequest, VercelResponse } from '@vercel/node';
import { extractSessionToken, isValidSessionToken } from '../../lib/dashboardAuth.js';
import { getAllWeights } from '../../lib/weight.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const token = extractSessionToken(req.headers.cookie);
  const password = process.env.DASHBOARD_PASSWORD;

  if (!password || !isValidSessionToken(token, password)) {
    res.status(401).json({ error: 'Non authentifié' });
    return;
  }

  const weights = await getAllWeights();
  res.status(200).json(weights);
}
