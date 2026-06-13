export const onRequest: PagesFunction = async (context) => {
  const url = new URL(context.request.url);
  const token = url.searchParams.get("token");
  const AUTH_TOKEN = context.env.AUTH_TOKEN ?? "REDACTED";
  if (token !== AUTH_TOKEN) {
    return new Response("未授权访问", { status: 401, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  return new Response(dashboardHtml, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
};

const dashboardHtml = `<!DOCTYPE html>
<html lang="zh-CN" class="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RikkaHub 数据看板</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&family=Noto+Sans+SC:wght@400;500;600;700&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"><\/script>
<style>
  :root {
    /* 颜色系统:更柔和的暗色背景 + 富有层次的表面 */
    --bg: #08080c;
    --bg-grad: radial-gradient(ellipse 80% 50% at 50% -10%, rgba(99, 102, 241, 0.08), transparent 70%);
    --surface: rgba(255, 255, 255, 0.025);
    --surface-hover: rgba(255, 255, 255, 0.04);
    --border: rgba(255, 255, 255, 0.06);
    --border-strong: rgba(255, 255, 255, 0.1);
    --text: #fafafa;
    --text-muted: #a1a1aa;
    --text-dim: #71717a;

    /* 强调色 */
    --indigo: #818cf8;
    --indigo-dim: rgba(129, 140, 248, 0.15);
    --emerald: #34d399;
    --emerald-dim: rgba(52, 211, 153, 0.15);
    --amber: #fbbf24;
    --amber-dim: rgba(251, 191, 36, 0.15);
    --rose: #fb7185;
    --rose-dim: rgba(251, 113, 133, 0.15);
    --sky: #38bdf8;
    --violet: #a78bfa;
    --pink: #f472b6;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  html, body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Inter', 'Noto Sans SC', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-feature-settings: 'cv11', 'ss01', 'ss03';
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    min-height: 100vh;
  }

  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background: var(--bg-grad);
    pointer-events: none;
    z-index: 0;
  }

  .container {
    max-width: 1280px;
    margin: 0 auto;
    padding: 40px 32px 64px;
    position: relative;
    z-index: 1;
  }

  /* ─────────── 顶部 Header ─────────── */
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 40px;
    gap: 16px;
    flex-wrap: wrap;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .brand-mark {
    width: 34px;
    height: 34px;
    border-radius: 9px;
    overflow: hidden;
    box-shadow: 0 8px 24px -8px rgba(129, 140, 248, 0.4), 0 0 0 1px rgba(255,255,255,0.06);
    background: #1a1a28;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .brand-mark img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .brand-text {
    display: flex;
    flex-direction: column;
    line-height: 1.1;
  }
  .brand-name {
    font-size: 16px;
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  .brand-sub {
    font-size: 12px;
    color: var(--text-dim);
    font-weight: 500;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .updated {
    font-size: 12px;
    color: var(--text-dim);
    display: flex;
    align-items: center;
    gap: 6px;
    font-variant-numeric: tabular-nums;
    font-family: 'JetBrains Mono', monospace;
  }
  .live-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--emerald);
    box-shadow: 0 0 8px var(--emerald);
    animation: pulse 2s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 0.6; }
    50% { opacity: 1; }
  }
  .range {
    display: inline-flex;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 3px;
    gap: 0;
  }
  .range button {
    background: transparent;
    border: 0;
    color: var(--text-muted);
    font-family: inherit;
    font-size: 12px;
    font-weight: 500;
    padding: 5px 12px;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .range button:hover { color: var(--text); }
  .range button.active {
    background: var(--surface-hover);
    color: var(--text);
    box-shadow: 0 1px 2px rgba(0,0,0,0.2);
  }

  /* ─────────── 顶层指标卡 ─────────── */
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
    margin-bottom: 24px;
  }
  .stat {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 20px 22px;
    position: relative;
    overflow: hidden;
    transition: all 0.2s ease;
  }
  .stat:hover {
    background: var(--surface-hover);
    border-color: var(--border-strong);
  }
  .stat::after {
    content: '';
    position: absolute;
    top: 0;
    left: 20px;
    right: 20px;
    height: 1px;
    background: linear-gradient(90deg, transparent, var(--stat-color, var(--indigo)), transparent);
    opacity: 0.6;
  }
  .stat-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 14px;
  }
  .stat-label {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--text-dim);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .stat-icon {
    width: 24px;
    height: 24px;
    border-radius: 6px;
    background: var(--stat-bg, var(--indigo-dim));
    color: var(--stat-color, var(--indigo));
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .stat-icon svg { width: 13px; height: 13px; stroke-width: 2.5; }
  .stat-value {
    font-family: 'Inter', sans-serif;
    font-size: 32px;
    font-weight: 700;
    letter-spacing: -0.025em;
    line-height: 1.1;
    font-variant-numeric: tabular-nums;
  }
  .stat-foot {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 8px;
    font-size: 12px;
    color: var(--text-dim);
  }
  .stat-foot .delta {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 2px 6px;
    border-radius: 4px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
  }
  .delta.up { background: var(--emerald-dim); color: var(--emerald); }
  .delta.down { background: var(--rose-dim); color: var(--rose); }
  .delta.flat { background: rgba(255,255,255,0.05); color: var(--text-dim); }

  /* ─────────── 图表卡 ─────────── */
  .grid {
    display: grid;
    gap: 12px;
    margin-bottom: 12px;
  }
  .grid.two { grid-template-columns: 1fr 1fr; }
  .grid.full { grid-template-columns: 1fr; }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 22px 24px;
    transition: all 0.2s ease;
  }
  .card:hover { border-color: var(--border-strong); }
  .card-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    margin-bottom: 16px;
  }
  .card-title {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .card-title h3 {
    font-size: 14px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .card-title .desc {
    font-size: 12px;
    color: var(--text-dim);
    font-weight: 400;
  }
  .card-legend {
    display: flex;
    gap: 14px;
    font-size: 12px;
  }
  .card-legend .item {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text-muted);
  }
  .card-legend .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
  .chart-wrap { position: relative; height: 280px; }
  .chart-wrap.tall { height: 320px; }
  .chart-wrap canvas { width: 100% !important; height: 100% !important; }

  /* ─────────── 留存表 ─────────── */
  .retention-table {
    width: 100%;
    border-collapse: separate;
    border-spacing: 0;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .retention-table thead th {
    padding: 10px 12px;
    text-align: center;
    color: var(--text-dim);
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border-bottom: 1px solid var(--border);
  }
  .retention-table thead th:first-child { text-align: left; }
  .retention-table tbody td {
    padding: 10px 12px;
    text-align: center;
    color: var(--text-muted);
    border-bottom: 1px solid var(--border);
  }
  .retention-table tbody tr:last-child td { border-bottom: 0; }
  .retention-table tbody td:first-child {
    text-align: left;
    color: var(--text);
    font-family: 'JetBrains Mono', monospace;
    font-size: 11.5px;
    font-weight: 500;
  }
  .retention-table tbody td:nth-child(2) {
    color: var(--text);
    font-weight: 600;
    font-family: 'JetBrains Mono', monospace;
  }
  .ret-cell {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 50px;
    padding: 4px 8px;
    border-radius: 5px;
    font-family: 'JetBrains Mono', monospace;
    font-weight: 600;
    font-size: 11px;
  }

  /* ─────────── 加载/错误状态 ─────────── */
  .loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    padding: 120px 0;
    color: var(--text-dim);
  }
  .spinner {
    width: 28px;
    height: 28px;
    border: 2.5px solid var(--border);
    border-top-color: var(--indigo);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .loading-text { font-size: 13px; }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 60px 0;
    color: var(--text-dim);
  }
  .empty-icon {
    width: 40px; height: 40px;
    color: var(--text-dim);
    opacity: 0.5;
  }
  .empty-text { font-size: 13px; }

  .error {
    text-align: center;
    padding: 80px 0;
    color: var(--rose);
    font-size: 14px;
  }

  /* ─────────── 入场动画 ─────────── */
  .fade-in {
    animation: fadeIn 0.4s ease-out backwards;
  }
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  /* ─────────── 响应式 ─────────── */
  @media (max-width: 1024px) {
    .stats-grid { grid-template-columns: repeat(2, 1fr); }
  }
  @media (max-width: 768px) {
    .container { padding: 24px 16px 48px; }
    .grid.two { grid-template-columns: 1fr; }
    .header { flex-direction: column; align-items: flex-start; }
    .stat-value { font-size: 26px; }
  }
  @media (max-width: 480px) {
    .stats-grid { grid-template-columns: 1fr; }
    .range button { padding: 5px 9px; font-size: 11px; }
  }
</style>
</head>
<body>
<div class="container">
  <!-- 顶部:品牌 + 工具栏 -->
  <div class="header fade-in">
    <div class="brand">
      <div class="brand-mark"><img src="/icon.png" alt="RikkaHub" onerror="this.style.display='none';this.parentElement.style.background='linear-gradient(135deg,#818cf8,#a78bfa)'"></div>
      <div class="brand-text">
        <div class="brand-name">RikkaHub 数据看板</div>
        <div class="brand-sub">用户活跃度与留存分析</div>
      </div>
    </div>
    <div class="toolbar">
      <div class="updated"><span class="live-dot"></span><span id="updated">--:--</span></div>
      <div class="range" id="range">
        <button data-d="7">7 天</button>
        <button data-d="14">14 天</button>
        <button data-d="30" class="active">30 天</button>
        <button data-d="90">90 天</button>
        <button data-d="180">180 天</button>
      </div>
    </div>
  </div>

  <div id="content">
    <div class="loading">
      <div class="spinner"></div>
      <div class="loading-text">正在加载数据…</div>
    </div>
  </div>
</div>

<script>
const TOKEN = new URL(location.href).searchParams.get('token');
const BASE  = location.origin;

// SVG 图标
const ICONS = {
  dau: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.66V20a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h5.34"/><polygon points="18 2 22 6 12 16 8 16 8 12 18 2"/></svg>',
  effective: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/></svg>',
  monthly: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
  new: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>',
};

const fmt = n => (n ?? 0).toLocaleString('zh-CN');
const fmtPct = n => (n != null ? n + '%' : '—');

function delta(cur, prev) {
  if (prev == null || prev === 0) {
    return '<span class="delta flat">— —</span>';
  }
  const pct = ((cur - prev) / prev * 100);
  const cls = pct > 0 ? 'up' : (pct < 0 ? 'down' : 'flat');
  const arrow = pct > 0 ? '↑' : (pct < 0 ? '↓' : '·');
  return '<span class="delta ' + cls + '">' + arrow + ' ' + Math.abs(pct).toFixed(1) + '%</span>';
}

function retentionStyle(pct) {
  if (pct >= 60) return { bg: 'rgba(52,211,153,0.18)', color: '#6ee7b7' };
  if (pct >= 40) return { bg: 'rgba(52,211,153,0.12)', color: '#34d399' };
  if (pct >= 20) return { bg: 'rgba(251,191,36,0.14)', color: '#fbbf24' };
  if (pct > 0)   return { bg: 'rgba(251,113,133,0.12)', color: '#fb7185' };
  return { bg: 'rgba(255,255,255,0.03)', color: '#71717a' };
}

async function fetchData(days) {
  const r = await fetch(BASE + '/api/stats?token=' + TOKEN + '&days=' + days);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

function statCard(opts) {
  const { label, icon, value, foot, color, bg } = opts;
  return \`
    <div class="stat" style="--stat-color:\${color};--stat-bg:\${bg}">
      <div class="stat-header">
        <div class="stat-label">\${label}</div>
        <div class="stat-icon">\${icon}</div>
      </div>
      <div class="stat-value">\${value}</div>
      <div class="stat-foot">\${foot || ''}</div>
    </div>
  \`;
}

function card(opts) {
  const { title, desc, legend, body, fullHeight } = opts;
  const legendHtml = legend ? '<div class="card-legend">' + legend.map(l =>
    '<div class="item"><div class="dot" style="background:' + l.color + '"></div>' + l.label + '</div>'
  ).join('') + '</div>' : '';
  return \`
    <div class="card fade-in">
      <div class="card-head">
        <div class="card-title">
          <h3>\${title}</h3>
          \${desc ? '<div class="desc">' + desc + '</div>' : ''}
        </div>
        \${legendHtml}
      </div>
      \${body}
    </div>
  \`;
}

function render(data) {
  const trends = data.trends || [];
  const today = trends[trends.length - 1] || {};
  const yesterday = trends[trends.length - 2] || {};

  let html = '';

  // ── 顶层指标卡 ──
  const dauPct = today.dau ? Math.round((today.eff_dau ?? 0) / today.dau * 100) : 0;
  html += '<div class="stats-grid">';
  html += statCard({
    label: '日活用户',
    icon: ICONS.dau,
    value: fmt(today.dau),
    foot: '较昨日 ' + delta(today.dau ?? 0, yesterday.dau ?? 0),
    color: 'var(--indigo)', bg: 'var(--indigo-dim)',
  });
  html += statCard({
    label: '有效日活',
    icon: ICONS.effective,
    value: fmt(today.eff_dau),
    foot: today.dau ? '占日活 ' + dauPct + '%' : '当日无对话',
    color: 'var(--emerald)', bg: 'var(--emerald-dim)',
  });
  html += statCard({
    label: '周活 / 月活',
    icon: ICONS.monthly,
    value: fmt(data.wau) + ' <span style="font-weight:400;color:var(--text-dim);font-size:18px"> / </span>' + fmt(data.mau),
    foot: '粘性 ' + fmtPct(data.stickiness),
    color: 'var(--amber)', bg: 'var(--amber-dim)',
  });
  html += statCard({
    label: '新增用户',
    icon: ICONS.new,
    value: fmt(today.new_users),
    foot: '较昨日 ' + delta(today.new_users ?? 0, yesterday.new_users ?? 0),
    color: 'var(--rose)', bg: 'var(--rose-dim)',
  });
  html += '</div>';

  // ── 主趋势图(全宽) ──
  html += '<div class="grid full">';
  html += card({
    title: '日活趋势',
    desc: '过去 ' + trends.length + ' 天的总日活与有效日活',
    legend: [
      { label: '日活', color: 'var(--indigo)' },
      { label: '有效日活', color: 'var(--emerald)' },
    ],
    body: '<div class="chart-wrap tall"><canvas id="dau-chart"></canvas></div>',
  });
  html += '</div>';

  // ── 消息 + 新用户(双栏) ──
  html += '<div class="grid two">';
  html += card({
    title: '消息量与新增',
    desc: '每日消息总数与新增用户数',
    legend: [
      { label: '消息数', color: 'var(--sky)' },
      { label: '新增', color: 'var(--pink)' },
    ],
    body: '<div class="chart-wrap"><canvas id="msg-chart"></canvas></div>',
  });
  html += card({
    title: '日均消息',
    desc: '活跃用户日均发送消息',
    body: '<div class="chart-wrap"><canvas id="avg-chart"></canvas></div>',
  });
  html += '</div>';

  // ── 版本 + 系统(双栏) ──
  const hasVersionData = data.versions && data.versions.length;
  const hasOsData = (today.win_users || 0) + (today.linux_users || 0) + (today.mac_users || 0) > 0;
  html += '<div class="grid two">';
  html += card({
    title: '版本分布',
    desc: '当前活跃用户的应用版本',
    body: hasVersionData
      ? '<div class="chart-wrap"><canvas id="version-chart"></canvas></div>'
      : emptyState('暂无版本数据'),
  });
  html += card({
    title: '系统分布',
    desc: '当日活跃用户的操作系统',
    body: hasOsData
      ? '<div class="chart-wrap"><canvas id="os-chart"></canvas></div>'
      : emptyState('暂无系统数据'),
  });
  html += '</div>';

  // ── 留存表 ──
  if (data.retention && data.retention.cohorts && data.retention.cohorts.length) {
    let table = '<table class="retention-table"><thead><tr>';
    table += '<th>新增日</th><th>新用户</th><th>次日</th><th>3 日</th><th>7 日</th><th>14 日</th><th>30 日</th>';
    table += '</tr></thead><tbody>';
    for (const c of data.retention.cohorts.slice(0, 14)) {
      table += '<tr><td>' + c.date + '</td><td>' + c.size + '</td>';
      for (const offset of [1, 3, 7, 14, 30]) {
        const val = c.retention[offset];
        if (val == null) {
          table += '<td><span class="ret-cell" style="background:rgba(255,255,255,0.02);color:var(--text-dim)">—</span></td>';
        } else {
          const s = retentionStyle(val);
          table += '<td><span class="ret-cell" style="background:' + s.bg + ';color:' + s.color + '">' + val + '%</span></td>';
        }
      }
      table += '</tr>';
    }
    table += '</tbody></table>';
    html += '<div class="grid full">';
    html += card({
      title: '留存率',
      desc: '不同时间窗口下新用户的回访比例',
      body: table,
    });
    html += '</div>';
  }

  document.getElementById('content').innerHTML = html;
  drawCharts(data, trends);

  document.getElementById('updated').textContent = new Date().toTimeString().slice(0, 8) + ' 已更新';
}

function emptyState(msg) {
  return '<div class="empty"><svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg><div class="empty-text">' + msg + '</div></div>';
}

function drawCharts(data, trends) {
  const labels = trends.map(t => t.date.slice(5).replace('-', '/'));
  const fontFamily = "'Inter', 'JetBrains Mono', 'Noto Sans SC', sans-serif";

  const baseOpts = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { intersect: false, mode: 'index' },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(20, 20, 30, 0.95)',
        borderColor: 'rgba(255,255,255,0.1)',
        borderWidth: 1,
        padding: 12,
        boxPadding: 6,
        titleColor: '#fafafa',
        bodyColor: '#a1a1aa',
        titleFont: { family: fontFamily, weight: 600, size: 12 },
        bodyFont: { family: fontFamily, size: 12 },
        cornerRadius: 8,
      },
    },
    scales: {
      x: {
        ticks: { color: '#71717a', font: { family: fontFamily, size: 10.5 }, maxRotation: 0, padding: 8 },
        grid: { display: false },
        border: { display: false },
      },
      y: {
        ticks: { color: '#71717a', font: { family: fontFamily, size: 10.5 }, padding: 8 },
        grid: { color: 'rgba(255,255,255,0.04)', drawTicks: false },
        border: { display: false },
        beginAtZero: true,
      },
    },
  };

  // 主 DAU 趋势(双线 + 渐变填充)
  const dauCanvas = document.getElementById('dau-chart');
  if (dauCanvas) {
    const ctx = dauCanvas.getContext('2d');
    const grad1 = ctx.createLinearGradient(0, 0, 0, 320);
    grad1.addColorStop(0, 'rgba(129,140,248,0.25)');
    grad1.addColorStop(1, 'rgba(129,140,248,0)');
    const grad2 = ctx.createLinearGradient(0, 0, 0, 320);
    grad2.addColorStop(0, 'rgba(52,211,153,0.20)');
    grad2.addColorStop(1, 'rgba(52,211,153,0)');

    new Chart(dauCanvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: '日活', data: trends.map(t => t.dau), borderColor: '#818cf8', backgroundColor: grad1, fill: true, tension: 0.35, pointRadius: 0, pointHoverRadius: 5, pointHoverBackgroundColor: '#818cf8', pointHoverBorderColor: '#fff', pointHoverBorderWidth: 2, borderWidth: 2 },
          { label: '有效日活', data: trends.map(t => t.eff_dau), borderColor: '#34d399', backgroundColor: grad2, fill: true, tension: 0.35, pointRadius: 0, pointHoverRadius: 5, pointHoverBackgroundColor: '#34d399', pointHoverBorderColor: '#fff', pointHoverBorderWidth: 2, borderWidth: 2 },
        ]
      },
      options: baseOpts,
    });
  }

  // 消息 + 新用户(柱状)
  const msgCanvas = document.getElementById('msg-chart');
  if (msgCanvas) {
    new Chart(msgCanvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: '消息数', data: trends.map(t => t.total_msgs), backgroundColor: 'rgba(56,189,248,0.7)', borderRadius: 4, barPercentage: 0.65, categoryPercentage: 0.7 },
          { label: '新增', data: trends.map(t => t.new_users), backgroundColor: 'rgba(244,114,182,0.7)', borderRadius: 4, barPercentage: 0.65, categoryPercentage: 0.7 },
        ]
      },
      options: baseOpts,
    });
  }

  // 日均消息(单线)
  const avgCanvas = document.getElementById('avg-chart');
  if (avgCanvas) {
    const ctx = avgCanvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 280);
    grad.addColorStop(0, 'rgba(167,139,250,0.25)');
    grad.addColorStop(1, 'rgba(167,139,250,0)');
    const avgPerDay = trends.map(t => {
      const eff = t.eff_dau || 0;
      return eff > 0 ? Math.round((t.total_msgs || 0) / eff * 10) / 10 : 0;
    });
    new Chart(avgCanvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: '日均消息', data: avgPerDay, borderColor: '#a78bfa', backgroundColor: grad, fill: true, tension: 0.35, pointRadius: 0, pointHoverRadius: 5, pointHoverBackgroundColor: '#a78bfa', pointHoverBorderColor: '#fff', pointHoverBorderWidth: 2, borderWidth: 2 },
        ]
      },
      options: baseOpts,
    });
  }

  // 版本分布(环形)
  const verCanvas = document.getElementById('version-chart');
  if (verCanvas && data.versions && data.versions.length) {
    const palette = ['#818cf8', '#34d399', '#fbbf24', '#fb7185', '#38bdf8', '#a78bfa', '#f472b6', '#fb923c'];
    new Chart(verCanvas, {
      type: 'doughnut',
      data: {
        labels: data.versions.map(v => v.version || '未知'),
        datasets: [{
          data: data.versions.map(v => v.count),
          backgroundColor: palette.slice(0, data.versions.length),
          borderWidth: 0,
          hoverOffset: 8,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '65%',
        plugins: {
          legend: { position: 'right', labels: { color: '#a1a1aa', font: { family: fontFamily, size: 12 }, usePointStyle: true, pointStyle: 'circle', padding: 12, boxWidth: 8 } },
          tooltip: baseOpts.plugins.tooltip,
        },
      },
    });
  }

  // 系统分布(环形)
  const osCanvas = document.getElementById('os-chart');
  const latest = trends[trends.length - 1] || {};
  const osData = [
    { label: 'Windows', value: latest.win_users || 0, color: '#38bdf8' },
    { label: 'macOS', value: latest.mac_users || 0, color: '#a78bfa' },
    { label: 'Linux', value: latest.linux_users || 0, color: '#fbbf24' },
  ].filter(d => d.value > 0);
  if (osCanvas && osData.length) {
    new Chart(osCanvas, {
      type: 'doughnut',
      data: {
        labels: osData.map(d => d.label),
        datasets: [{
          data: osData.map(d => d.value),
          backgroundColor: osData.map(d => d.color),
          borderWidth: 0,
          hoverOffset: 8,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '65%',
        plugins: {
          legend: { position: 'right', labels: { color: '#a1a1aa', font: { family: fontFamily, size: 12 }, usePointStyle: true, pointStyle: 'circle', padding: 12, boxWidth: 8 } },
          tooltip: baseOpts.plugins.tooltip,
        },
      },
    });
  }
}

let currentDays = 30;
async function load() {
  try {
    const data = await fetchData(currentDays);
    render(data);
  } catch (e) {
    document.getElementById('content').innerHTML = '<div class="error">数据加载失败:' + e.message + '</div>';
  }
}

// 时间范围切换
document.getElementById('range').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  document.querySelectorAll('#range button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentDays = parseInt(btn.dataset.d, 10);
  document.getElementById('content').innerHTML = '<div class="loading"><div class="spinner"></div><div class="loading-text">正在加载数据…</div></div>';
  load();
});

load();
// 每 60 秒自动刷新
setInterval(load, 60000);
<\/script>
</body>
</html>`;
