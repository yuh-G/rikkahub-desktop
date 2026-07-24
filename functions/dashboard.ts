import { isAuthorized, authCookie } from "./_lib";

export const onRequest: PagesFunction = async (context) => {
  const url = new URL(context.request.url);
  const token = url.searchParams.get("token");
  const secret = context.env.AUTH_TOKEN;

  // 首次用 ?token= 进入:下发 HttpOnly cookie 并 302 到不带 token 的地址,让 token
  // 尽快离开地址栏/书签/访问日志;此后 /api/stats 靠 cookie 鉴权,URL 不再携带秘密。
  if (secret && token === secret) {
    url.searchParams.delete("token");
    return new Response(null, {
      status: 302,
      headers: {
        Location: url.pathname + url.search,
        "Set-Cookie": authCookie(secret),
      },
    });
  }
  if (!isAuthorized(context, url)) {
    return new Response("未授权访问", { status: 401, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  // 每次响应生成一次性 nonce:CSP 只放行带该 nonce 的内联脚本 + 带 SRI 的 jsdelivr,
  // CDN 被投毒(SRI 校不上)或任何注入脚本都执行不了。style 因大量内联 style= 属性
  // 保留 unsafe-inline,风险面远小于脚本。
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const csp = [
    "default-src 'self'",
    "script-src 'nonce-" + nonce + "' https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; ");
  return new Response(dashboardHtml.replace(/__NONCE__/g, nonce), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": csp,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
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
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js" integrity="sha384-vsrfeLOOY6KuIYKDlmVH5UiBmgIdB1oEf7p01YgWHuqmOHfZr374+odEv96n9tNC" crossorigin="anonymous"><\/script>
<style>
  :root {
    --bg: #08080c;
    --bg-grad: radial-gradient(ellipse 80% 50% at 50% -10%, rgba(99,102,241,0.08), transparent 70%);
    --surface: rgba(255,255,255,0.025);
    --surface-hover: rgba(255,255,255,0.045);
    --border: rgba(255,255,255,0.06);
    --border-strong: rgba(255,255,255,0.1);
    --text: #fafafa;
    --text-muted: #a1a1aa;
    --text-dim: #71717a;
    --indigo: #818cf8; --indigo-dim: rgba(129,140,248,0.15);
    --emerald: #34d399; --emerald-dim: rgba(52,211,153,0.15);
    --amber: #fbbf24; --amber-dim: rgba(251,191,36,0.15);
    --rose: #fb7185; --rose-dim: rgba(251,113,133,0.15);
    --sky: #38bdf8; --sky-dim: rgba(56,189,248,0.15);
    --violet: #a78bfa; --violet-dim: rgba(167,139,250,0.15);
    --pink: #f472b6; --pink-dim: rgba(244,114,182,0.15);
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { background: var(--bg); color: var(--text); font-family: 'Inter','Noto Sans SC',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; font-feature-settings: 'cv11','ss01','ss03'; -webkit-font-smoothing: antialiased; min-height: 100vh; }
  body::before { content:''; position:fixed; inset:0; background: var(--bg-grad); pointer-events:none; z-index:0; }
  .container { max-width: 1360px; margin: 0 auto; padding: 32px 32px 64px; position: relative; z-index: 1; }

  /* Header */
  .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; gap: 16px; flex-wrap: wrap; }
  .brand { display: flex; align-items: center; gap: 12px; }
  .brand-mark { width: 36px; height: 36px; border-radius: 10px; overflow: hidden; box-shadow: 0 8px 24px -8px rgba(129,140,248,0.4), 0 0 0 1px rgba(255,255,255,0.06); background: #1a1a28; display: flex; align-items: center; justify-content: center; }
  .brand-mark img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .brand-text { display: flex; flex-direction: column; line-height: 1.15; }
  .brand-name { font-size: 17px; font-weight: 700; letter-spacing: -0.02em; }
  .brand-sub { font-size: 12px; color: var(--text-dim); font-weight: 500; }
  .toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .updated { font-size: 12px; color: var(--text-dim); display: flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums; font-family: 'JetBrains Mono',monospace; }
  .live-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--emerald); box-shadow: 0 0 8px var(--emerald); animation: pulse 2s ease-in-out infinite; }
  @keyframes pulse { 0%,100%{opacity:0.6;} 50%{opacity:1;} }
  .icon-btn { background: var(--surface); border: 1px solid var(--border); color: var(--text-muted); width: 34px; height: 34px; border-radius: 8px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; transition: all 0.15s ease; }
  .icon-btn:hover { color: var(--text); border-color: var(--border-strong); }
  .icon-btn svg { width: 15px; height: 15px; stroke-width: 2.2; }
  .icon-btn.spinning svg { animation: spin 0.7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Range + custom */
  .range { display: inline-flex; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 3px; }
  .range button { background: transparent; border: 0; color: var(--text-muted); font-family: inherit; font-size: 12px; font-weight: 500; padding: 6px 12px; border-radius: 6px; cursor: pointer; transition: all 0.15s ease; }
  .range button:hover { color: var(--text); }
  .range button.active { background: var(--surface-hover); color: var(--text); box-shadow: 0 1px 2px rgba(0,0,0,0.2); }
  .custom-range { display: none; align-items: center; gap: 6px; }
  .custom-range.on { display: inline-flex; }
  .custom-range input[type=date] { background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 7px; padding: 6px 10px; font-family: inherit; font-size: 12px; color-scheme: dark; }

  /* Filter bar */
  .filterbar { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; padding: 12px 16px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; margin-bottom: 16px; }
  .filter-group { display: flex; align-items: center; gap: 8px; }
  .filter-label { font-size: 11px; font-weight: 600; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em; }
  .seg { display: inline-flex; background: rgba(255,255,255,0.03); border: 1px solid var(--border); border-radius: 7px; padding: 2px; gap: 1px; }
  .seg button { background: transparent; border: 0; color: var(--text-muted); font-family: inherit; font-size: 12px; font-weight: 500; padding: 5px 11px; border-radius: 5px; cursor: pointer; transition: all 0.15s ease; white-space: nowrap; }
  .seg button:hover { color: var(--text); }
  .seg button.active { background: var(--indigo-dim); color: var(--indigo); }
  .filterbar select { background: rgba(255,255,255,0.03); color: var(--text); border: 1px solid var(--border); border-radius: 7px; padding: 6px 28px 6px 11px; font-family: inherit; font-size: 12px; cursor: pointer; appearance: none; -webkit-appearance: none; color-scheme: dark; background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2371717a' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>"); background-repeat: no-repeat; background-position: right 9px center; }
  .filterbar select option { background: #1a1a28; color: var(--text); }
  .filter-summary { margin-left: auto; font-size: 11.5px; color: var(--text-dim); font-family: 'JetBrains Mono',monospace; max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* Section nav */
  .section-nav { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin-bottom: 22px; }
  .section-nav button { background: transparent; border: 0; color: var(--text-dim); font-family: inherit; font-size: 13.5px; font-weight: 600; padding: 10px 16px; cursor: pointer; position: relative; transition: color 0.15s ease; }
  .section-nav button:hover { color: var(--text-muted); }
  .section-nav button.active { color: var(--text); }
  .section-nav button.active::after { content: ''; position: absolute; left: 12px; right: 12px; bottom: -1px; height: 2px; background: var(--indigo); border-radius: 2px; }
  .section { display: none; }
  .section.on { display: block; }

  /* KPI cards */
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 14px; }
  .kpi { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 18px 20px; position: relative; overflow: hidden; transition: all 0.2s ease; }
  .kpi:hover { background: var(--surface-hover); border-color: var(--border-strong); }
  .kpi-top { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 10px; }
  .kpi-label { font-size: 11.5px; font-weight: 600; color: var(--text-dim); letter-spacing: 0.03em; text-transform: uppercase; display: flex; align-items: center; gap: 5px; }
  .info { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; border-radius: 50%; border: 1px solid var(--border-strong); color: var(--text-dim); font-size: 9px; cursor: help; font-weight: 700; font-family: serif; }
  .kpi-value { font-size: 30px; font-weight: 700; letter-spacing: -0.025em; line-height: 1.05; font-variant-numeric: tabular-nums; }
  .kpi-spark { position: absolute; right: 16px; bottom: 14px; opacity: 0.85; }
  .kpi-foot { display: flex; align-items: center; gap: 8px; margin-top: 8px; font-size: 12px; color: var(--text-dim); }
  .delta { display: inline-flex; align-items: center; gap: 2px; padding: 2px 6px; border-radius: 4px; font-weight: 600; font-variant-numeric: tabular-nums; font-family: 'JetBrains Mono',monospace; font-size: 11px; }
  .delta.up { background: var(--emerald-dim); color: var(--emerald); }
  .delta.down { background: var(--rose-dim); color: var(--rose); }
  .delta.flat { background: rgba(255,255,255,0.05); color: var(--text-dim); }

  /* Mini cards */
  .minis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 14px; }
  .mini { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 13px 15px; }
  .mini-label { font-size: 11px; color: var(--text-dim); font-weight: 500; margin-bottom: 5px; display: flex; align-items: center; gap: 5px; }
  .mini-value { font-size: 20px; font-weight: 700; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; line-height: 1.1; }
  .mini-sub { font-size: 11px; color: var(--text-dim); margin-top: 3px; font-family: 'JetBrains Mono',monospace; }
  .badge-tag { font-size: 9px; padding: 1px 5px; border-radius: 3px; background: rgba(255,255,255,0.06); color: var(--text-dim); font-weight: 600; }

  /* Chart cards */
  .grid { display: grid; gap: 12px; margin-bottom: 12px; }
  .grid.two { grid-template-columns: 1fr 1fr; }
  .grid.three { grid-template-columns: repeat(3, 1fr); }
  .grid.full { grid-template-columns: 1fr; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 20px 22px; transition: all 0.2s ease; }
  .card:hover { border-color: var(--border-strong); }
  .card-head { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 14px; gap: 12px; flex-wrap: wrap; }
  .card-title { display: flex; flex-direction: column; gap: 2px; }
  .card-title h3 { font-size: 14px; font-weight: 600; letter-spacing: -0.01em; }
  .card-title .desc { font-size: 12px; color: var(--text-dim); font-weight: 400; }
  .card-legend { display: flex; gap: 14px; font-size: 12px; flex-wrap: wrap; }
  .card-legend .item { display: flex; align-items: center; gap: 6px; color: var(--text-muted); }
  .card-legend .dot { width: 8px; height: 8px; border-radius: 50%; }
  .card-actions { display: flex; gap: 6px; align-items: center; }
  .toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--text-muted); cursor: pointer; user-select: none; }
  .toggle input { accent-color: var(--indigo); }
  .csv-btn { background: rgba(255,255,255,0.04); border: 1px solid var(--border); color: var(--text-muted); font-family: inherit; font-size: 11px; font-weight: 500; padding: 5px 10px; border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; transition: all 0.15s ease; }
  .csv-btn:hover { color: var(--text); border-color: var(--border-strong); }
  .csv-btn svg { width: 12px; height: 12px; stroke-width: 2.2; }
  .chart-wrap { position: relative; height: 280px; }
  .chart-wrap.tall { height: 320px; }
  .chart-wrap.short { height: 220px; }
  .chart-wrap canvas { width: 100% !important; height: 100% !important; }

  /* Tabs */
  .tabs { display: inline-flex; background: rgba(255,255,255,0.03); border: 1px solid var(--border); border-radius: 8px; padding: 3px; gap: 2px; }
  .tabs button { background: transparent; border: 0; color: var(--text-muted); font-family: inherit; font-size: 12px; font-weight: 500; padding: 6px 14px; border-radius: 6px; cursor: pointer; transition: all 0.15s ease; }
  .tabs button:hover { color: var(--text); }
  .tabs button.active { background: var(--surface-hover); color: var(--text); box-shadow: 0 1px 2px rgba(0,0,0,0.2); }

  /* Tables */
  .rtable { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 12px; font-variant-numeric: tabular-nums; }
  .rtable thead th { padding: 9px 10px; text-align: center; color: var(--text-dim); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; border-bottom: 1px solid var(--border); }
  .rtable thead th:first-child { text-align: left; }
  .rtable tbody td { padding: 9px 10px; text-align: center; color: var(--text-muted); border-bottom: 1px solid var(--border); }
  .rtable tbody tr:last-child td { border-bottom: 0; }
  .rtable tbody td:first-child { text-align: left; color: var(--text); font-family: 'JetBrains Mono',monospace; font-size: 11.5px; font-weight: 500; }
  .rtable tbody td:nth-child(2) { color: var(--text); font-weight: 600; font-family: 'JetBrains Mono',monospace; }
  .ret-cell { display: inline-flex; align-items: center; justify-content: center; min-width: 48px; padding: 3px 7px; border-radius: 5px; font-family: 'JetBrains Mono',monospace; font-weight: 600; font-size: 11px; }

  .users-table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 12.5px; }
  .users-table thead th { padding: 10px 14px; text-align: left; color: var(--text-dim); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; border-bottom: 1px solid var(--border); }
  .users-table thead th.num { text-align: right; }
  .users-table thead th.sortable { cursor: pointer; user-select: none; white-space: nowrap; }
  .users-table thead th.sortable:hover { color: var(--text); }
  .users-table thead th.sorted { color: var(--indigo); }
  .users-table tbody td { padding: 10px 14px; color: var(--text-muted); border-bottom: 1px solid var(--border); font-variant-numeric: tabular-nums; }
  .users-table tbody td.num { text-align: right; font-family: 'JetBrains Mono',monospace; color: var(--text); }
  .users-table tbody tr:last-child td { border-bottom: 0; }
  .users-table tbody tr { transition: background 0.15s ease; }
  .users-table tbody tr:hover { background: rgba(255,255,255,0.02); }
  .device-id { font-family: 'JetBrains Mono',monospace; font-size: 11.5px; color: var(--text); cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
  .device-id .copy-icon { width: 12px; height: 12px; color: var(--text-dim); opacity: 0; transition: opacity 0.15s ease; }
  .device-id:hover .copy-icon { opacity: 1; }
  .device-id.copied .copy-icon { opacity: 1; color: var(--emerald); }
  .os-tag { display: inline-block; font-size: 10.5px; padding: 2px 7px; border-radius: 4px; font-weight: 600; }
  .os-tag.win { background: var(--sky-dim); color: var(--sky); }
  .os-tag.mac { background: var(--violet-dim); color: var(--violet); }
  .os-tag.linux { background: var(--amber-dim); color: var(--amber); }
  .ver-tag { display: inline-block; font-size: 11px; padding: 2px 7px; border-radius: 4px; background: rgba(255,255,255,0.05); color: var(--text-muted); font-family: 'JetBrains Mono',monospace; }
  .search-input { background: rgba(255,255,255,0.03); color: var(--text); border: 1px solid var(--border); border-radius: 7px; padding: 6px 11px; font-family: 'JetBrains Mono',monospace; font-size: 12px; width: 200px; }

  .loading { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; padding: 120px 0; color: var(--text-dim); }
  .spinner { width: 28px; height: 28px; border: 2.5px solid var(--border); border-top-color: var(--indigo); border-radius: 50%; animation: spin 0.7s linear infinite; }
  .empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 50px 0; color: var(--text-dim); }
  .empty-icon { width: 36px; height: 36px; color: var(--text-dim); opacity: 0.5; }
  .empty-text { font-size: 13px; }
  .error { text-align: center; padding: 80px 0; color: var(--rose); font-size: 14px; }
  .fade-in { animation: fadeIn 0.4s ease-out backwards; }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }

  @media (max-width: 1100px) { .kpis { grid-template-columns: repeat(2,1fr); } .minis { grid-template-columns: repeat(3,1fr); } .grid.three { grid-template-columns: 1fr; } }
  @media (max-width: 768px) { .container { padding: 24px 16px 48px; } .grid.two { grid-template-columns: 1fr; } .header { flex-direction: column; align-items: flex-start; } .kpi-value { font-size: 26px; } .minis { grid-template-columns: repeat(2,1fr); } }
  @media (max-width: 480px) { .kpis { grid-template-columns: 1fr; } .range button { padding: 5px 9px; font-size: 11px; } .section-nav button { padding: 10px 11px; font-size: 12.5px; } }
</style>
</head>
<body>
<div class="container">
  <div class="header fade-in">
    <div class="brand">
      <div class="brand-mark"><img src="/icon.png" alt="RikkaHub" onerror="this.style.display='none';this.parentElement.style.background='linear-gradient(135deg,#818cf8,#a78bfa)'"></div>
      <div class="brand-text">
        <div class="brand-name">RikkaHub 数据看板</div>
        <div class="brand-sub">用户增长 · 留存 · 参与度分析</div>
      </div>
    </div>
    <div class="toolbar">
      <div class="updated"><span class="live-dot"></span><span id="updated">--:--</span></div>
      <button class="icon-btn" id="refresh-btn" title="刷新"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg></button>
      <div class="range" id="range">
        <button data-d="7">7 天</button>
        <button data-d="14">14 天</button>
        <button data-d="30" class="active">30 天</button>
        <button data-d="90">90 天</button>
        <button data-d="180">180 天</button>
        <button data-d="all">全部</button>
        <button data-d="custom">自定义</button>
      </div>
      <div class="custom-range" id="custom-range">
        <input type="date" id="start-date"><span style="color:var(--text-dim)">→</span><input type="date" id="end-date">
        <button class="csv-btn" id="apply-custom">应用</button>
      </div>
    </div>
  </div>

  <div class="filterbar fade-in">
    <div class="filter-group">
      <span class="filter-label">用户群</span>
      <div class="seg" id="seg-seg">
        <button data-seg="all" class="active">全部</button>
        <button data-seg="new">本期新增</button>
        <button data-seg="returning">存量回访</button>
      </div>
    </div>
    <div class="filter-group">
      <span class="filter-label">系统</span>
      <div class="seg" id="os-seg">
        <button data-os="all" class="active">全部</button>
        <button data-os="win">Windows</button>
        <button data-os="linux">Linux</button>
        <button data-os="mac">macOS</button>
      </div>
    </div>
    <div class="filter-group">
      <span class="filter-label">版本</span>
      <select id="ver-select"><option value="all">全部版本</option></select>
    </div>
    <div class="filter-summary" id="filter-summary"></div>
  </div>

  <div class="section-nav">
    <button data-sec="overview" class="active">概览</button>
    <button data-sec="retention">留存</button>
    <button data-sec="users">用户</button>
    <button data-sec="platforms">平台</button>
    <button data-sec="quality">功能与质量</button>
  </div>

  <div id="content">
    <div class="loading"><div class="spinner"></div><div>正在加载数据…</div></div>
  </div>
</div>

<script nonce="__NONCE__">
// 正常流程 token 已被后端 302 剥离、改走 HttpOnly cookie;这里仅兜底直链场景。
const TOKEN = new URL(location.href).searchParams.get('token');
const BASE  = location.origin;
const CSV_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';

// ── 状态(URL hash 持久化)──
let currentDays = 30, currentOs = 'all', currentVer = 'all', currentSegment = 'all';
let currentStart = null, currentEnd = null;
let activeSection = 'overview', activeRetTab = 'new';
let showMA = false;          // 概览 DAU 趋势是否叠加 7 日均线
let showCmp = false;         // 概览 DAU 趋势是否叠加上一等长期间
let allVersions = null;      // 版本下拉缓存
let lastData = null;         // 供 CSV 导出复用
let retPages = { new: 0, week: 0, rolling: 0 };  // 留存三表各自的分页页码
const RET_PS = 30;           // 留存表每页条数
let userSort = { key: 'last_date', dir: -1 };    // 用户表排序状态
let userPage = 0;            // 用户表当前页
let userQuery = '';          // 用户表搜索词
const USER_PS = 15;          // 用户表每页条数

const fmt = n => (n ?? 0).toLocaleString('zh-CN');
const fmtPct = n => (n != null ? n + '%' : '—');
// HTML 转义:所有从库中读回再拼进 innerHTML 的动态值(version/os/device_id)都走它,
// 与 ping 端的白名单校验互为纵深防御,堵存储型 XSS。
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

function readHash() {
  const h = new URLSearchParams(location.hash.replace(/^#/, ''));
  const d = h.get('d');
  currentStart = h.get('start') || null;
  currentEnd = h.get('end') || null;
  if (currentStart && currentEnd) currentDays = 'custom';
  else if (d === 'all') currentDays = 'all';
  else currentDays = parseInt(d || '30', 10);
  currentOs = h.get('os') || 'all';
  currentVer = h.get('v') || 'all';
  currentSegment = h.get('seg') || 'all';
  activeSection = h.get('s') || 'overview';
}
function writeHash() {
  const p = new URLSearchParams();
  if (currentDays === 'custom') { p.set('start', currentStart); p.set('end', currentEnd); }
  else p.set('d', String(currentDays));
  p.set('os', currentOs); p.set('v', currentVer); p.set('seg', currentSegment); p.set('s', activeSection);
  location.hash = p.toString();
}

async function fetchData() {
  const p = new URLSearchParams({ os: currentOs, version: currentVer, segment: currentSegment });
  if (TOKEN) p.set('token', TOKEN);   // 无 token 时同源 fetch 自动携带鉴权 cookie
  if (currentDays === 'custom' && currentStart && currentEnd) { p.set('start', currentStart); p.set('end', currentEnd); }
  else p.set('days', String(currentDays));
  const r = await fetch(BASE + '/api/stats?' + p.toString());
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// ── 通用工具 ──
function pctDelta(cur, prev) {
  if (prev == null || prev === 0) return '<span class="delta flat">—</span>';
  const v = (cur - prev) / prev * 100;
  const cls = v > 0.5 ? 'up' : (v < -0.5 ? 'down' : 'flat');
  const ar = v > 0.5 ? '↑' : (v < -0.5 ? '↓' : '·');
  return '<span class="delta ' + cls + '">' + ar + ' ' + Math.abs(v).toFixed(1) + '%</span>';
}
function sparkline(values, color) {
  if (!values || values.length < 2) return '';
  const w = 88, h = 26, max = Math.max.apply(null, values), min = Math.min.apply(null, values);
  const range = (max - min) || 1;
  const pts = values.map((v, i) => { const x = (i/(values.length-1))*w; const y = h - ((v-min)/range)*(h-2) - 1; return x.toFixed(1)+','+y.toFixed(1); }).join(' ');
  const last = pts.split(' '); const lp = last[last.length-1].split(',');
  return '<svg width="'+w+'" height="'+h+'" class="kpi-spark"><polyline points="'+pts+'" fill="none" stroke="'+(color||'#818cf8')+'" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/><circle cx="'+lp[0]+'" cy="'+lp[1]+'" r="2" fill="'+(color||'#818cf8')+'"/></svg>';
}
function movingAvg(arr, win) {
  const out = []; for (let i = 0; i < arr.length; i++) { const s = Math.max(0, i-win+1); const slice = arr.slice(s, i+1); out.push(slice.reduce((a,b)=>a+b,0)/slice.length); } return out;
}
function hexA(hex, a) { const h = (hex||'').replace('#',''); const r=parseInt(h.slice(0,2),16),g=parseInt(h.slice(2,4),16),b=parseInt(h.slice(4,6),16); return 'rgba('+r+','+g+','+b+','+a+')'; }
function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z'); const day = (d.getUTCDay()+6)%7; d.setUTCDate(d.getUTCDate()-day); return d.toISOString().slice(0,10);
}
function weeklyCohorts(daily) {
  // 未满龄(null)的日 cohort 必须跳过、且分母只累计有值的样本——否则 null*size=0
  // 混进加权和、再除以全周规模,会把尚未到期的 D+14/D+30 显示成 0%,整周被拉低。
  const by = {};
  for (const c of daily) {
    const wk = mondayOf(c.date);
    if (!by[wk]) by[wk] = { week: wk, size: 0, sum: {}, wgt: {} };
    by[wk].size += (c.size||0);
    for (const o in c.retention) {
      const v = c.retention[o];
      if (v == null) continue;
      by[wk].sum[o] = (by[wk].sum[o]||0) + v*(c.size||0);
      by[wk].wgt[o] = (by[wk].wgt[o]||0) + (c.size||0);
    }
  }
  const out = [];
  for (const wk in by) {
    const w = by[wk]; const r = {};
    for (const o of [1,3,7,14,30]) r[o] = (w.wgt[o]||0) > 0 ? Math.round(w.sum[o]/w.wgt[o]) : null;
    out.push({ week: w.week, size: w.size, retention: r });
  }
  return out.sort((a,b) => a.week < b.week ? -1 : 1);
}
function retentionStyle(pct) {
  if (pct >= 60) return { bg: 'rgba(52,211,153,0.18)', color: '#6ee7b7' };
  if (pct >= 40) return { bg: 'rgba(52,211,153,0.12)', color: '#34d399' };
  if (pct >= 20) return { bg: 'rgba(251,191,36,0.14)', color: '#fbbf24' };
  if (pct > 0) return { bg: 'rgba(251,113,133,0.12)', color: '#fb7185' };
  return { bg: 'rgba(255,255,255,0.03)', color: '#71717a' };
}
function info(tip) { return ' <span class="info" title="' + tip + '">i</span>'; }
function emptyState(msg) { return '<div class="empty"><svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg><div class="empty-text">' + msg + '</div></div>'; }

function card(title, desc, legend, body, actions) {
  const lh = legend ? '<div class="card-legend">' + legend.map(l => '<div class="item"><div class="dot" style="background:'+l.color+'"></div>'+l.label+'</div>').join('') + '</div>' : '';
  const ah = actions ? '<div class="card-actions">' + actions + '</div>' : '';
  let s = '<div class="card fade-in"><div class="card-head"><div class="card-title"><h3>'+title+'</h3>'+(desc?'<div class="desc">'+desc+'</div>':'')+'</div>'+ah+lh+'</div>';
  s += body + '</div>';
  return s;
}

// ── 渲染:概览 ──
function renderOverview(d) {
  const t = d.trends || [];
  const today = t[t.length-1] || {};
  const ar = d.avgRetention || {};
  const churn = d.churn || {};

  // 本期净增 = 区间内新增设备之和(旧算法用 growth 数组下标对齐 trends,遇到无新增
  // 的日子会错位;trends 现已按日期补零,直接求和最准)。
  const netAdd = t.reduce((s,x)=>s+(x.new_users||0),0);

  let html = '<div class="section' + (activeSection==='overview'?' on':'') + '" id="sec-overview">';

  // KPI 卡:当日快照 + sparkline + 7 日均环比。
  // 不用"较昨日":今天是不完整天、且日活有天然星期波动,逐日对比噪音太大;
  // 近 7 天均值 vs 前 7 天均值才反映真实动量。
  const dauArr = t.map(x=>x.dau);
  const newArr = t.map(x=>x.new_users);
  const avgOf = a => a.length ? a.reduce((x,y)=>x+(y||0),0)/a.length : null;
  const dauCur7 = avgOf(dauArr.slice(-7)), dauPrev7 = t.length>=14 ? avgOf(dauArr.slice(-14,-7)) : null;
  const newCur7 = avgOf(newArr.slice(-7)), newPrev7 = t.length>=14 ? avgOf(newArr.slice(-14,-7)) : null;
  // 异常提示:昨日(最后一个完整天)明显低于其前 7 天均值时亮红。用昨日而非今日,
  // 避免"今天还没过完"造成的必然假警报;小基数(<5)不报,噪音太大。
  let dauWarn = '';
  if (t.length >= 9) {
    const yd = t[t.length-2].dau || 0;
    const baseArr = t.slice(-9, -2).map(x=>x.dau||0);
    const baseAvg = avgOf(baseArr);
    if (baseAvg != null && baseAvg >= 5 && yd < baseAvg * 0.6) {
      dauWarn = ' <span class="delta down" title="昨日日活 '+fmt(yd)+',而其前 7 日均值为 '+Math.round(baseAvg)+';跌幅超过 40%,建议排查更新推送/服务异常/统计中断。">⚠ 昨日 -'+Math.round((1-yd/baseAvg)*100)+'%</span>';
    }
  }
  html += '<div class="kpis">';
  html += kpi('当日日活', fmt(today.dau), '7 日均环比' + info('大数字是最新一天的活跃设备数(去重)。环比 = 近 7 天日均 vs 前 7 天日均,消除单日与星期波动。'), sparkline(dauArr,'#818cf8'), pctDelta(dauCur7, dauPrev7) + dauWarn);
  html += kpi('当日新增', fmt(today.new_users), '7 日均环比' + info('大数字是最新一天首次出现的设备数。环比口径同左。'), sparkline(newArr,'#f472b6'), pctDelta(newCur7, newPrev7));
  html += kpi('周活 / 月活', fmt(d.wau) + ' <span style="font-weight:400;color:var(--text-dim);font-size:18px"> / </span>' + fmt(d.mau), 'DAU/WAU ' + fmtPct(d.stickinessWau) + ' · DAU/MAU ' + fmtPct(d.stickinessMau) + info('周活=近 7 天、月活=近 30 天出现过的去重设备;DAU/MAU 即"粘性比",越高月内回访越频繁。'), '', '');
  const osVerFiltered = currentOs !== 'all' || currentVer !== 'all';
  const cumulativeSub = currentSegment !== 'all' ? '所选用户群设备数'
    : osVerFiltered ? '当前筛选群体 · 本期净增 ' + fmt(netAdd)
    : '本期净增 ' + fmt(netAdd);
  html += kpi('累计用户', fmt(d.totalUsers), cumulativeSub + info('历史出现过的不重复设备总数。系统/版本/用户群筛选下均变为该群体的设备数。'), '', '');
  html += '</div>';

  // 健康度二级指标
  const depthTotal = (d.depth&&(d.depth.b0||0)+(d.depth.b1_5||0)+(d.depth.b6_20||0)+(d.depth.b20p||0)) || 0;
  const powerPct = depthTotal ? Math.round((d.depth.b20p||0)/depthTotal*100) : null;
  // 使用时长/失败率(近 7 天,来自 qualityTrend;老客户端不上报时显示 —)
  const qt = (d.qualityTrend||[]).slice(-7);
  const durVals = qt.map(x=>x.avg_minutes).filter(v=>v!=null && v>0);
  const avgDur = durVals.length ? Math.round(durVals.reduce((a,b)=>a+b,0)/durVals.length) : null;
  const errSum = qt.reduce((s,x)=>s+(x.errs||0),0), msgSum = qt.reduce((s,x)=>s+(x.msgs||0),0);
  const errRate = (errSum+msgSum) > 0 && qt.some(x=>(x.errs||0)>0 || (x.msgs||0)>0) ? Math.round(errSum/(errSum+msgSum)*1000)/10 : null;
  html += '<div class="minis fade-in">';
  html += mini('次日留存', ar.d1!=null?ar.d1+'%':'—', '<span class="badge-tag">D+1</span> 新用户加权');
  html += mini('7 日留存', ar.d7!=null?ar.d7+'%':'—', '<span class="badge-tag">D+7</span> 新用户加权');
  html += mini('30 日留存', ar.d30!=null?ar.d30+'%':'—', '<span class="badge-tag">D+30</span> 新用户加权');
  html += mini('流失率', churn.churnRate!=null?churn.churnRate+'%':'—', churn.churned!=null?('近 7 天流失 '+churn.churned):'—');
  html += mini('复活用户', fmt(churn.resurrected||0), '近 7 天回流');
  html += mini('重度活跃日占比', powerPct!=null?powerPct+'%':'—', '<span class="badge-tag">>20 条/日</span>');
  html += mini('日均使用时长', avgDur!=null?(avgDur+' 分钟'):'—', avgDur!=null?'近 7 天 · 心跳估算':'等待新版客户端上报');
  html += mini('请求失败率', errRate!=null?(errRate+'%'):'—', errRate!=null?('近 7 天失败 '+fmt(errSum)+' 次'):'等待新版客户端上报');
  html += '</div>';

  // DAU 趋势(可叠加 7 日均线 / 上一期对比)
  const hasPrev = (d.prevTrends||[]).length > 0;
  const maToggle = '<label class="toggle"><input type="checkbox" id="ma-toggle" '+(showMA?'checked':'')+'><span>7 日均线</span></label>'
    + (hasPrev ? '<label class="toggle" style="margin-left:10px"><input type="checkbox" id="cmp-toggle" '+(showCmp?'checked':'')+'><span>对比上期</span></label>' : '');
  html += '<div class="grid full">';
  html += card('日活趋势', '日活与有效日活(发过消息)'+info('有效日活=当日发送≥1条消息的设备,排除仅启动未对话的。无数据的日子按 0 显示,服务中断一眼可见。"对比上期"叠加上一个等长时间窗的日活(灰色虚线,按天对齐)。'),
    [{label:'日活',color:'#818cf8'},{label:'有效日活',color:'#34d399'}].concat(showMA?[{label:'7日均',color:'#fbbf24'}]:[]).concat(showCmp&&hasPrev?[{label:'上期日活',color:'#71717a'}]:[]),
    '<div class="chart-wrap tall"><canvas id="dau-chart"></canvas></div>', maToggle);
  html += '</div>';

  // 新增 vs 回访 + 累计增长
  html += '<div class="grid two">';
  html += card('新增 vs 回访', '当日日活拆成新用户与回访存量'+info('回访=当日活跃且更早已出现过的设备;DAU=新增+回访。'),
    [{label:'新增',color:'#f472b6'},{label:'回访',color:'#38bdf8'}],
    '<div class="chart-wrap"><canvas id="split-chart"></canvas></div>');
  html += card('累计用户增长', '按设备首次出现日累计' + info('单调上升曲线;斜率反映拉新速度。'),
    null, (d.growth&&d.growth.length)?'<div class="chart-wrap"><canvas id="growth-chart"></canvas></div>':emptyState('无数据'));
  html += '</div>';

  // 增长会计:增长健康度的核心视图
  const ga = d.growthAccounting || [];
  html += '<div class="grid full">';
  html += card('增长会计(周)', '每周活跃用户 = 新增 + 复活 + 留存,减去流失' + info('Amplitude 式 Growth Accounting:正向柱是本周带来的用户(新增+复活),负向柱是上周活跃但本周没回来的流失;黄线为净变化。Quick Ratio=(新增+复活)/流失,>1 才在增长。带 * 的周尚未过完。'),
    [{label:'新增',color:'#f472b6'},{label:'复活',color:'#38bdf8'},{label:'流失',color:'#fb7185'},{label:'净变化',color:'#fbbf24'}],
    ga.length ? '<div class="chart-wrap"><canvas id="ga-chart"></canvas></div>' : emptyState('样本不足'));
  html += '</div>';

  // 粘性趋势 + 星期活跃模式
  const st = d.stickinessTrend || [];
  html += '<div class="grid two">';
  html += card('粘性趋势', 'DAU/WAU 与 DAU/MAU 逐日变化' + info('单点粘性数字看不出方向;这条线回答"用户回访频率是在改善还是恶化"。窗口上限 90 天。'),
    [{label:'DAU/WAU',color:'#34d399'},{label:'DAU/MAU',color:'#818cf8'}],
    st.length>=2 ? '<div class="chart-wrap"><canvas id="stick-chart"></canvas></div>' : emptyState('样本不足'));
  html += card('星期活跃模式', '所选区间各星期几的平均日活' + info('工作日 vs 周末的使用差异,指导发版与运营节奏。区间不足一周时参考意义有限。'),
    null, t.length>=7 ? '<div class="chart-wrap"><canvas id="dow-chart"></canvas></div>' : emptyState('区间不足 7 天'));
  html += '</div>';

  // 日均消息(人均) + 每日消息总量
  html += '<div class="grid two">';
  html += card('活跃用户日均消息', '当日消息总数 ÷ 有效日活' + info('每个发过消息的用户当天平均发多少条;反映单用户参与强度,比"全员均值"更准。'),
    null, '<div class="chart-wrap"><canvas id="avg-chart"></canvas></div>');
  html += card('每日消息总量', '所有活跃用户当日累计',
    null, '<div class="chart-wrap"><canvas id="msg-chart"></canvas></div>');
  html += '</div>';

  html += '</div>';
  return html;
}

function kpi(label, value, sub, spark, delta) {
  let s = '<div class="kpi"><div class="kpi-top"><div class="kpi-label">'+label+'</div></div>';
  s += '<div class="kpi-value">'+value+'</div>';
  s += spark;
  s += '<div class="kpi-foot">'+(delta||'')+'<span>'+sub+'</span></div></div>';
  return s;
}
function mini(label, value, sub) { return '<div class="mini"><div class="mini-label">'+label+'</div><div class="mini-value">'+value+'</div><div class="mini-sub">'+(sub||'')+'</div></div>'; }

// ── 渲染:留存 ──
function renderRetention(d) {
  const ar = d.avgRetention || {};
  const newC = (d.retention && d.retention.cohorts) || [];
  const rollC = (d.rollingRetention && d.rollingRetention.cohorts) || [];
  let html = '<div class="section' + (activeSection==='retention'?' on':'') + '" id="sec-retention">';

  // 留存衰减曲线(加权均值 D1/D3/D7/D14/D30)
  const segNote = currentSegment !== 'all' ? ' · 用户群筛选不影响留存(留存本身就是 cohort 分析)' : '';
  const curvePts = [[1,ar.d1],[3,ar.d3],[7,ar.d7],[14,ar.d14],[30,ar.d30]].filter(p=>p[1]!=null);
  html += '<div class="grid full">';
  html += card('留存衰减曲线', '新用户 cohort 在 D+N 的加权平均回访率' + segNote + info('把所有已满龄的新用户 cohort 按规模加权平均,得到一条整体留存衰减曲线,是衡量产品长期粘性的核心指标。'),
    null, curvePts.length>=2 ? '<div class="chart-wrap short"><canvas id="ret-curve"></canvas></div>' : emptyState('满龄 cohort 不足'));
  html += '</div>';

  // cohort 表(周维度 + 双视图 Tab)
  const weekly = weeklyCohorts(newC);
  const tabs = '<div class="tabs" id="ret-tabs">' +
    '<button data-tab="new" class="'+(activeRetTab==='new'?'active':'')+'">新用户 cohort(日)</button>' +
    '<button data-tab="week" class="'+(activeRetTab==='week'?'active':'')+'">新用户 cohort(周)</button>' +
    '<button data-tab="rolling" class="'+(activeRetTab==='rolling'?'active':'')+'">全量滚动留存</button></div>';
  const body =
    '<div id="rt-new" style="margin-top:10px;display:'+(activeRetTab==='new'?'block':'none')+'"><div id="ret-table-new">'+cohortTablePage(newC,[1,3,7,14,30],'日期','new')+'</div></div>' +
    '<div id="rt-week" style="margin-top:10px;display:'+(activeRetTab==='week'?'block':'none')+'"><div id="ret-table-week">'+(weekly.length?cohortTablePage(weekly.map(w=>({date:w.week,size:w.size,retention:w.retention})),[1,3,7,14,30],'周起始','week'):'<div class="empty"><div class="empty-text">样本不足</div></div>')+'</div></div>' +
    '<div id="rt-rolling" style="margin-top:10px;display:'+(activeRetTab==='rolling'?'block':'none')+'"><div id="ret-table-rolling">'+(rollC.length?cohortTablePage(rollC,[1,3,7,14,30],'日期','rolling'):'<div class="empty"><div class="empty-text">近期样本不足</div></div>')+'</div></div>' +
    '<div style="font-size:11px;color:var(--text-dim);margin-top:10px">全量滚动留存:cohort = 当日全部活跃设备(不限新用户),衡量存量粘性。其 base 本身就是"已留下来的活跃用户",数值天然高于新用户 cohort 留存,偏高属正常。</div>';
  html += '<div class="grid full">';
  html += card('留存矩阵', '不同 cohort 在 D+N 的回访率', null, body, tabs);
  html += '</div>';

  // 新用户首周参与质量:留存回答"回不回来",这张图回答"来的用户质量高不高"
  const cq = d.cohortQuality || [];
  html += '<div class="grid full">';
  html += card('新用户首周参与质量', '每周新增 cohort 首 7 天人均消息数' + info('衡量"最近拉来的用户质量是升是降":人均消息走低说明新客激活变差,走高说明拉新渠道/首启体验在改善。只统计已满龄(首周完整)的周,全量口径不受筛选影响。'),
    null, cq.length ? '<div class="chart-wrap short"><canvas id="cq-chart"></canvas></div>' : emptyState('满龄周 cohort 不足'));
  html += '</div>';

  html += '</div>';
  return html;
}
function cohortTablePage(cohorts, offsets, firstHead, tabKey) {
  if (!cohorts.length) return '<div class="empty"><div class="empty-text">无数据</div></div>';
  const totalPages = Math.max(1, Math.ceil(cohorts.length / RET_PS));
  const page = retPages[tabKey] || 0;
  const slice = cohorts.slice(page * RET_PS, page * RET_PS + RET_PS);
  const head = offsets.map(o => '<th>D+'+o+'</th>').join('');
  let t = '<table class="rtable"><thead><tr><th>'+firstHead+'</th><th>样本</th>'+head+'</tr></thead><tbody>';
  for (const c of slice) {
    t += '<tr><td>'+c.date+'</td><td>'+(c.size??0)+'</td>';
    for (const o of offsets) { const v = c.retention[o]; if (v==null) t += '<td><span class="ret-cell" style="background:rgba(255,255,255,0.02);color:var(--text-dim)">—</span></td>'; else { const s = retentionStyle(v); t += '<td><span class="ret-cell" style="background:'+s.bg+';color:'+s.color+'">'+v+'%</span></td>'; } }
    t += '</tr>';
  }
  t += '</tbody></table>';
  if (totalPages > 1) {
    t += '<div style="display:flex;align-items:center;justify-content:center;gap:12px;margin-top:10px;font-size:12px;color:var(--text-dim)">' +
      '<button class="csv-btn ret-pager" data-tab="'+tabKey+'" data-dir="-1"'+(page<=0?' disabled style="opacity:0.4"':'')+'>‹ 上一页</button>' +
      '<span>第 '+(page+1)+' / '+totalPages+' 页 · 共 '+cohorts.length+' 个 cohort</span>' +
      '<button class="csv-btn ret-pager" data-tab="'+tabKey+'" data-dir="1"'+(page>=totalPages-1?' disabled style="opacity:0.4"':'')+'>下一页 ›</button>' +
    '</div>';
  }
  return t;
}
// 翻页:从 lastData 重取当前 tab 的全部 cohort,渲染指定页(不重新 fetch)。
function retPager(tabKey, dir) {
  if (!lastData) return;
  let cohorts;
  if (tabKey === 'week') cohorts = weeklyCohorts(lastData.retention?.cohorts || []).map(w=>({date:w.week,size:w.size,retention:w.retention}));
  else if (tabKey === 'rolling') cohorts = lastData.rollingRetention?.cohorts || [];
  else cohorts = lastData.retention?.cohorts || [];
  const totalPages = Math.max(1, Math.ceil(cohorts.length / RET_PS));
  retPages[tabKey] = Math.max(0, Math.min(totalPages-1, (retPages[tabKey]||0) + dir));
  const wrap = document.getElementById('ret-table-' + tabKey);
  if (wrap) wrap.innerHTML = cohortTablePage(cohorts, [1,3,7,14,30], tabKey==='week'?'周起始':'日期', tabKey);
}
// 分页按钮用事件委托(绑一次 document,翻页重渲也自动生效),不用 inline onclick——
// 后者在 dashboardHtml 模板字符串里的引号转义会被模板吃掉一层,让前端语法错、整个 script 中断。
document.addEventListener('click', e => { const b = e.target.closest('.ret-pager'); if (b && !b.disabled) retPager(b.dataset.tab, parseInt(b.dataset.dir)); });

// 用户表交互也走事件委托(排序/翻页/复制都会触发局部重渲,逐元素绑定会丢)。
document.addEventListener('click', e => {
  const th = e.target.closest('#users-table th.sortable');
  if (th) {
    const k = th.dataset.key;
    if (userSort.key === k) userSort.dir = -userSort.dir;
    else userSort = { key: k, dir: (k==='device_id'||k==='os'||k==='version') ? 1 : -1 };
    userPage = 0; refreshUserTable(); return;
  }
  const pg = e.target.closest('.user-pager');
  if (pg && !pg.disabled) { userPage += parseInt(pg.dataset.dir); refreshUserTable(); return; }
  const dev = e.target.closest('.device-id');
  if (dev) {
    const f = dev.dataset.full; if (!f) return;
    navigator.clipboard?.writeText(f).then(() => { dev.classList.add('copied'); setTimeout(()=>dev.classList.remove('copied'),1200); }).catch(()=>{});
  }
});

// ── 渲染:用户 ──
function renderUsers(d) {
  const depth = d.depth || {};
  const pct = d.percentiles || {};
  const churn = d.churn || {};
  const users = d.recentUsers || [];
  const total = (depth.b0||0)+(depth.b1_5||0)+(depth.b6_20||0)+(depth.b20p||0);
  let html = '<div class="section' + (activeSection==='users'?' on':'') + '" id="sec-users">';

  // 流失/复活面板
  html += '<div class="grid three">';
  const churnRate = churn.churnRate;
  html += card('流失分析', '最近 7 天 vs 前 7 天' + info('retained=两窗都活跃;churned=前窗活跃最近未回;resurrected=最近活跃、前窗不在但更早出现过。'),
    null,
    '<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:14px;padding:6px 0">'+
      stat('前 7 天活跃', fmt(churn.prior||0))+
      stat('仍留存', fmt(churn.retained||0),'var(--emerald)')+
      stat('已流失', fmt(churn.churned||0),'var(--rose)')+
      stat('流失率', churnRate!=null?churnRate+'%':'—','var(--rose)')+
      stat('近 7 天活跃', fmt(churn.recent||0))+
      stat('其中复活', fmt(churn.resurrected||0),'var(--sky)')+
    '</div>');
  // 参与度分位
  html += card('参与度强度', '近 '+(d.trends||[]).length+' 天活跃用户' + info('中位数=P50,代表典型用户;P90=前 10% 重度用户;均值会被重度用户拉高。'),
    null, pct.count ?
    '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;padding:6px 0;text-align:center">'+
      big('中位数', fmt(pct.median),'var(--indigo)')+big('均值', fmt(pct.mean),'var(--violet)')+big('P90', fmt(pct.p90),'var(--amber)')+
    '</div><div style="font-size:11px;color:var(--text-dim);margin-top:8px">样本量 '+fmt(pct.count)+' 条/日记录</div>' :
    emptyState('无活跃样本'));
  // 会话深度
  html += card('会话深度', '近 7 天按"设备-日"记录的消息数分桶' + info('统计单位是设备×天(同一用户不同天各计一次),非去重设备;判断整体参与质量。'),
    null, total>0 ? '<div class="chart-wrap short"><canvas id="depth-chart"></canvas></div>' : emptyState('近 7 天无数据'),
    '<button class="csv-btn" id="csv-depth">'+CSV_ICON+'导出</button>');
  html += '</div>';

  // Power User Curve:活跃频次分布
  const pc = d.powerCurve || [];
  html += '<div class="grid full">';
  html += card('活跃频次分布(Power User Curve)', '近 30 天内活跃 N 天的设备各有多少' + info('横轴=近 30 天内的活跃天数,纵轴=设备数。右侧隆起(微笑曲线)说明存在一批高频核心用户;纯 L 型则多数人来一两天就走,留存工作优先级最高。'),
    null, pc.length ? '<div class="chart-wrap"><canvas id="power-chart"></canvas></div>' : emptyState('近 30 天无数据'));
  html += '</div>';

  // 用户列表(客户端排序 + 分页,数据集为最近活跃的前 500 台)
  const search = '<input class="search-input" id="user-search" placeholder="按设备 ID / 版本筛选…" value="'+esc(userQuery)+'">';
  const csv = '<button class="csv-btn" id="csv-users">'+CSV_ICON+'导出 CSV</button>';
  html += '<div class="grid full">';
  html += card('用户列表', '最近活跃的前 '+users.length+' 个设备 · 点表头可排序' + info('数据集为最近活跃的前 500 台设备;搜索与排序在此集合内进行。导出 CSV 会输出当前筛选与排序后的完整集合(非仅当前页)。'),
    null, '<div id="users-wrap">'+userTableHtml()+'</div>', search+csv);
  html += '</div>';

  html += '</div>';
  return html;
}

// 用户表:按当前搜索词过滤 + 当前排序键排序后的完整视图(供表格与 CSV 导出共用)。
function userView() {
  const users = (lastData && lastData.recentUsers) || [];
  const q = userQuery.trim().toLowerCase();
  const v = !q ? users.slice() : users.filter(u => ((u.device_id||'')+' '+(u.version||'')+' '+(u.os||'')).toLowerCase().indexOf(q) >= 0);
  const k = userSort.key, dir = userSort.dir;
  const num = (k === 'active_days' || k === 'total_msgs');
  v.sort((a,b) => { const x = a[k] ?? (num?0:''); const y = b[k] ?? (num?0:''); return x < y ? -dir : (x > y ? dir : 0); });
  return v;
}
function userTableHtml() {
  const v = userView();
  const totalPages = Math.max(1, Math.ceil(v.length / USER_PS));
  if (userPage > totalPages - 1) userPage = totalPages - 1;
  const slice = v.slice(userPage * USER_PS, userPage * USER_PS + USER_PS);
  const arrow = k => userSort.key === k ? (userSort.dir === 1 ? ' ↑' : ' ↓') : '';
  const th = (k, label, num) => '<th class="sortable'+(num?' num':'')+(userSort.key===k?' sorted':'')+'" data-key="'+k+'">'+label+arrow(k)+'</th>';
  let ut = '<table class="users-table" id="users-table"><thead><tr>'
    + th('device_id','设备 ID') + th('os','系统') + th('version','版本')
    + th('first_date','首次出现') + th('last_date','最近活跃')
    + th('active_days','活跃天数',true) + th('total_msgs','累计消息',true)
    + '</tr></thead><tbody>';
  for (const u of slice) {
    const short = (u.device_id||'').slice(0,8);
    const osL = u.os==='win'?'Windows':u.os==='mac'?'macOS':u.os==='linux'?'Linux':'—';
    const osC = u.os==='win'?'win':u.os==='mac'?'mac':u.os==='linux'?'linux':'';
    ut += '<tr>';
    ut += '<td><span class="device-id" data-full="'+esc(u.device_id)+'" title="点击复制完整 ID">'+esc(short)+'… <svg class="copy-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></span></td>';
    ut += '<td>'+(osL==='—'?'<span style="color:var(--text-dim)">—</span>':'<span class="os-tag '+osC+'">'+osL+'</span>')+'</td>';
    ut += '<td>'+(u.version?'<span class="ver-tag">'+esc(u.version)+'</span>':'<span style="color:var(--text-dim)">—</span>')+'</td>';
    ut += '<td>'+(u.first_date||'—')+'</td><td>'+(u.last_date||'—')+'</td>';
    ut += '<td class="num">'+(u.active_days||0)+'</td><td class="num">'+fmt(u.total_msgs||0)+'</td></tr>';
  }
  ut += '</tbody></table>';
  if (!slice.length) ut += '<div class="empty"><div class="empty-text">无匹配设备</div></div>';
  if (totalPages > 1) {
    ut += '<div style="display:flex;align-items:center;justify-content:center;gap:12px;margin-top:10px;font-size:12px;color:var(--text-dim)">'
      + '<button class="csv-btn user-pager" data-dir="-1"'+(userPage<=0?' disabled style="opacity:0.4"':'')+'>‹ 上一页</button>'
      + '<span>第 '+(userPage+1)+' / '+totalPages+' 页 · 共 '+v.length+' 台</span>'
      + '<button class="csv-btn user-pager" data-dir="1"'+(userPage>=totalPages-1?' disabled style="opacity:0.4"':'')+'>下一页 ›</button>'
    + '</div>';
  }
  return ut;
}
function refreshUserTable() { const w = document.getElementById('users-wrap'); if (w) w.innerHTML = userTableHtml(); }
function stat(label, value, color) { return '<div><div style="font-size:11px;color:var(--text-dim);margin-bottom:4px">'+label+'</div><div style="font-size:22px;font-weight:700;font-variant-numeric:tabular-nums;color:'+(color||'var(--text)')+'">'+value+'</div></div>'; }

// 版本号按数字段语义比较(1.10.0 > 1.9.9),取 versionTrend 最近一日里最大的版本算份额。
function latestVerShare(vt) {
  if (!vt || !vt.length) return null;
  const lastDate = vt[vt.length-1].date;
  const rows = vt.filter(r => r.date === lastDate && r.version);
  const total = rows.reduce((s,r)=>s+(r.c||0),0);
  if (!total) return null;
  const segs = v => String(v||'').split(/[.+\\- ]/).map(x => parseInt(x,10)||0);
  const cmp = (a,b) => { const A=segs(a),B=segs(b); for (let i=0;i<Math.max(A.length,B.length);i++){ const d=(A[i]||0)-(B[i]||0); if (d) return d; } return 0; };
  let top = rows[0].version;
  for (const r of rows) if (cmp(r.version, top) > 0) top = r.version;
  const c = rows.filter(r=>r.version===top).reduce((s,r)=>s+(r.c||0),0);
  return { version: top, pct: Math.round(c/total*100) };
}
function big(label, value, color) { return '<div><div style="font-size:11px;color:var(--text-dim);margin-bottom:4px">'+label+'</div><div style="font-size:24px;font-weight:700;font-variant-numeric:tabular-nums;color:'+(color||'var(--text)')+'">'+value+'</div></div>'; }

// ── 渲染:平台 ──
function renderPlatforms(d) {
  const t = d.trends || [];
  const today = t[t.length-1] || {};
  const versions = d.versions || [];
  const vt = d.versionTrend || [];
  let html = '<div class="section' + (activeSection==='platforms'?' on':'') + '" id="sec-platforms">';

  const od = d.osDist || {};
  const hasOs = (od.win||0)+(od.mac||0)+(od.linux||0)+(od.other||0) > 0;
  html += '<div class="grid two">';
  html += card('系统 DAU 趋势', '各系统日活叠加对比' + info('把 Windows/Linux/macOS 当日活跃画在同一坐标系,直观对比体量与趋势。'),
    [{label:'Windows',color:'#38bdf8'},{label:'Linux',color:'#fbbf24'},{label:'macOS',color:'#a78bfa'}],
    hasOs ? '<div class="chart-wrap"><canvas id="os-trend-chart"></canvas></div>' : emptyState('暂无系统数据'));
  html += card('系统分布', '全部用户(按各自最新一次上报)',
    null, hasOs ? '<div class="chart-wrap"><canvas id="os-pie"></canvas></div>' : emptyState('暂无系统数据'));
  html += '</div>';

  // 最新版本(语义化比较取最大)在最近一日 DAU 中的占比 —— 升级触达速度的一句话总结
  const lvs = latestVerShare(vt);
  const lvsTxt = lvs ? ' · 最新 ' + esc(lvs.version) + ' 占当日 DAU ' + lvs.pct + '%' : '';
  html += '<div class="grid two">';
  html += card('版本采用曲线', '近 30 天每日每版本 DAU' + lvsTxt + info('堆叠面积图,反映新版本发布后的滚动升级速度;此图不受筛选影响。'),
    null, vt.length ? '<div class="chart-wrap tall"><canvas id="ver-trend-chart"></canvas></div>' : emptyState('无数据'));
  html += card('版本分布', '全部用户的最新版本',
    null, versions.length ? '<div class="chart-wrap"><canvas id="ver-pie"></canvas></div>' : emptyState('暂无版本数据'));
  html += '</div>';

  // 地区分布(CF 边缘国家码,不存 IP)
  const cd = (d.countryDist||[]).filter(x=>x.count>0);
  const hasGeo = cd.some(x=>x.country);
  html += '<div class="grid two">';
  html += card('地区分布', '全部用户(按各自最新一次上报的接入国家)' + info('国家码由 Cloudflare 边缘节点判定,不采集、不存储 IP;老数据无国家码,归入"未知"。'),
    null, hasGeo ? '<div class="chart-wrap"><canvas id="geo-pie"></canvas></div>' : emptyState('暂无地区数据(等待部署后新上报)'));
  html += card('Top 10 地区', '按用户数排序',
    null, hasGeo ? '<div class="chart-wrap"><canvas id="geo-bar"></canvas></div>' : emptyState('暂无地区数据'));
  html += '</div>';

  html += '</div>';
  return html;
}

// ── 渲染:功能与质量 ──
function renderQuality(d) {
  const fu = d.featureUse || {};
  const qt = d.qualityTrend || [];
  const featTotal = (fu.search||0)+(fu.tts||0)+(fu.mcp||0)+(fu.img||0);
  const hasQuality = qt.some(x=>(x.errs||0)>0 || x.avg_minutes!=null);
  const waitNote = '等待新版客户端上报(功能/时长/失败遥测随下一个发布版本生效)';
  let html = '<div class="section' + (activeSection==='quality'?' on':'') + '" id="sec-quality">';

  html += '<div class="grid two">';
  html += card('功能使用度(近 7 天)', '各功能"当日至少用过一次"的去重设备数' + info('分母 base = 近 7 天活跃设备;对话=发过消息。老客户端不上报功能计数,数字会低估,新版本覆盖率上来后才可比。'),
    null, (fu.base>0 && (featTotal>0 || fu.chat>0)) ? '<div class="chart-wrap"><canvas id="feat-chart"></canvas></div>' : emptyState(fu.base>0?waitNote:'近 7 天无数据'));
  html += card('日均使用时长', '有心跳上报设备的当日平均在线分钟数(心跳 × 10 分钟估算)' + info('客户端每 10 分钟一跳,时长=跳数×10,粒度粗但趋势可靠;仅统计新版客户端。'),
    null, qt.some(x=>x.avg_minutes!=null) ? '<div class="chart-wrap"><canvas id="dur-chart"></canvas></div>' : emptyState(waitNote));
  html += '</div>';

  html += '<div class="grid full">';
  html += card('请求失败率趋势', '每日 provider 失败数 ÷(失败数 + 消息数)' + info('失败=非用户中断的请求错误(网络/鉴权/限流等)。失败率抬头往往先于用户流失,是最值得盯的质量信号。老客户端不上报失败数,初期数值偏低。'),
    null, hasQuality ? '<div class="chart-wrap"><canvas id="err-chart"></canvas></div>' : emptyState(waitNote));
  html += '</div>';

  html += '</div>';
  return html;
}

// ISO 国家码转中文名(浏览器 Intl 自带,失败回退原码)。
function countryName(cc) {
  if (!cc) return '未知';
  try { return new Intl.DisplayNames(['zh-CN'], { type: 'region' }).of(cc) || cc; } catch (e) { return cc; }
}

// ── 主渲染 ──
function render(d) {
  lastData = d;
  retPages = { new: 0, week: 0, rolling: 0 };  // 新数据,分页回首页
  userPage = 0;
  const overview = renderOverview(d);
  const retention = renderRetention(d);
  const users = renderUsers(d);
  const platforms = renderPlatforms(d);
  const quality = renderQuality(d);
  document.getElementById('content').innerHTML = overview + retention + users + platforms + quality;
  drawCharts(d);
  bindDynamic();
  syncSummary(d);
}

function syncSummary(d) {
  const f = d.filter || {};
  const segTxt = f.segment === 'new' ? '本期新增' : f.segment === 'returning' ? '存量回访' : '全部用户';
  const osTxt = f.os && f.os!=='all' ? ({win:'Windows',linux:'Linux',mac:'macOS'}[f.os]) : '全部系统';
  const verTxt = f.version && f.version!=='all' ? f.version : '全部版本';
  const rangeTxt = (f.range === 'all') ? '全部历史' : (f.range === 'custom' ? '自定义' : ('近 ' + (d.trends||[]).length + ' 天'));
  document.getElementById('filter-summary').textContent = segTxt + ' · ' + osTxt + ' · ' + verTxt + ' · ' + rangeTxt + ' · 截至 ' + (f.asOf || '—');
  document.getElementById('updated').textContent = new Date().toTimeString().slice(0,8) + ' 已更新';
  // 版本下拉:后端 versions 现在是"全量用户最新版本"快照(不叠任何筛选),每次返回都是
  // 稳定全集,取更长的那份缓存即可。修掉旧逻辑"仅全部+全部时才填充"导致带 v= 刷新时
  // 下拉卡死、永远只剩"全部版本"且实际数据被筛着的 bug。
  if (d.versions && d.versions.length && (!allVersions || d.versions.length > allVersions.length)) allVersions = d.versions;
  populateVersionSelect();
}

// ── 图表 ──
function destroyAllCharts() {
  // 重新渲染或切换章节时,canvas 可能已绑定旧 Chart 实例,不先 destroy 会抛
  // "Canvas is already in use"。全量清理一遍最稳妥。
  document.querySelectorAll('canvas').forEach(c => { const ch = Chart.getChart(c); if (ch) ch.destroy(); });
}
function drawCharts(d) {
  destroyAllCharts();
  const t = d.trends || [];
  const labels = t.map(x => x.date.slice(5).replace('-','/'));
  const fam = "'Inter','JetBrains Mono','Noto Sans SC',sans-serif";
  const base = {
    responsive: true, maintainAspectRatio: false,
    interaction: { intersect: false, mode: 'index' },
    plugins: { legend: { display: false }, tooltip: { backgroundColor: 'rgba(20,20,30,0.95)', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1, padding: 12, boxPadding: 6, titleColor: '#fafafa', bodyColor: '#a1a1aa', titleFont: { family: fam, weight: 600, size: 12 }, bodyFont: { family: fam, size: 12 }, cornerRadius: 8 } },
    scales: {
      x: { ticks: { color: '#71717a', font: { family: fam, size: 10.5 }, maxRotation: 0, padding: 8 }, grid: { display: false }, border: { display: false } },
      y: { ticks: { color: '#71717a', font: { family: fam, size: 10.5 }, padding: 8 }, grid: { color: 'rgba(255,255,255,0.04)', drawTicks: false }, border: { display: false }, beginAtZero: true },
    },
  };
  const donutOpts = (extra) => ({ responsive: true, maintainAspectRatio: false, cutout: '62%', plugins: { legend: { position: 'right', labels: { color: '#a1a1aa', font: { family: fam, size: 12 }, usePointStyle: true, pointStyle: 'circle', padding: 12, boxWidth: 8 } }, tooltip: base.plugins.tooltip }, ...(extra||{}) });

  // 概览
  if (activeSection === 'overview') {
    const dauC = document.getElementById('dau-chart');
    if (dauC) {
      const ctx = dauC.getContext('2d');
      const g1 = ctx.createLinearGradient(0,0,0,320); g1.addColorStop(0,'rgba(129,140,248,0.25)'); g1.addColorStop(1,'rgba(129,140,248,0)');
      const g2 = ctx.createLinearGradient(0,0,0,320); g2.addColorStop(0,'rgba(52,211,153,0.20)'); g2.addColorStop(1,'rgba(52,211,153,0)');
      const sets = [
        { label:'日活', data: t.map(x=>x.dau), borderColor:'#818cf8', backgroundColor:g1, fill:true, tension:0.35, pointRadius:0, pointHoverRadius:5, borderWidth:2 },
        { label:'有效日活', data: t.map(x=>x.eff_dau), borderColor:'#34d399', backgroundColor:g2, fill:true, tension:0.35, pointRadius:0, pointHoverRadius:5, borderWidth:2 },
      ];
      if (showMA) sets.push({ label:'7日均', data: movingAvg(t.map(x=>x.dau),7), borderColor:'#fbbf24', borderDash:[5,4], fill:false, tension:0.3, pointRadius:0, borderWidth:1.5 });
      if (showCmp && d.prevTrends && d.prevTrends.length) {
        // 按索引对齐:上一期第 i 天对应本期第 i 天(等长窗口,后端保证)
        sets.push({ label:'上期日活', data: d.prevTrends.map(x=>x.dau||0), borderColor:'#71717a', borderDash:[4,4], fill:false, tension:0.3, pointRadius:0, borderWidth:1.5 });
      }
      new Chart(dauC, { type:'line', data:{ labels, datasets: sets }, options: base });
    }
    const splitC = document.getElementById('split-chart');
    if (splitC) new Chart(splitC, { type:'bar', data:{ labels, datasets:[
      { label:'新增', data:t.map(x=>x.new_users), backgroundColor:'rgba(244,114,182,0.75)', stack:'a', borderRadius:3, barPercentage:0.7, categoryPercentage:0.75 },
      { label:'回访', data:t.map(x=>x.returning_users), backgroundColor:'rgba(56,189,248,0.75)', stack:'a', borderRadius:3, barPercentage:0.7, categoryPercentage:0.75 },
    ]}, options: { ...base, scales: { ...base.scales, x:{...base.scales.x, stacked:true}, y:{...base.scales.y, stacked:true} } } });
    const growC = document.getElementById('growth-chart');
    if (growC && d.growth && d.growth.length) {
      const g = d.growth; const ctx = growC.getContext('2d'); const grad = ctx.createLinearGradient(0,0,0,280); grad.addColorStop(0,'rgba(167,139,250,0.28)'); grad.addColorStop(1,'rgba(167,139,250,0)');
      const step = Math.max(1, Math.ceil(g.length/12));
      new Chart(growC, { type:'line', data:{ labels:g.map(p=>p.date.slice(5).replace('-','/')), datasets:[{ label:'累计', data:g.map(p=>p.total), borderColor:'#a78bfa', backgroundColor:grad, fill:true, tension:0.3, pointRadius:0, pointHoverRadius:4, borderWidth:2 }] }, options:{ ...base, scales:{ ...base.scales, x:{ ...base.scales.x, ticks:{ ...base.scales.x.ticks, callback:function(v,i){ return i%step===0?this.getLabelForValue(v):''; } } } } } });
    }
    const gaC = document.getElementById('ga-chart');
    if (gaC && d.growthAccounting && d.growthAccounting.length) {
      const ga = d.growthAccounting;
      const gaLabels = ga.map(w => w.week.slice(5).replace('-','/') + (w.partial ? '*' : ''));
      new Chart(gaC, { type:'bar', data:{ labels: gaLabels, datasets:[
        { type:'bar', label:'新增', data: ga.map(w=>w.newUsers||0), backgroundColor:'rgba(244,114,182,0.75)', stack:'g', borderRadius:3 },
        { type:'bar', label:'复活', data: ga.map(w=>w.resurrected||0), backgroundColor:'rgba(56,189,248,0.75)', stack:'g', borderRadius:3 },
        { type:'bar', label:'流失', data: ga.map(w=>-(w.churned||0)), backgroundColor:'rgba(251,113,133,0.65)', stack:'g', borderRadius:3 },
        { type:'line', label:'净变化', data: ga.map(w=>(w.newUsers||0)+(w.resurrected||0)-(w.churned||0)), borderColor:'#fbbf24', backgroundColor:'transparent', tension:0.3, pointRadius:2.5, borderWidth:2 },
      ]}, options:{ ...base,
        scales:{ ...base.scales, x:{...base.scales.x, stacked:true}, y:{...base.scales.y, stacked:true, beginAtZero:false} },
        plugins:{ ...base.plugins, tooltip:{ ...base.plugins.tooltip, callbacks:{
          label: ctx => ctx.dataset.label + ': ' + Math.abs(ctx.parsed.y),
          footer: items => { const w = ga[items[0].dataIndex]; return 'Quick Ratio: ' + (w.quickRatio!=null?w.quickRatio:'—') + (w.partial?'(本周未结束)':''); },
        } } } } });
    }
    const stickC = document.getElementById('stick-chart');
    if (stickC && d.stickinessTrend && d.stickinessTrend.length >= 2) {
      const st = d.stickinessTrend;
      new Chart(stickC, { type:'line', data:{ labels: st.map(x=>x.date.slice(5).replace('-','/')), datasets:[
        { label:'DAU/WAU', data: st.map(x=>x.dauWau), borderColor:'#34d399', backgroundColor:'transparent', tension:0.35, pointRadius:0, pointHoverRadius:4, borderWidth:2 },
        { label:'DAU/MAU', data: st.map(x=>x.dauMau), borderColor:'#818cf8', backgroundColor:'transparent', tension:0.35, pointRadius:0, pointHoverRadius:4, borderWidth:2 },
      ]}, options:{ ...base, scales:{ ...base.scales, y:{ ...base.scales.y, max:100, ticks:{ ...base.scales.y.ticks, callback:v=>v+'%' } } } } });
    }
    const dowC = document.getElementById('dow-chart');
    if (dowC && t.length >= 7) {
      const sums=[0,0,0,0,0,0,0], cnts=[0,0,0,0,0,0,0];
      for (const x of t) { const wd=(new Date(x.date+'T00:00:00Z').getUTCDay()+6)%7; sums[wd]+=(x.dau||0); cnts[wd]++; }
      const avgs = sums.map((s,i)=>cnts[i]>0?Math.round(s/cnts[i]*10)/10:0);
      const dowColors = ['#818cf8','#818cf8','#818cf8','#818cf8','#818cf8','#a78bfa','#a78bfa'];
      new Chart(dowC, { type:'bar', data:{ labels:['周一','周二','周三','周四','周五','周六','周日'], datasets:[{ label:'平均日活', data:avgs, backgroundColor:dowColors.map(c=>hexA(c,0.7)), borderRadius:4, barPercentage:0.7 }] }, options: base });
    }
    const avgC = document.getElementById('avg-chart');
    if (avgC) {
      const ctx = avgC.getContext('2d'); const grad = ctx.createLinearGradient(0,0,0,280); grad.addColorStop(0,'rgba(167,139,250,0.25)'); grad.addColorStop(1,'rgba(167,139,250,0)');
      const avgPerDay = t.map(x => { const eff = x.eff_dau||0; return eff>0 ? Math.round((x.total_msgs||0)/eff*10)/10 : 0; });
      new Chart(avgC, { type:'line', data:{ labels, datasets:[{ label:'人均消息', data: avgPerDay, borderColor:'#a78bfa', backgroundColor:grad, fill:true, tension:0.35, pointRadius:0, pointHoverRadius:5, borderWidth:2 }] }, options: base });
    }
    const msgC = document.getElementById('msg-chart');
    if (msgC) new Chart(msgC, { type:'bar', data:{ labels, datasets:[{ label:'消息', data:t.map(x=>x.total_msgs), backgroundColor:'rgba(56,189,248,0.7)', borderRadius:4, barPercentage:0.7, categoryPercentage:0.75 }] }, options: base });
  }

  // 留存
  if (activeSection === 'retention') {
    const rc = document.getElementById('ret-curve');
    if (rc) {
      const ar = d.avgRetention || {};
      const pts = [[1,ar.d1],[3,ar.d3],[7,ar.d7],[14,ar.d14],[30,ar.d30]].filter(p=>p[1]!=null);
      const ctx = rc.getContext('2d'); const grad = ctx.createLinearGradient(0,0,0,220); grad.addColorStop(0,'rgba(167,139,250,0.25)'); grad.addColorStop(1,'rgba(167,139,250,0)');
      // X 轴用 linear(按真实天数),避免 D+1/3/7/14/30 在分类轴等距渲染、衰减尾巴被压扁。
      new Chart(rc, { type:'line', data:{ datasets:[{ label:'留存率', data: pts.map(p=>({x:p[0], y:p[1]})), borderColor:'#a78bfa', backgroundColor:grad, fill:true, tension:0.35, pointRadius:4, pointHoverRadius:6, borderWidth:2.5 }] }, options:{ ...base, scales:{ x:{ type:'linear', title:{ display:true, text:'距首次使用天数', color:'#71717a', font:{ family:fam, size:10.5 } }, ticks:{ color:'#71717a', font:{ family:fam, size:10.5 }, stepSize:1, callback:v=>'D+'+v } }, y:{ ...base.scales.y, max:100, ticks:{ ...base.scales.y.ticks, callback:v=>v+'%' } } }, plugins:{ ...base.plugins, tooltip:{ ...base.plugins.tooltip, callbacks:{ label: ctx => 'D+'+ctx.parsed.x+' 留存 '+ctx.parsed.y+'%' } } } } });
    }
    const cqC = document.getElementById('cq-chart');
    if (cqC && d.cohortQuality && d.cohortQuality.length) {
      const cq = d.cohortQuality;
      new Chart(cqC, { type:'bar', data:{ labels: cq.map(x=>x.week.slice(5).replace('-','/')), datasets:[
        { label:'首周人均消息', data: cq.map(x=>x.msgs_per_user||0), backgroundColor:'rgba(167,139,250,0.7)', borderRadius:4, barPercentage:0.6 },
      ]}, options:{ ...base, plugins:{ ...base.plugins, tooltip:{ ...base.plugins.tooltip, callbacks:{
        footer: items => 'cohort 规模: ' + (cq[items[0].dataIndex].size||0) + ' 台设备',
      } } } } });
    }
  }

  // 用户
  if (activeSection === 'users') {
    const depthC = document.getElementById('depth-chart');
    if (depthC && d.depth) { const dd = d.depth; new Chart(depthC, { type:'bar', data:{ labels:['0 条','1–5','6–20','20+'], datasets:[{ data:[dd.b0||0,dd.b1_5||0,dd.b6_20||0,dd.b20p||0], backgroundColor:['rgba(113,113,122,0.6)','rgba(251,191,36,0.7)','rgba(52,211,153,0.7)','rgba(129,140,248,0.85)'], borderRadius:4, barPercentage:0.7 }] }, options:{ ...base, indexAxis:'y', scales:{ x: base.scales.y, y:{ ticks:{ color:'#a1a1aa', font:{ family:fam, size:11 }, padding:8 }, grid:{ display:false }, border:{ display:false } } } } }); }
    const powerC = document.getElementById('power-chart');
    if (powerC && d.powerCurve && d.powerCurve.length) {
      // 补齐 1..30 全部横轴(查询只返回有设备的天数档);≥15 天的档位换绿色突出核心用户
      const byDays = {};
      for (const r of d.powerCurve) byDays[r.days] = r.devices || 0;
      const labels = []; const vals = []; const colors = [];
      for (let i = 1; i <= 30; i++) { labels.push(i + ' 天'); vals.push(byDays[i]||0); colors.push(i >= 15 ? 'rgba(52,211,153,0.75)' : 'rgba(129,140,248,0.7)'); }
      new Chart(powerC, { type:'bar', data:{ labels, datasets:[{ label:'设备数', data: vals, backgroundColor: colors, borderRadius:3, barPercentage:0.8, categoryPercentage:0.85 }] }, options: base });
    }
  }

  // 平台
  if (activeSection === 'platforms') {
    const osTrend = document.getElementById('os-trend-chart');
    if (osTrend && t.length) new Chart(osTrend, { type:'line', data:{ labels, datasets:[
      { label:'Windows', data:t.map(x=>x.win_users||0), borderColor:'#38bdf8', backgroundColor:'transparent', tension:0.3, pointRadius:0, pointHoverRadius:4, borderWidth:2 },
      { label:'Linux', data:t.map(x=>x.linux_users||0), borderColor:'#fbbf24', backgroundColor:'transparent', tension:0.3, pointRadius:0, pointHoverRadius:4, borderWidth:2 },
      { label:'macOS', data:t.map(x=>x.mac_users||0), borderColor:'#a78bfa', backgroundColor:'transparent', tension:0.3, pointRadius:0, pointHoverRadius:4, borderWidth:2 },
    ]}, options: base });
    const osPie = document.getElementById('os-pie');
    const od = d.osDist || {};
    const osData = [{label:'Windows',value:od.win||0,color:'#38bdf8'},{label:'macOS',value:od.mac||0,color:'#a78bfa'},{label:'Linux',value:od.linux||0,color:'#fbbf24'},{label:'其他',value:od.other||0,color:'#71717a'}].filter(x=>x.value>0);
    if (osPie && osData.length) new Chart(osPie, { type:'doughnut', data:{ labels:osData.map(x=>x.label), datasets:[{ data:osData.map(x=>x.value), backgroundColor:osData.map(x=>x.color), borderWidth:0, hoverOffset:8 }] }, options: donutOpts() });
    const verTrend = document.getElementById('ver-trend-chart');
    if (verTrend && d.versionTrend && d.versionTrend.length) {
      // pivot date×version,取总量前 6 版本,其余合并"其他"
      // 堆叠面积:dataset 带 stack + scales.y.stacked 才能纵向累加(旧版无 stack,各版本
      // 都从 0 填半透明面积互相遮挡,看不出升级进度)。lookup 把 {date|ver: c} 建一次,
      // 替代 dates×top×find 的 O(n²) 查找。
      const byVer = {};
      const lookup = {};
      for (const r of d.versionTrend) {
        const v = r.version || '(unknown)';
        byVer[v] = (byVer[v]||0) + (r.c||0);
        lookup[r.date + '|' + v] = r.c || 0;
      }
      const top = Object.keys(byVer).sort((a,b)=>byVer[b]-byVer[a]).slice(0,6);
      const dates = []; const seen = {};
      for (const r of d.versionTrend) { if (!seen[r.date]) { seen[r.date]=1; dates.push(r.date); } }
      const palette = ['#818cf8','#34d399','#fbbf24','#fb7185','#38bdf8','#a78bfa','#71717a'];
      const datasets = top.map((v,i) => ({ label:v, stack:'ver', data: dates.map(dt => lookup[dt + '|' + v] || 0), backgroundColor: hexA(palette[i],0.55), borderColor: palette[i], fill:true, tension:0.3, pointRadius:0, borderWidth:1.2 }));
      new Chart(verTrend, { type:'line', data:{ labels: dates.map(x=>x.slice(5).replace('-','/')), datasets }, options: { ...base, scales: { ...base.scales, x:{...base.scales.x, stacked:true}, y:{...base.scales.y, stacked:true} } } });
    }
    const verPie = document.getElementById('ver-pie');
    if (verPie && d.versions && d.versions.length) { const pal = ['#818cf8','#34d399','#fbbf24','#fb7185','#38bdf8','#a78bfa','#f472b6','#fb923c']; new Chart(verPie, { type:'doughnut', data:{ labels: d.versions.map(v=>esc(v.version)||'未知'), datasets:[{ data:d.versions.map(v=>v.count), backgroundColor:pal.slice(0,d.versions.length), borderWidth:0, hoverOffset:8 }] }, options: donutOpts() }); }
    const cd = (d.countryDist||[]).filter(x=>x.count>0);
    if (cd.some(x=>x.country)) {
      const pal = ['#818cf8','#34d399','#fbbf24','#fb7185','#38bdf8','#a78bfa','#f472b6','#fb923c','#71717a'];
      const top = cd.slice(0, 8);
      const rest = cd.slice(8).reduce((s,x)=>s+x.count,0);
      const geoData = top.map(x=>({ label: countryName(x.country), value: x.count })).concat(rest>0?[{label:'其他',value:rest}]:[]);
      const geoPie = document.getElementById('geo-pie');
      if (geoPie) new Chart(geoPie, { type:'doughnut', data:{ labels: geoData.map(x=>x.label), datasets:[{ data: geoData.map(x=>x.value), backgroundColor: pal.slice(0, geoData.length), borderWidth:0, hoverOffset:8 }] }, options: donutOpts() });
      const geoBar = document.getElementById('geo-bar');
      const top10 = cd.filter(x=>x.country).slice(0, 10);
      if (geoBar && top10.length) new Chart(geoBar, { type:'bar', data:{ labels: top10.map(x=>countryName(x.country)), datasets:[{ label:'用户数', data: top10.map(x=>x.count), backgroundColor:'rgba(129,140,248,0.7)', borderRadius:4, barPercentage:0.7 }] }, options:{ ...base, indexAxis:'y', scales:{ x: base.scales.y, y:{ ticks:{ color:'#a1a1aa', font:{ family:fam, size:11 }, padding:8 }, grid:{ display:false }, border:{ display:false } } } } });
    }
  }

  // 功能与质量
  if (activeSection === 'quality') {
    const fu = d.featureUse || {};
    const featC = document.getElementById('feat-chart');
    if (featC && fu.base > 0) {
      const items = [
        { label:'对话', v: fu.chat||0, color:'rgba(129,140,248,0.8)' },
        { label:'联网搜索', v: fu.search||0, color:'rgba(52,211,153,0.75)' },
        { label:'MCP 工具', v: fu.mcp||0, color:'rgba(251,191,36,0.75)' },
        { label:'图像生成', v: fu.img||0, color:'rgba(244,114,182,0.75)' },
        { label:'TTS 朗读', v: fu.tts||0, color:'rgba(56,189,248,0.75)' },
      ];
      new Chart(featC, { type:'bar', data:{ labels: items.map(x=>x.label), datasets:[{ label:'使用设备数', data: items.map(x=>x.v), backgroundColor: items.map(x=>x.color), borderRadius:4, barPercentage:0.7 }] },
        options:{ ...base, indexAxis:'y',
          scales:{ x: base.scales.y, y:{ ticks:{ color:'#a1a1aa', font:{ family:fam, size:11 }, padding:8 }, grid:{ display:false }, border:{ display:false } } },
          plugins:{ ...base.plugins, tooltip:{ ...base.plugins.tooltip, callbacks:{ label: ctx => ctx.parsed.x + ' 台 · 占活跃 ' + (fu.base>0?Math.round(ctx.parsed.x/fu.base*100):0) + '%' } } } } });
    }
    const qt = d.qualityTrend || [];
    const qLabels = qt.map(x=>x.date.slice(5).replace('-','/'));
    const durC = document.getElementById('dur-chart');
    if (durC && qt.some(x=>x.avg_minutes!=null)) {
      const ctx = durC.getContext('2d'); const grad = ctx.createLinearGradient(0,0,0,280); grad.addColorStop(0,'rgba(52,211,153,0.22)'); grad.addColorStop(1,'rgba(52,211,153,0)');
      new Chart(durC, { type:'line', data:{ labels: qLabels, datasets:[{ label:'日均分钟', data: qt.map(x=>x.avg_minutes), borderColor:'#34d399', backgroundColor:grad, fill:true, tension:0.35, pointRadius:0, pointHoverRadius:4, borderWidth:2, spanGaps:true }] }, options: base });
    }
    const errC = document.getElementById('err-chart');
    if (errC && qt.length) {
      const rate = qt.map(x=>{ const e=x.errs||0, m=x.msgs||0; return (e+m)>0 ? Math.round(e/(e+m)*1000)/10 : 0; });
      new Chart(errC, { type:'line', data:{ labels: qLabels, datasets:[{ label:'失败率', data: rate, borderColor:'#fb7185', backgroundColor:'rgba(251,113,133,0.12)', fill:true, tension:0.3, pointRadius:0, pointHoverRadius:4, borderWidth:2 }] },
        options:{ ...base,
          scales:{ ...base.scales, y:{ ...base.scales.y, ticks:{ ...base.scales.y.ticks, callback:v=>v+'%' } } },
          plugins:{ ...base.plugins, tooltip:{ ...base.plugins.tooltip, callbacks:{ label: ctx => '失败率 ' + ctx.parsed.y + '% · 失败 ' + (qt[ctx.dataIndex].errs||0) + ' 次 / 消息 ' + fmt(qt[ctx.dataIndex].msgs||0) + ' 条' } } } } });
    }
  }
}

// ── 动态事件绑定 ──
function bindDynamic() {
  const tabs = document.getElementById('ret-tabs');
  if (tabs) tabs.querySelectorAll('button').forEach(b => b.addEventListener('click', () => { activeRetTab = b.dataset.tab; tabs.querySelectorAll('button').forEach(x=>x.classList.toggle('active',x===b)); ['new','week','rolling'].forEach(k => { const el = document.getElementById('rt-'+k); if (el) el.style.display = (k===activeRetTab)?'block':'none'; }); }));
  const ma = document.getElementById('ma-toggle');
  if (ma) ma.addEventListener('change', e => { showMA = e.target.checked; writeHash(); if (lastData) render(lastData); });
  const cmp = document.getElementById('cmp-toggle');
  if (cmp) cmp.addEventListener('change', e => { showCmp = e.target.checked; if (lastData) render(lastData); });
  const search = document.getElementById('user-search');
  if (search) search.addEventListener('input', e => { userQuery = e.target.value; userPage = 0; refreshUserTable(); });
  const cp = document.getElementById('csv-depth');
  if (cp) cp.addEventListener('click', () => { const dd = lastData.depth||{}; exportCSV('message-distribution.csv', [['分桶','数量'],['0 条(仅启动)',dd.b0||0],['1-5 条(轻度)',dd.b1_5||0],['6-20 条(常规)',dd.b6_20||0],['20+ 条(重度)',dd.b20p||0]]); });
  const cu = document.getElementById('csv-users');
  if (cu) cu.addEventListener('click', () => { const rows = [['设备ID','系统','版本','首次出现','最近活跃','活跃天数','累计消息']]; userView().forEach(u => rows.push([u.device_id,u.os,u.version,u.first_date,u.last_date,u.active_days,u.total_msgs])); exportCSV('users.csv', rows); });
}

function exportCSV(filename, rows) {
  const csv = rows.map(r => r.map(c => { const s = String(c==null?'':c); return /[",\\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s; }).join(',')).join('\\n');
  const blob = new Blob(['\\ufeff'+csv], { type:'text/csv;charset=utf-8;' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename; a.click();
}

function populateVersionSelect() {
  const sel = document.getElementById('ver-select'); if (!sel || !allVersions) return;
  let opts = '<option value="all">全部版本</option>';
  for (const v of allVersions) {
    const ver = v.version || '';
    // 注意结尾是 '>' 不是 '">':多一个引号会让 selected 被解析成非法属性名
    // "selected\"",布尔属性失效,带 v= 刷新时下拉显示"全部版本"但数据实际被筛着。
    opts += '<option value="'+esc(ver)+'"'+(ver===currentVer?' selected':'')+'>'+esc(ver || '(unknown)')+' · '+v.count+'</option>';
  }
  sel.innerHTML = opts;
}

// ── 加载与控制同步 ──
// 用递增序号做"最新胜出":连点刷新或快速切筛选会并发多个 fetch,只有最后一次的
// 结果才 render,避免旧响应覆盖新数据。load 返回 promise 供 reload 清理 spinning。
let loadSeq = 0;
async function load() {
  const seq = ++loadSeq;
  try { const d = await fetchData(); if (seq === loadSeq) render(d); }
  catch (e) { if (seq === loadSeq) document.getElementById('content').innerHTML = '<div class="error">数据加载失败:'+e.message+'</div>'; }
}
function reload(fromBtn) {
  // 已有数据时不清空页面:压暗旧内容等新数据到位再整体替换(stale-while-revalidate
  // 的视觉版),避免每切一次筛选整页闪成 spinner。首次加载仍走全屏 spinner。
  const content = document.getElementById('content');
  if (lastData) { content.style.opacity = '0.4'; content.style.pointerEvents = 'none'; }
  else content.innerHTML = '<div class="loading"><div class="spinner"></div><div>正在加载数据…</div></div>';
  const btn = fromBtn ? document.getElementById('refresh-btn') : null;
  if (btn) btn.classList.add('spinning');
  load().finally(() => {
    if (btn) btn.classList.remove('spinning');
    content.style.opacity = ''; content.style.pointerEvents = '';
  });
}
function syncControls() {
  document.querySelectorAll('#range button').forEach(b => b.classList.toggle('active', String(b.dataset.d)===String(currentDays)));
  document.getElementById('custom-range').classList.toggle('on', currentDays==='custom');
  if (currentDays === 'custom') {
    document.getElementById('start-date').value = currentStart || '';
    document.getElementById('end-date').value = currentEnd || '';
  }
  document.querySelectorAll('#os-seg button').forEach(b => b.classList.toggle('active', b.dataset.os===currentOs));
  document.querySelectorAll('#seg-seg button').forEach(b => b.classList.toggle('active', b.dataset.seg===currentSegment));
  document.querySelectorAll('.section-nav button').forEach(b => b.classList.toggle('active', b.dataset.sec===activeSection));
  populateVersionSelect();
}

// 静态事件(一次绑定)
document.getElementById('range').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const d = b.dataset.d;
  if (d === 'custom') { document.getElementById('custom-range').classList.add('on'); return; }
  currentDays = (d === 'all') ? 'all' : parseInt(d, 10);
  currentStart = null; currentEnd = null; writeHash(); syncControls(); reload();
});
document.getElementById('apply-custom').addEventListener('click', () => {
  const sEl = document.getElementById('start-date'), eEl = document.getElementById('end-date');
  if (!sEl.value || !eEl.value || sEl.value > eEl.value) {
    // 校验失败给个可见反馈(红框 1.5s),而非静默无视点击。
    [sEl, eEl].forEach(el => { el.style.borderColor = 'var(--rose)'; setTimeout(()=>el.style.borderColor='', 1500); });
    return;
  }
  currentStart = sEl.value; currentEnd = eEl.value; currentDays = 'custom'; writeHash(); syncControls(); reload();
});
document.getElementById('os-seg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; currentOs = b.dataset.os; writeHash(); syncControls(); reload(); });
document.getElementById('seg-seg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; currentSegment = b.dataset.seg; writeHash(); syncControls(); reload(); });
document.getElementById('ver-select').addEventListener('change', e => { currentVer = e.target.value; writeHash(); reload(); });
document.getElementById('refresh-btn').addEventListener('click', () => reload(true));
document.querySelector('.section-nav').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  activeSection = b.dataset.sec; writeHash(); document.querySelectorAll('.section-nav button').forEach(x=>x.classList.toggle('active',x===b));
  document.querySelectorAll('.section').forEach(s => s.classList.toggle('on', s.id === 'sec-'+activeSection));
  if (lastData) drawCharts(lastData);   // 切到新章节时补绘其图表
});

readHash(); syncControls(); load();
// 不做自动刷新:这是单人低频管理后台,自动刷新只会白烧 D1 免费额度。
// 想看最新数据点顶部"刷新"按钮,或切换任意筛选都会重新拉取。
<\/script>
</body>
</html>`;
