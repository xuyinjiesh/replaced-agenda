import { escapeHtml } from "./text.mjs";

const dirs = (depth) => "../".repeat(depth);
export const link = (depth, p) => `${dirs(depth)}${p}`;

export function icon(name) {
  const paths = {
    bookmark: '<path d="M6 3.75h12a1 1 0 0 1 1 1V21l-7-4-7 4V4.75a1 1 0 0 1 1-1Z"/>',
    chevron: '<path d="m9 6 6 6-6 6"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"/>',
    search: '<circle cx="10.8" cy="10.8" r="6.3"/><path d="m16 16 4.2 4.2"/>',
    filter: '<path d="M4 5h16M7 12h10m-7 7h4"/><circle cx="8" cy="5" r="1.3"/><circle cx="15" cy="12" r="1.3"/><circle cx="10" cy="19" r="1.3"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
  };
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? ""}</svg>`;
}

export function layout({ title, depth, active, body, subtitle = "", context = "", latest = "", dateRange = "", sidebar = "", showTools = true }) {
  const nav = [
    ["index.html", "互联网"],
    ["academia.html", "学术界"],
    ["archive.html", "归档"],
    ["method.html", "方法"],
  ];
  const latestDate = latest ? new Date(`${latest}T00:00:00Z`) : null;
  const month = latestDate && !Number.isNaN(latestDate.getTime())
    ? latestDate.toLocaleString("en", { month: "long", timeZone: "UTC" }).toUpperCase()
    : "DAILY";
  const day = latestDate && !Number.isNaN(latestDate.getTime()) ? String(latestDate.getUTCDate()).padStart(2, "0") : "—";
  const tools = showTools ? `
<div id="sort-menu" class="v2-sort-menu" popover role="menu" aria-labelledby="sort-caption">
  <div class="v2-sort-menu-label" aria-hidden="true">排序方式</div>
  <button class="v2-sort-option" role="menuitemradio" aria-checked="true" tabindex="0" data-action="sort" data-sort="value"><span><strong>推进强度</strong><small>优先查看推进强度更高的记录</small></span>${icon("check")}</button>
  <button class="v2-sort-option" role="menuitemradio" aria-checked="false" tabindex="-1" data-action="sort" data-sort="date"><span><strong>最新发布</strong><small>优先查看最近发布的内容</small></span>${icon("check")}</button>
  <button class="v2-sort-option" role="menuitemradio" aria-checked="false" tabindex="-1" data-action="sort" data-sort="confidence"><span><strong>证据可信度</strong><small>优先查看证据可信度更高的记录</small></span>${icon("check")}</button>
</div>
<div id="filter-popover" class="filter-popover" popover aria-labelledby="filter-heading">
  <div class="popover-heading"><strong id="filter-heading">筛选记录</strong><button class="icon-button" type="button" data-action="close-filter" aria-label="关闭筛选">×</button></div>
  <label class="check-row"><input type="checkbox" data-filter="direct"><span>仅看直接任务进展<small>能够指出已发生的具体任务或流程变化</small></span></label>
  <label class="check-row"><input type="checkbox" data-filter="verified"><span>仅看已核对引文<small>引文文字能在采集到的来源文本中找到</small></span></label>
  <label class="range-label" for="min-filter"><span>最低推进强度</span><output id="min-output">0.00</output></label>
  <input id="min-filter" type="range" min="0" max="0.9" step="0.05" value="0">
  <div class="popover-footer"><button class="text-link" type="button" data-action="clear-filters">清除条件</button><button class="action-button primary" type="button" data-action="close-filter">完成</button></div>
</div>
<div id="toast" class="toast" role="status" aria-live="polite"></div>` : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(subtitle || "按领域整理互联网与学术界的 AI 人类任务进展记录")}">
<link rel="stylesheet" href="${link(depth, "assets/style.css")}">
<link rel="alternate" type="application/json" href="${link(depth, "data/index.json")}" title="index.json">
</head>
<body class="editorial-theme editorial-v2">
<a class="skip-link" href="#main-content">跳到内容</a>
<div class="edition-wrap">
  <header class="edition-header">
    <div class="edition-top"><span>独立观察 · 审慎判断</span><a href="${link(depth, "index.html")}">REPLACED AGENDA</a><button class="edition-saved" data-action="saved-list" aria-pressed="false">${icon("bookmark")}我的稍后读 <b data-saved-count>0</b></button></div>
    <div class="masthead"><span class="issue-date">${month}<strong>${day}</strong><span>${escapeHtml(latest || "每日更新")}${dateRange ? ` · ${escapeHtml(dateRange)}` : ""}</span></span><div><h1><a href="${link(depth, "index.html")}">AI 降临观测站<span class="masthead-dot">.</span></a></h1><p>观察智能，如何改变人的工作。</p></div><span class="edition-seal">DAILY<br>OBSERVATION<span>每日一读</span></span></div>
  </header>
  <nav class="edition-nav" aria-label="频道与工具">
    <div class="channel-tabs">${nav.slice(0, 3).map(([href, label]) => `<a href="${link(depth, href)}"${active === href ? ' class="active" aria-current="page"' : ""}>${label}</a>`).join("")}</div>
${showTools ? `    <div class="edition-nav-right"><label class="search-box">${icon("search")}<input id="search" type="search" placeholder="寻找一条线索" aria-label="搜索标题、来源或关键词"><kbd>/</kbd></label><button id="filter-trigger" class="action-button" data-action="filter" popovertarget="filter-popover" aria-controls="filter-popover">${icon("filter")}筛选</button></div>` : ""}
  </nav>
  <div class="edition-content${sidebar ? "" : " no-sidebar"}">${body}${sidebar}</div>
  <footer class="edition-footer"><a href="${link(depth, "index.html")}">AI 降临观测站</a><span>看见进展，也看见它的边界。</span><a class="mobile-method-link" href="${link(depth, "method.html")}">评分口径 ↗</a><a href="${link(depth, "archive.html")}">浏览历史归档 ↗</a><a href="${link(depth, "data/index.json")}">原始数据</a></footer>
</div>
${tools}
<script src="${link(depth, "assets/app.js")}" defer></script>
</body>
</html>
`;
}
