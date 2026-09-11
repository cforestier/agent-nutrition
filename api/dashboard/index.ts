import type { VercelRequest, VercelResponse } from '@vercel/node';

const BOT_USERNAME = 'Nutrition_malet_bot';

const DASHBOARD_HTML = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link
  href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..700;1,9..144,400..600&family=IBM+Plex+Mono:wght@400;500;600;700&family=IBM+Plex+Sans:wght@400;500;600&display=swap"
  rel="stylesheet"
/>
<style>
  :root {
    --bg: #15110c;
    --bg-elevated: #1e1810;
    --bg-card: #221b12;
    --border: rgba(245, 239, 230, 0.09);
    --text: #f4ecdf;
    --text-muted: #a6957e;
    --amber: #ff8a3d;
    --teal: #5fe3c4;
    --carb: #ffcf5c;
    --fat: #ff7d97;
    --danger: #ff6b6b;
    --success: #7be08a;
    --radius: 20px;
  }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    min-height: 100vh;
    background:
      radial-gradient(60% 45% at 18% -8%, rgba(255, 138, 61, 0.16), transparent 60%),
      radial-gradient(50% 40% at 110% 10%, rgba(95, 227, 196, 0.10), transparent 60%),
      var(--bg);
    color: var(--text);
    font-family: 'IBM Plex Sans', sans-serif;
    -webkit-font-smoothing: antialiased;
  }

  .page {
    max-width: 460px;
    margin: 0 auto;
    padding: 2.5rem 1.25rem 4rem;
  }

  .eyebrow {
    margin: 0 0 0.35rem;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.72rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-muted);
  }

  h1 {
    margin: 0 0 2rem;
    font-family: 'Fraunces', serif;
    font-weight: 500;
    font-size: 2.1rem;
    letter-spacing: -0.01em;
  }

  h2 {
    font-family: 'Fraunces', serif;
    font-weight: 500;
    font-size: 1.15rem;
    margin: 0 0 0.9rem;
    color: var(--text);
  }

  #login-view { animation: rise 0.5s ease both; }

  #login-form {
    display: flex;
    gap: 0.6rem;
  }

  #password-input {
    flex: 1;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 0.75rem 1rem;
    color: var(--text);
    font-family: 'IBM Plex Sans', sans-serif;
    font-size: 0.95rem;
  }
  #password-input:focus { outline: 2px solid var(--amber); outline-offset: 2px; }

  #login-form button {
    background: var(--amber);
    color: #1a1006;
    border: none;
    border-radius: 12px;
    padding: 0.75rem 1.3rem;
    font-weight: 600;
    font-family: 'IBM Plex Sans', sans-serif;
    cursor: pointer;
  }

  #login-error { color: var(--danger); min-height: 1.3em; margin-top: 0.6rem; font-size: 0.88rem; }

  section { margin-bottom: 2.25rem; }

  .rings-section {
    display: flex;
    gap: 1rem;
  }

  .ring-card {
    flex: 1;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.25rem 1rem 1.4rem;
    text-align: center;
    opacity: 0;
    animation: rise 0.6s ease forwards;
  }
  .ring-card:nth-child(2) { animation-delay: 0.08s; }

  .ring-card svg { display: block; margin: 0 auto; }

  .ring-track { stroke: rgba(245, 239, 230, 0.08); fill: none; }
  .ring-progress {
    fill: none;
    stroke-linecap: round;
    transform: rotate(-90deg);
    transform-origin: 60px 60px;
    transition: stroke-dashoffset 0.8s cubic-bezier(0.22, 1, 0.36, 1), stroke 0.3s ease;
  }
  #calories-ring-progress { stroke: var(--amber); filter: drop-shadow(0 0 6px rgba(255, 138, 61, 0.55)); }
  #protein-ring-progress { stroke: var(--teal); filter: drop-shadow(0 0 6px rgba(95, 227, 196, 0.5)); }
  .ring-progress.over { stroke: var(--danger) !important; filter: none !important; }

  .ring-center-value {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 1.5rem;
    font-weight: 600;
  }
  .ring-unit { font-size: 0.7rem; color: var(--text-muted); display: block; margin-top: -2px; }
  .ring-label { margin: 0.7rem 0 0.15rem; font-weight: 600; font-size: 0.92rem; }
  .ring-sub { margin: 0; font-family: 'IBM Plex Mono', monospace; font-size: 0.76rem; color: var(--text-muted); }

  .macro-bar {
    display: flex;
    height: 10px;
    border-radius: 999px;
    overflow: hidden;
    background: rgba(245, 239, 230, 0.06);
    margin-bottom: 1rem;
  }
  .macro-bar-segment { height: 100%; }
  .macro-bar-segment.protein { background: var(--teal); }
  .macro-bar-segment.carbs { background: var(--carb); }
  .macro-bar-segment.fat { background: var(--fat); }

  .macro-cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.6rem; }
  .macro-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-left: 3px solid transparent;
    border-radius: 14px;
    padding: 0.7rem 0.6rem;
  }
  .macro-card.protein { border-left-color: var(--teal); }
  .macro-card.carbs { border-left-color: var(--carb); }
  .macro-card.fat { border-left-color: var(--fat); }
  .macro-card-label { font-size: 0.72rem; color: var(--text-muted); margin: 0 0 0.15rem; }
  .macro-card-value { font-family: 'IBM Plex Mono', monospace; font-size: 1.05rem; font-weight: 600; }

  .deltas-section { display: flex; gap: 0.6rem; }
  .delta-chip {
    flex: 1;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 0.75rem 0.85rem;
  }
  .delta-chip-label { font-size: 0.72rem; color: var(--text-muted); margin: 0 0 0.2rem; }
  .delta-chip-value { font-family: 'IBM Plex Mono', monospace; font-size: 1.2rem; font-weight: 600; }
  .delta-chip-value.good { color: var(--success); }
  .delta-chip-value.warn { color: var(--danger); }

  #chart-container, #protein-chart, #carbs-chart, #fat-chart { margin-top: 0.5rem; }
  .macro-chart { margin-top: 1.75rem; }
  .macro-chart h2 { font-size: 1rem; }
  .chart-wrap { position: relative; }
  .chart-wrap svg { display: block; cursor: crosshair; width: 100%; height: auto; }
  .chart-range { font-family: 'IBM Plex Mono', monospace; font-size: 0.72rem; color: var(--text-muted); margin-top: 0.3rem; }
  .hover-dot { pointer-events: none; }
  .chart-tooltip {
    position: absolute;
    display: none;
    background: #2a2015;
    border: 1px solid var(--border);
    color: var(--text);
    padding: 3px 8px;
    border-radius: 6px;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.75rem;
    white-space: nowrap;
    pointer-events: none;
    transform: translate(-50%, -130%);
  }

  a.telegram-link {
    display: block;
    text-align: center;
    margin-top: 0.5rem;
    padding: 0.85rem 1rem;
    background: linear-gradient(135deg, #37b7e8, #229ed9);
    color: white;
    text-decoration: none;
    font-weight: 600;
    border-radius: 14px;
    box-shadow: 0 8px 20px rgba(34, 158, 217, 0.25);
  }

  @keyframes rise {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: translateY(0); }
  }
