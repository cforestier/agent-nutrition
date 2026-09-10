import type { VercelRequest, VercelResponse } from '@vercel/node';

const BOT_USERNAME = 'Nutrition_malet_bot';

const DASHBOARD_HTML = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Dashboard</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; }
  #login-form { display: flex; gap: 0.5rem; }
  #login-error { color: #b00020; min-height: 1.2em; }
  #chart-container { margin-top: 1.5rem; }
  a.telegram-link { display: inline-block; margin-top: 1rem; padding: 0.6rem 1rem; background: #229ed9; color: white; text-decoration: none; border-radius: 6px; }
</style>
</head>
<body>
  <h1>Poids</h1>
  <div id="login-view">
    <form id="login-form">
      <input type="password" id="password-input" placeholder="Mot de passe" required />
      <button type="submit">Entrer</button>
    </form>
    <div id="login-error"></div>
  </div>
  <div id="dashboard-view" style="display:none">
    <div id="chart-container"></div>
    <a class="telegram-link" href="https://t.me/${BOT_USERNAME}">Ouvrir le chat Telegram</a>
  </div>

  <script>
    async function loadWeights() {
      const res = await fetch('/api/dashboard/weights');
      if (res.status === 401) {
        document.getElementById('login-view').style.display = '';
        document.getElementById('dashboard-view').style.display = 'none';
        return;
      }
      const weights = await res.json();
      document.getElementById('login-view').style.display = 'none';
      document.getElementById('dashboard-view').style.display = '';
      renderChart(weights);
    }

    function renderChart(weights) {
      const container = document.getElementById('chart-container');
      if (!weights.length) {
        container.textContent = 'Aucune donnée pour l\\'instant.';
        return;
      }
      const width = 600, height = 300, padding = 30;
      const values = weights.map(function (w) { return w.weightKg; });
      const minV = Math.min.apply(null, values);
      const maxV = Math.max.apply(null, values);
      const range = maxV - minV || 1;
      const points = weights.map(function (w, i) {
        const x = padding + (i / (weights.length - 1 || 1)) * (width - 2 * padding);
        const y = height - padding - ((w.weightKg - minV) / range) * (height - 2 * padding);
        return x + ',' + y;
      }).join(' ');
      container.innerHTML = '<svg width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">' +
        '<polyline fill="none" stroke="#229ed9" stroke-width="2" points="' + points + '" /></svg>' +
        '<div>' + weights[0].date + ' \\u2192 ' + weights[weights.length - 1].date + '</div>';
    }

    document.getElementById('login-form').addEventListener('submit', function (e) {
      e.preventDefault();
      const password = document.getElementById('password-input').value;
      fetch('/api/dashboard/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: password }),
      }).then(function (res) {
        if (res.ok) {
          document.getElementById('login-error').textContent = '';
          loadWeights();
        } else {
          document.getElementById('login-error').textContent = 'Mot de passe incorrect.';
        }
      });
    });

    loadWeights();
  </script>
</body>
</html>`;

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.status(405).end();
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(DASHBOARD_HTML);
}
