export const dashboardHtml = `<!DOCTYPE html>
<html lang="zh-CN" class="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RikkaHub Analytics</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
<style>
  :root {
    --bg: #0a0a0f;
    --surface: #12121a;
    --surface2: #1a1a28;
    --border: #2a2a3a;
    --text: #e4e4f0;
    --text2: #8888a0;
    --accent: #6366f1;
    --accent2: #818cf8;
    --green: #34d399;
    --yellow: #fbbf24;
    --red: #f87171;
    --blue: #60a5fa;
    --purple: #a78bfa;
    --pink: #f472b6;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans SC', sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
  }
  .container { max-width: 1200px; margin: 0 auto; padding: 24px 20px; }

  /* Header */
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 28px;
  }
  .header h1 { font-size: 22px; font-weight: 700; letter-spacing: -0.5px; }
  .header h1 span { color: var(--accent2); }
  .header-right { display: flex; align-items: center; gap: 12px; }
  .header-right select {
    background: var(--surface2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 6px 12px;
    font-size: 13px;
    cursor: pointer;
  }
  .last-updated { font-size: 12px; color: var(--text2); }

  /* Stat Cards */
  .cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 24px; }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 18px 20px;
    position: relative;
    overflow: hidden;
  }
  .card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    background: var(--card-accent, var(--accent));
    opacity: 0.6;
  }
  .card-label { font-size: 12px; color: var(--text2); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
  .card-value { font-size: 28px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .card-sub { font-size: 12px; color: var(--text2); margin-top: 4px; }
  .card-sub .up { color: var(--green); }
  .card-sub .down { color: var(--red); }

  /* Charts grid */
  .charts { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 24px; }
  .chart-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px;
  }
  .chart-card.full { grid-column: 1 / -1; }
  .chart-title { font-size: 14px; font-weight: 600; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
  .chart-title .dot { width: 8px; height: 8px; border-radius: 50%; }
  .chart-container { position: relative; height: 260px; }
  .chart-container canvas { width: 100% !important; height: 100% !important; }

  /* Retention table */
  .retention-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .retention-table th, .retention-table td { padding: 8px 10px; text-align: center; border-bottom: 1px solid var(--border); }
  .retention-table th { color: var(--text2); font-weight: 500; }
  .retention-table td:first-child { text-align: left; font-variant-numeric: tabular-nums; }
  .retention-cell {
    display: inline-block;
    width: 44px;
    height: 24px;
    line-height: 24px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
  }

  /* Loading */
  .loading { display: flex; align-items: center; justify-content: center; height: 300px; }
  .spinner { width: 32px; height: 32px; border: 3px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Error */
  .error { text-align: center; padding: 60px 20px; color: var(--red); }

  /* Responsive */
  @media (max-width: 768px) {
    .cards { grid-template-columns: repeat(2, 1fr); }
    .charts { grid-template-columns: 1fr; }
  }
  @media (max-width: 480px) {
    .cards { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>RikkaHub <span>Analytics</span></h1>
    <div class="header-right">
      <select id="range">
        <option value="7">近 7 天</option>
        <option value="14">近 14 天</option>
        <option value="30" selected>近 30 天</option>
        <option value="90">近 90 天</option>
        <option value="180">近 180 天</option>
      </select>
      <span class="last-updated" id="updated"></span>
    </div>
  </div>

  <div id="content">
    <div class="loading"><div class="spinner"></div></div>
  </div>
</div>

<script>
const TOKEN = new URL(location.href).searchParams.get('token');
const BASE  = location.origin;

// ── Color helpers ──────────────────────────────────────────────
function retentionColor(pct) {
  if (pct >= 60) return 'rgba(52,211,153,0.7)';
  if (pct >= 40) return 'rgba(52,211,153,0.5)';
  if (pct >= 20) return 'rgba(251,191,36,0.5)';
  if (pct > 0)   return 'rgba(248,113,113,0.4)';
  return 'rgba(255,255,255,0.05)';
}

// ── Formatters ─────────────────────────────────────────────────
const fmt = n => n?.toLocaleString?.() ?? '—';
const fmtPct = n => n != null ? n + '%' : '—';
const fmtDelta = (cur, prev) => {
  if (!prev || prev === 0) return '';
  const pct = ((cur - prev) / prev * 100).toFixed(1);
  const cls = pct >= 0 ? 'up' : 'down';
  const arrow = pct >= 0 ? '↑' : '↓';
  return '<span class="' + cls + '">' + arrow + ' ' + Math.abs(pct) + '%</span>';
};

// ── Fetch data ─────────────────────────────────────────────────
async function fetchData(days) {
  const r = await fetch(BASE + '/api/stats?token=' + TOKEN + '&days=' + days);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// ── Render ─────────────────────────────────────────────────────
function render(data) {
  const trends = data.trends || [];
  const today = trends[trends.length - 1] || {};
  const yesterday = trends[trends.length - 2] || {};

  let html = '';

  // ── Stat Cards ───────────────────────────────────────────────
  html += '<div class="cards">';
  html += card('DAU', fmt(today.dau), fmtDelta(today.dau, yesterday.dau), 'var(--accent2)');
  html += card('Effective DAU', fmt(today.eff_dau), today.eff_dau && today.dau ? '<span class="up">' + Math.round(today.eff_dau / today.dau * 100) + '% of DAU</span>' : '', 'var(--green)');
  html += card('WAU / MAU', fmt(data.wau) + ' / ' + fmt(data.mau), 'Stickiness ' + fmtPct(data.stickiness), 'var(--yellow)');
  html += card('新用户', fmt(today.new_users), fmtDelta(today.new_users, yesterday.new_users), 'var(--pink)');
  html += '</div>';

  // ── Charts ───────────────────────────────────────────────────
  html += '<div class="charts">';

  // DAU trend (full width)
  html += chartCard('DAU 趋势', 'full', 'dau-chart');
  html += chartCard('消息数 / 新用户', '', 'msg-chart');
  html += chartCard('版本分布', '', 'version-chart');
  html += chartCard('系统分布', '', 'os-chart');

  html += '</div>';

  // ── Retention ────────────────────────────────────────────────
  if (data.retention?.cohorts?.length) {
    html += '<div class="charts"><div class="chart-card full">';
    html += '<div class="chart-title"><div class="dot" style="background:var(--purple)"></div>留存率</div>';
    html += '<table class="retention-table"><thead><tr><th>日期</th><th>新用户</th><th>D+1</th><th>D+3</th><th>D+7</th><th>D+14</th><th>D+30</th></tr></thead><tbody>';
    for (const c of data.retention.cohorts.slice(0, 15)) {
      html += '<tr><td>' + c.date + '</td><td>' + c.size + '</td>';
      for (const offset of [1,3,7,14,30]) {
        const val = c.retention[offset];
        if (val == null) {
          html += '<td>—</td>';
        } else {
          html += '<td><span class="retention-cell" style="background:' + retentionColor(val) + '">' + val + '%</span></td>';
        }
      }
      html += '</tr>';
    }
    html += '</tbody></table></div></div>';
  }

  document.getElementById('content').innerHTML = html;

  // ── Draw charts ──────────────────────────────────────────────
  const labels = trends.map(t => t.date.slice(5)); // MM-DD

  // DAU trend
  new Chart(document.getElementById('dau-chart'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'DAU', data: trends.map(t => t.dau), borderColor: '#818cf8', backgroundColor: 'rgba(129,140,248,0.1)', fill: true, tension: 0.3, pointRadius: 2 },
        { label: 'Effective DAU', data: trends.map(t => t.eff_dau), borderColor: '#34d399', backgroundColor: 'rgba(52,211,153,0.08)', fill: true, tension: 0.3, pointRadius: 2 },
      ]
    },
    options: chartOpts('DAU'),
  });

  // Messages & new users
  new Chart(document.getElementById('msg-chart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: '日均消息', data: trends.map(t => t.total_msgs), backgroundColor: 'rgba(96,165,250,0.6)', borderRadius: 3, barPercentage: 0.6 },
        { label: '新用户', data: trends.map(t => t.new_users), backgroundColor: 'rgba(244,114,182,0.6)', borderRadius: 3, barPercentage: 0.6 },
      ]
    },
    options: chartOpts(),
  });

  // Version distribution (doughnut)
  const versions = data.versions || [];
  const vColors = ['#818cf8','#60a5fa','#34d399','#fbbf24','#f87171','#a78bfa','#f472b6','#fb923c','#38bdf8','#4ade80'];
  new Chart(document.getElementById('version-chart'), {
    type: 'doughnut',
    data: {
      labels: versions.map(v => v.version || '(unknown)'),
      datasets: [{ data: versions.map(v => v.count), backgroundColor: vColors.slice(0, versions.length), borderWidth: 0 }],
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { color: '#8888a0', font: { size: 11 }, padding: 8 } } } },
  });

  // OS distribution (doughnut)
  const latest = trends[trends.length - 1] || {};
  const osData = [
    { label: 'Windows', value: latest.win_users || 0, color: '#60a5fa' },
    { label: 'Linux', value: latest.linux_users || 0, color: '#fbbf24' },
  ].filter(d => d.value > 0);
  new Chart(document.getElementById('os-chart'), {
    type: 'doughnut',
    data: {
      labels: osData.map(d => d.label),
      datasets: [{ data: osData.map(d => d.value), backgroundColor: osData.map(d => d.color), borderWidth: 0 }],
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { color: '#8888a0', font: { size: 11 }, padding: 8 } } } },
  });

  document.getElementById('updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
}

function card(label, value, sub, color) {
  return '<div class="card" style="--card-accent:' + color + '"><div class="card-label">' + label + '</div><div class="card-value">' + value + '</div><div class="card-sub">' + (sub || '') + '</div></div>';
}

function chartCard(title, extra, id) {
  return '<div class="chart-card' + (extra ? ' ' + extra : '') + '"><div class="chart-title"><div class="dot" style="background:var(--accent)"></div>' + title + '</div><div class="chart-container"><canvas id="' + id + '"></canvas></div></div>';
}

function chartOpts(title) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { intersect: false, mode: 'index' },
    plugins: {
      legend: { labels: { color: '#8888a0', font: { size: 11 }, usePointStyle: true, pointStyle: 'circle' } },
    },
    scales: {
      x: { ticks: { color: '#8888a0', font: { size: 10 }, maxRotation: 0 }, grid: { color: 'rgba(255,255,255,0.04)' } },
      y: { ticks: { color: '#8888a0', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' }, beginAtZero: true },
    },
  };
}

// ── Init ───────────────────────────────────────────────────────
async function load() {
  try {
    const days = document.getElementById('range').value;
    const data = await fetchData(days);
    render(data);
  } catch (e) {
    document.getElementById('content').innerHTML = '<div class="error">Failed to load: ' + e.message + '</div>';
  }
}

document.getElementById('range').addEventListener('change', load);
load();
</script>
</body>
</html>`;