</style>
</head>
<body>
  <div class="page">
    <p class="eyebrow" id="today-eyebrow">Aujourd'hui</p>
    <h1>Bonjour, Raphaël</h1>

    <div id="login-view">
      <form id="login-form">
        <input type="password" id="password-input" placeholder="Mot de passe" required />
        <button type="submit">Entrer</button>
      </form>
      <div id="login-error"></div>
    </div>

    <div id="dashboard-view" hidden>
      <section class="rings-section">
        <div class="ring-card">
          <svg width="120" height="120" viewBox="0 0 120 120">
            <circle class="ring-track" cx="60" cy="60" r="54" stroke-width="10" />
            <circle id="calories-ring-progress" class="ring-progress" cx="60" cy="60" r="54" stroke-width="10" />
          </svg>
          <span class="ring-center-value" id="calories-ring-value">--</span>
          <span class="ring-unit">kcal</span>
          <p class="ring-label">Calories</p>
          <p class="ring-sub" id="calories-ring-sub">-- / -- kcal</p>
        </div>
        <div class="ring-card">
          <svg width="120" height="120" viewBox="0 0 120 120">
            <circle class="ring-track" cx="60" cy="60" r="54" stroke-width="10" />
            <circle id="protein-ring-progress" class="ring-progress" cx="60" cy="60" r="54" stroke-width="10" />
          </svg>
          <span class="ring-center-value" id="protein-ring-value">--</span>
          <span class="ring-unit">g protéines</span>
          <p class="ring-label">Protéines</p>
          <p class="ring-sub" id="protein-ring-sub">-- / -- g</p>
        </div>
      </section>

      <section class="macros-breakdown-section">
        <h2>Répartition du jour</h2>
        <div class="macro-bar">
          <div class="macro-bar-segment protein" id="macro-bar-protein"></div>
          <div class="macro-bar-segment carbs" id="macro-bar-carbs"></div>
          <div class="macro-bar-segment fat" id="macro-bar-fat"></div>
        </div>
        <div class="macro-cards">
          <div class="macro-card protein">
            <p class="macro-card-label">Protéines</p>
            <p class="macro-card-value" id="macro-card-protein-value">-- g</p>
          </div>
          <div class="macro-card carbs">
            <p class="macro-card-label">Glucides</p>
            <p class="macro-card-value" id="macro-card-carbs-value">-- g</p>
          </div>
          <div class="macro-card fat">
            <p class="macro-card-label">Lipides</p>
            <p class="macro-card-value" id="macro-card-fat-value">-- g</p>
          </div>
        </div>
      </section>

      <section class="deltas-section">
        <div class="delta-chip">
          <p class="delta-chip-label">Calories restantes</p>
          <p class="delta-chip-value" id="kcal-delta-value">--</p>
        </div>
        <div class="delta-chip">
          <p class="delta-chip-label">Protéines vs cible</p>
          <p class="delta-chip-value" id="protein-delta-value">--</p>
        </div>
      </section>

      <section class="history-section">
        <h2>Poids</h2>
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
      </section>

      <a class="telegram-link" href="https://t.me/${BOT_USERNAME}">Ouvrir le chat Telegram</a>
    </div>
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
        return { x: x, y: y, date: p.date, value: p.value };
      });
      const pointsAttr = coords.map(function (c) { return c.x + ',' + c.y; }).join(' ');

      container.innerHTML =
        '<div class="chart-wrap">' +
          '<svg width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '">' +
            '<polyline fill="none" stroke="var(--amber)" stroke-width="2.5" points="' + pointsAttr + '" />' +
            '<circle class="hover-dot" r="4.5" fill="var(--amber)" style="display:none" />' +
          '</svg>' +
          '<div class="chart-tooltip"></div>' +
        '</div>' +
        '<div class="chart-range">' + points[0].date + ' \\u2192 ' + points[points.length - 1].date + '</div>';

      const svg = container.querySelector('svg');
      const dot = container.querySelector('.hover-dot');
      const tooltip = container.querySelector('.chart-tooltip');

      svg.addEventListener('mousemove', function (e) {
        const rect = svg.getBoundingClientRect();
        const mouseX = (e.clientX - rect.left) * (width / rect.width);

        let nearest = coords[0];
        let nearestDist = Math.abs(coords[0].x - mouseX);
        for (let i = 1; i < coords.length; i++) {
          const dist = Math.abs(coords[i].x - mouseX);
          if (dist < nearestDist) {
            nearest = coords[i];
            nearestDist = dist;
          }
        }

        dot.setAttribute('cx', nearest.x);
        dot.setAttribute('cy', nearest.y);
        dot.style.display = '';

        tooltip.textContent = nearest.date + ' : ' + nearest.value;
        tooltip.style.left = (nearest.x / width) * rect.width + 'px';
        tooltip.style.top = (nearest.y / height) * rect.height + 'px';
        tooltip.style.display = 'block';
      });

      svg.addEventListener('mouseleave', function () {
        dot.style.display = 'none';
        tooltip.style.display = 'none';
      });
    }

    function showDashboard() {
      document.getElementById('login-view').style.display = 'none';
      document.getElementById('dashboard-view').hidden = false;
    }

    function showLogin() {
      document.getElementById('login-view').style.display = '';
      document.getElementById('dashboard-view').hidden = true;
    }

    const RING_CIRCUMFERENCE = 2 * Math.PI * 54;

    function setRing(progressId, fraction) {
      const el = document.getElementById(progressId);
      const clamped = Math.max(0, Math.min(1, fraction));
      el.style.strokeDasharray = RING_CIRCUMFERENCE.toFixed(2);
      el.style.strokeDashoffset = (RING_CIRCUMFERENCE * (1 - clamped)).toFixed(2);
      el.classList.toggle('over', fraction > 1);
    }

    function renderToday(summary) {
      const dateLabel = new Date(summary.date + 'T00:00:00').toLocaleDateString('fr-FR', {
        weekday: 'long', day: 'numeric', month: 'long',
      });
      document.getElementById('today-eyebrow').textContent = dateLabel;

      if (summary.targetKcal !== null) {
        setRing('calories-ring-progress', summary.totalKcal / summary.targetKcal);
        document.getElementById('calories-ring-value').textContent = Math.round(summary.totalKcal);
        document.getElementById('calories-ring-sub').textContent =
          Math.round(summary.totalKcal) + ' / ' + Math.round(summary.targetKcal) + ' kcal';
        const kcalDelta = summary.totalKcal - summary.targetKcal;
        const kcalEl = document.getElementById('kcal-delta-value');
        kcalEl.textContent = (kcalDelta > 0 ? '+' : '') + Math.round(kcalDelta) + ' kcal';
        kcalEl.className = 'delta-chip-value ' + (kcalDelta > 0 ? 'warn' : 'good');
      } else {
        document.getElementById('calories-ring-value').textContent = Math.round(summary.totalKcal);
        document.getElementById('calories-ring-sub').textContent = Math.round(summary.totalKcal) + ' kcal';
        document.getElementById('kcal-delta-value').textContent = 'pas de cible';
      }

      if (summary.proteinTargetMinG !== null) {
        setRing('protein-ring-progress', summary.proteinG / summary.proteinTargetMinG);
        document.getElementById('protein-ring-value').textContent = Math.round(summary.proteinG);
        document.getElementById('protein-ring-sub').textContent =
          Math.round(summary.proteinG) + ' / ' + Math.round(summary.proteinTargetMinG) + '-' + Math.round(summary.proteinTargetMaxG) + ' g';
        const proteinDelta = summary.proteinG - summary.proteinTargetMinG;
        const proteinEl = document.getElementById('protein-delta-value');
        proteinEl.textContent = (proteinDelta > 0 ? '+' : '') + Math.round(proteinDelta) + ' g';
        proteinEl.className = 'delta-chip-value ' + (proteinDelta < 0 ? 'warn' : 'good');
      } else {
        document.getElementById('protein-ring-value').textContent = Math.round(summary.proteinG);
        document.getElementById('protein-ring-sub').textContent = Math.round(summary.proteinG) + ' g';
        document.getElementById('protein-delta-value').textContent = 'pas de cible';
      }

      const macroKcal = summary.proteinG * 4 + summary.carbsG * 4 + summary.fatG * 9;
      const pct = function (grams, kcalPerG) {
        return macroKcal > 0 ? ((grams * kcalPerG) / macroKcal) * 100 : 0;
      };
      document.getElementById('macro-bar-protein').style.width = pct(summary.proteinG, 4).toFixed(1) + '%';
      document.getElementById('macro-bar-carbs').style.width = pct(summary.carbsG, 4).toFixed(1) + '%';
      document.getElementById('macro-bar-fat').style.width = pct(summary.fatG, 9).toFixed(1) + '%';
      document.getElementById('macro-card-protein-value').textContent = Math.round(summary.proteinG) + ' g';
      document.getElementById('macro-card-carbs-value').textContent = Math.round(summary.carbsG) + ' g';
      document.getElementById('macro-card-fat-value').textContent = Math.round(summary.fatG) + ' g';
    }

    async function loadToday() {
      const res = await fetch('/api/dashboard/today');
      if (res.status === 401) {
        showLogin();
        return;
      }
      const summary = await res.json();
      showDashboard();
      renderToday(summary);
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
      loadToday();
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
