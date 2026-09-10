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
  .macro-chart { margin-top: 1.5rem; }
  .macro-chart h2 { font-size: 1rem; margin-bottom: 0.25rem; }
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

    <div class="macro-chart">
      <h2>Protéines (g)</h2>
      <div id="protein-chart"></div>
    </div>
    <div class="macro-chart">
      <h2>Glucides (g)</h2>
      <div id="carbs-chart"></div>
    </div>
    <div class="macro-chart">
      <h2>Lipides (g)</h2>
      <div id="fat-chart"></div>
    </div>

    <a class="telegram-link" href="https://t.me/${BOT_USERNAME}">Ouvrir le chat Telegram</a>
  </div>

  <script>
    function renderLineChart(containerId, points) {
      const container = document.getElementById(containerId);
      if (!points.length) {
        container.textContent = 'Aucune donnée pour l\\'instant.';
        return;
      }
      const width = 600, height = 200, padding = 30;
      const values = points.map(function (p) { return p.value; });
      const minV = Math.min.apply(null, values);
      const maxV = Math.max.apply(null, values);
      const range = maxV - minV || 1;
      const coords = points.map(function (p, i) {
        const x = padding + (i / (points.length - 1 || 1)) * (width - 2 * padding);
        const y = height - padding - ((p.value - minV) / range) * (height - 2 * padding);
        return x + ',' + y;
      }).join(' ');
      container.innerHTML = '<svg width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">' +
        '<polyline fill="none" stroke="#229ed9" stroke-width="2" points="' + coords + '" /></svg>' +
        '<div>' + points[0].date + ' \\u2192 ' + points[points.length - 1].date + '</div>';
    }

    function showDashboard() {
      document.getElementById('login-view').style.display = 'none';
      document.getElementById('dashboard-view').style.display = '';
    }

    function showLogin() {
      document.getElementById('login-view').style.display = '';
      document.getElementById('dashboard-view').style.display = 'none';
    }

    async function loadWeights() {
      const res = await fetch('/api/dashboard/weights');
      if (res.status === 401) {
        showLogin();
        return;
      }
      const weights = await res.json();
      showDashboard();
      renderLineChart('chart-container', weights.map(function (w) { return { date: w.date, value: w.weightKg }; }));
    }

    async function loadMacros() {
      const res = await fetch('/api/dashboard/macros');
      if (res.status === 401) {
        showLogin();
        return;
      }
      const macros = await res.json();
      showDashboard();
      renderLineChart('protein-chart', macros.map(function (m) { return { date: m.date, value: m.proteinG }; }));
      renderLineChart('carbs-chart', macros.map(function (m) { return { date: m.date, value: m.carbsG }; }));
      renderLineChart('fat-chart', macros.map(function (m) { return { date: m.date, value: m.fatG }; }));
    }

    function loadDashboard() {
      loadWeights();
      loadMacros();
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
          loadDashboard();
        } else {
          document.getElementById('login-error').textContent = 'Mot de passe incorrect.';
        }
      });
    });

    loadDashboard();
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
