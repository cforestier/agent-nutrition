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
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 0.85rem;
  }

  .ring-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.1rem 0.6rem 1.2rem;
    text-align: center;
    opacity: 0;
    animation: rise 0.6s ease forwards;
  }
  .ring-card:nth-child(2) { animation-delay: 0.06s; }
  .ring-card:nth-child(3) { animation-delay: 0.12s; }
  .ring-card:nth-child(4) { animation-delay: 0.18s; }

  .ring-card svg { display: block; margin: 0 auto; width: 96px; height: 96px; }

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
  #carbs-ring-progress { stroke: var(--carb); filter: drop-shadow(0 0 6px rgba(255, 207, 92, 0.5)); }
  #fat-ring-progress { stroke: var(--fat); filter: drop-shadow(0 0 6px rgba(255, 125, 151, 0.5)); }
  .ring-progress.over { stroke: var(--danger) !important; filter: none !important; }

  .ring-center-value {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 1.25rem;
    font-weight: 600;
  }
  .ring-unit { font-size: 0.66rem; color: var(--text-muted); display: block; margin-top: -2px; }
  .ring-label { margin: 0.6rem 0 0.1rem; font-weight: 600; font-size: 0.86rem; }
  .ring-sub { margin: 0; font-family: 'IBM Plex Mono', monospace; font-size: 0.7rem; color: var(--text-muted); }

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

  .journal-controls {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.6rem;
    margin-bottom: 0.7rem;
  }
  .journal-controls > button {
    background: var(--bg-card);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: 10px;
    width: 2.2rem;
    height: 2.2rem;
    font-size: 1rem;
    cursor: pointer;
    flex-shrink: 0;
  }
  .journal-controls > button:disabled { opacity: 0.35; cursor: default; }

  .journal-date-picker { position: relative; display: flex; align-items: center; gap: 0.4rem; }
  .journal-date-picker input[type='date'] {
    background: var(--bg-card);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: 10px;
    padding: 0.5rem 0.6rem;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.8rem;
    color-scheme: dark;
  }
  .journal-date-picker > button {
    background: var(--bg-card);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: 10px;
    width: 2.2rem;
    height: 2.2rem;
    font-size: 1rem;
    cursor: pointer;
  }

  .journal-calendar {
    position: absolute;
    top: calc(100% + 0.5rem);
    left: 50%;
    transform: translateX(-50%);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 0.85rem;
    z-index: 20;
    box-shadow: 0 12px 30px rgba(0, 0, 0, 0.35);
    width: 260px;
  }
  .calendar-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.6rem; }
  .calendar-header button { background: none; border: none; color: var(--text); font-size: 1rem; cursor: pointer; width: 1.8rem; height: 1.8rem; }
  .calendar-header button:disabled { opacity: 0.3; cursor: default; }
  .calendar-header span { font-family: 'IBM Plex Mono', monospace; font-size: 0.78rem; text-transform: capitalize; }
  .calendar-weekdays, .calendar-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 0.2rem; }
  .calendar-weekdays span { text-align: center; font-size: 0.65rem; color: var(--text-muted); font-family: 'IBM Plex Mono', monospace; }
  .calendar-cell {
    background: none;
    border: none;
    color: var(--text);
    border-radius: 8px;
    aspect-ratio: 1;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.76rem;
    cursor: pointer;
  }
  .calendar-cell.empty { visibility: hidden; cursor: default; }
  .calendar-cell:hover:not(:disabled):not(.empty) { background: rgba(245, 239, 230, 0.08); }
  .calendar-cell.today { border: 1px solid var(--amber); }
  .calendar-cell.selected { background: var(--amber); color: #1a1006; font-weight: 600; }
  .calendar-cell.future, .calendar-cell:disabled { opacity: 0.3; cursor: default; }

  .journal-date-label {
    text-align: center;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.82rem;
    color: var(--text-muted);
    text-transform: capitalize;
    margin: 0 0 0.9rem;
  }

  .recap-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.5rem; margin-bottom: 1.1rem; }
  .recap-stat { background: var(--bg-card); border: 1px solid var(--border); border-radius: 12px; padding: 0.6rem 0.5rem; text-align: center; }
  .recap-label { display: block; font-size: 0.68rem; color: var(--text-muted); margin-bottom: 0.2rem; }
  .recap-value { display: block; font-family: 'IBM Plex Mono', monospace; font-size: 0.86rem; font-weight: 600; }

  .log-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
  .log-table th {
    text-align: left;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.64rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-muted);
    padding: 0 0.5rem 0.4rem;
    border-bottom: 1px solid var(--border);
  }
  .log-table td { padding: 0.5rem; border-bottom: 1px solid var(--border); vertical-align: top; }
  .log-table td.log-table-kcal { text-align: right; font-family: 'IBM Plex Mono', monospace; white-space: nowrap; }
  .log-table tbody tr:last-child td { border-bottom: none; }
  .journal-extras { margin-top: 0.7rem; font-family: 'IBM Plex Mono', monospace; font-size: 0.74rem; color: var(--text-muted); }
  .journal-empty { color: var(--text-muted); font-size: 0.86rem; }

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
        <div class="ring-card">
          <svg width="120" height="120" viewBox="0 0 120 120">
            <circle class="ring-track" cx="60" cy="60" r="54" stroke-width="10" />
            <circle id="carbs-ring-progress" class="ring-progress" cx="60" cy="60" r="54" stroke-width="10" />
          </svg>
          <span class="ring-center-value" id="carbs-ring-value">--</span>
          <span class="ring-unit">g glucides</span>
          <p class="ring-label">Glucides</p>
          <p class="ring-sub" id="carbs-ring-sub">-- / -- g</p>
        </div>
        <div class="ring-card">
          <svg width="120" height="120" viewBox="0 0 120 120">
            <circle class="ring-track" cx="60" cy="60" r="54" stroke-width="10" />
            <circle id="fat-ring-progress" class="ring-progress" cx="60" cy="60" r="54" stroke-width="10" />
          </svg>
          <span class="ring-center-value" id="fat-ring-value">--</span>
          <span class="ring-unit">g lipides</span>
          <p class="ring-label">Lipides</p>
          <p class="ring-sub" id="fat-ring-sub">-- / -- g</p>
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

      <section class="journal-section">
        <h2>Journal</h2>
        <div class="journal-controls">
          <button type="button" id="journal-prev" aria-label="Jour précédent">←</button>
          <div class="journal-date-picker">
            <input type="date" id="journal-date-input" />
            <button type="button" id="journal-calendar-toggle" aria-label="Ouvrir le calendrier">📅</button>
            <div id="journal-calendar" class="journal-calendar" hidden>
              <div class="calendar-header">
                <button type="button" id="calendar-prev-month" aria-label="Mois précédent">‹</button>
                <span id="calendar-month-label">--</span>
                <button type="button" id="calendar-next-month" aria-label="Mois suivant">›</button>
              </div>
              <div class="calendar-weekdays">
                <span>L</span><span>M</span><span>M</span><span>J</span><span>V</span><span>S</span><span>D</span>
              </div>
              <div class="calendar-grid" id="calendar-grid"></div>
            </div>
          </div>
          <button type="button" id="journal-next" aria-label="Jour suivant">→</button>
        </div>
        <p class="journal-date-label" id="journal-date-label">--</p>
        <div id="journal-recap"></div>
        <div id="journal-content"></div>
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

    function renderSingleTargetRing(prefix, value, target, unit) {
      const valueEl = document.getElementById(prefix + '-ring-value');
      const subEl = document.getElementById(prefix + '-ring-sub');

      if (target !== null) {
        setRing(prefix + '-ring-progress', value / target);
        valueEl.textContent = Math.round(value);
        subEl.textContent = Math.round(value) + ' / ' + Math.round(target) + ' ' + unit;
      } else {
        setRing(prefix + '-ring-progress', 0);
        valueEl.textContent = Math.round(value);
        subEl.textContent = Math.round(value) + ' ' + unit;
      }
    }

    function renderToday(summary) {
      const dateLabel = new Date(summary.date + 'T00:00:00').toLocaleDateString('fr-FR', {
        weekday: 'long', day: 'numeric', month: 'long',
      });
      document.getElementById('today-eyebrow').textContent = dateLabel;

      renderSingleTargetRing('calories', summary.totalKcal, summary.targetKcal, 'kcal');
      renderSingleTargetRing('carbs', summary.carbsG, summary.carbsTargetG, 'g');
      renderSingleTargetRing('fat', summary.fatG, summary.fatTargetG, 'g');

      if (summary.targetKcal !== null) {
        const kcalDelta = summary.totalKcal - summary.targetKcal;
        const kcalEl = document.getElementById('kcal-delta-value');
        kcalEl.textContent = (kcalDelta > 0 ? '+' : '') + Math.round(kcalDelta) + ' kcal';
        kcalEl.className = 'delta-chip-value ' + (kcalDelta > 0 ? 'warn' : 'good');
      } else {
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
        setRing('protein-ring-progress', 0);
        document.getElementById('protein-ring-value').textContent = Math.round(summary.proteinG);
        document.getElementById('protein-ring-sub').textContent = Math.round(summary.proteinG) + ' g';
        document.getElementById('protein-delta-value').textContent = 'pas de cible';
      }
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

    var SPORT_LABELS = { cycling: 'Vélo', running: 'Course à pied', strength: 'Musculation', crossfit: 'Crossfit', other: 'Autre' };
    var INTENSITY_LABELS = { light: 'léger', moderate: 'modéré', sustained: 'soutenu', vigorous: 'vigoureux', maximal: 'maximal' };

    function todayIso() {
      return new Date().toLocaleDateString('en-CA');
    }

    function addDaysIso(dateStr, delta) {
      const date = new Date(dateStr + 'T00:00:00Z');
      date.setUTCDate(date.getUTCDate() + delta);
      return date.toISOString().slice(0, 10);
    }

    function pad2(n) {
      return n < 10 ? '0' + n : '' + n;
    }

    function isoDate(year, monthIndex, day) {
      return year + '-' + pad2(monthIndex + 1) + '-' + pad2(day);
    }

    var journalDate = todayIso();
    var calendarViewYear = Number(journalDate.slice(0, 4));
    var calendarViewMonth = Number(journalDate.slice(5, 7)) - 1;

    function formatStat(value, target, unit) {
      const v = Math.round(value);
      if (target === null || target === undefined) return v + ' ' + unit;
      return v + ' / ' + Math.round(target) + ' ' + unit;
    }

    function renderDayRecap(summary) {
      document.getElementById('journal-recap').innerHTML =
        '<div class="recap-grid">' +
          '<div class="recap-stat"><span class="recap-label">Calories</span><span class="recap-value">' + formatStat(summary.totalKcal, summary.targetKcal, 'kcal') + '</span></div>' +
          '<div class="recap-stat"><span class="recap-label">Protéines</span><span class="recap-value">' + formatStat(summary.proteinG, summary.proteinTargetMinG, 'g') + '</span></div>' +
          '<div class="recap-stat"><span class="recap-label">Glucides</span><span class="recap-value">' + formatStat(summary.carbsG, summary.carbsTargetG, 'g') + '</span></div>' +
          '<div class="recap-stat"><span class="recap-label">Lipides</span><span class="recap-value">' + formatStat(summary.fatG, summary.fatTargetG, 'g') + '</span></div>' +
        '</div>';
    }

    async function loadDayRecap() {
      const res = await fetch('/api/dashboard/today?date=' + journalDate);
      if (res.status === 401) {
        showLogin();
        return;
      }
      const summary = await res.json();
      showDashboard();
      renderDayRecap(summary);
    }

    function renderJournal(journal) {
      const rows = [];

      journal.meals.forEach(function (meal) {
        rows.push({ time: meal.time, type: 'Repas', detail: meal.rawDescription, kcal: meal.kcalMid });
      });

      journal.activities.forEach(function (activity) {
        const sportLabel = SPORT_LABELS[activity.sportType] || activity.sportType;
        var detailParts = [sportLabel + ' — ' + activity.description];
        if (activity.durationMinutes && activity.intensity) {
          detailParts.push(Math.round(activity.durationMinutes) + ' min, intensité ' + (INTENSITY_LABELS[activity.intensity] || activity.intensity));
        }
        detailParts.push(activity.estimationMethod === 'met_estimate' ? 'estimé' : 'montre/tracker');
        detailParts.push(activity.relationToPlan === 'replaces' ? 'remplace le prévu' : 'en plus du prévu');
        rows.push({ time: activity.time, type: 'Activité', detail: detailParts.join(' · '), kcal: activity.reportedCalories });
      });

      rows.sort(function (a, b) {
        return a.time < b.time ? -1 : a.time > b.time ? 1 : 0;
      });

      var extras = [];
      if (journal.weightKg !== null) extras.push('Poids : ' + journal.weightKg + ' kg');
      if (journal.sleepQuality !== null) extras.push('Sommeil : ' + journal.sleepQuality);

      if (!rows.length && !extras.length) {
        document.getElementById('journal-content').innerHTML = '<p class="journal-empty">Rien de loggé ce jour-là.</p>';
        return;
      }

      const tableHtml = rows.length
        ? '<table class="log-table"><thead><tr><th>Heure</th><th>Type</th><th>Détail</th><th>Kcal</th></tr></thead><tbody>' +
          rows.map(function (r) {
            return '<tr><td>' + r.time + '</td><td>' + r.type + '</td><td>' + r.detail + '</td><td class="log-table-kcal">' + Math.round(r.kcal) + '</td></tr>';
          }).join('') +
          '</tbody></table>'
        : '<p class="journal-empty">Aucun repas ni activité ce jour-là.</p>';

      const extrasHtml = extras.length ? '<p class="journal-extras">' + extras.join(' · ') + '</p>' : '';

      document.getElementById('journal-content').innerHTML = tableHtml + extrasHtml;
    }

    async function loadJournal() {
      const res = await fetch('/api/dashboard/journal?date=' + journalDate);
      if (res.status === 401) {
        showLogin();
        return;
      }
      const journal = await res.json();
      showDashboard();
      renderJournal(journal);
    }

    function updateDateLabel() {
      const dateLabel = new Date(journalDate + 'T00:00:00').toLocaleDateString('fr-FR', {
        weekday: 'long', day: 'numeric', month: 'long',
      });
      document.getElementById('journal-date-label').textContent = dateLabel;
      document.getElementById('journal-next').disabled = journalDate >= todayIso();
    }

    function syncDateInput() {
      const input = document.getElementById('journal-date-input');
      input.value = journalDate;
      input.max = todayIso();
    }

    function closeCalendar() {
      document.getElementById('journal-calendar').hidden = true;
    }

    function renderCalendar() {
      const monthLabel = new Date(calendarViewYear, calendarViewMonth, 1).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
      document.getElementById('calendar-month-label').textContent = monthLabel;

      const firstWeekday = (new Date(calendarViewYear, calendarViewMonth, 1).getDay() + 6) % 7;
      const totalDays = new Date(calendarViewYear, calendarViewMonth + 1, 0).getDate();
      const today = todayIso();

      var cells = '';
      for (let i = 0; i < firstWeekday; i++) {
        cells += '<span class="calendar-cell empty"></span>';
      }
      for (let d = 1; d <= totalDays; d++) {
        const iso = isoDate(calendarViewYear, calendarViewMonth, d);
        var classes = 'calendar-cell';
        if (iso === journalDate) classes += ' selected';
        if (iso === today) classes += ' today';
        const isFuture = iso > today;
        if (isFuture) classes += ' future';
        cells += '<button type="button" class="' + classes + '" data-date="' + iso + '"' + (isFuture ? ' disabled' : '') + '>' + d + '</button>';
      }
      document.getElementById('calendar-grid').innerHTML = cells;

      const now = new Date();
      document.getElementById('calendar-next-month').disabled =
        calendarViewYear > now.getFullYear() || (calendarViewYear === now.getFullYear() && calendarViewMonth >= now.getMonth());
    }

    function loadDay() {
      updateDateLabel();
      syncDateInput();
      loadJournal();
      loadDayRecap();
    }

    document.getElementById('journal-prev').addEventListener('click', function () {
      journalDate = addDaysIso(journalDate, -1);
      loadDay();
    });

    document.getElementById('journal-next').addEventListener('click', function () {
      if (journalDate >= todayIso()) return;
      journalDate = addDaysIso(journalDate, 1);
      loadDay();
    });

    document.getElementById('journal-date-input').addEventListener('change', function (e) {
      if (!e.target.value) return;
      journalDate = e.target.value;
      closeCalendar();
      loadDay();
    });

    document.getElementById('journal-calendar-toggle').addEventListener('click', function () {
      const cal = document.getElementById('journal-calendar');
      if (cal.hidden) {
        calendarViewYear = Number(journalDate.slice(0, 4));
        calendarViewMonth = Number(journalDate.slice(5, 7)) - 1;
        renderCalendar();
        cal.hidden = false;
      } else {
        cal.hidden = true;
      }
    });

    document.getElementById('calendar-prev-month').addEventListener('click', function () {
      calendarViewMonth--;
      if (calendarViewMonth < 0) {
        calendarViewMonth = 11;
        calendarViewYear--;
      }
      renderCalendar();
    });

    document.getElementById('calendar-next-month').addEventListener('click', function () {
      calendarViewMonth++;
      if (calendarViewMonth > 11) {
        calendarViewMonth = 0;
        calendarViewYear++;
      }
      renderCalendar();
    });

    document.getElementById('calendar-grid').addEventListener('click', function (e) {
      const target = e.target.closest('button[data-date]');
      if (!target || target.disabled) return;
      journalDate = target.getAttribute('data-date');
      closeCalendar();
      loadDay();
    });

    function loadDashboard() {
      loadToday();
      loadWeights();
      loadMacros();
      loadDay();
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
