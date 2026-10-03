import fs from "node:fs";
import path from "node:path";
import { escapeHtml, truncate } from "./text.mjs";
import { ensureDir, exists, log, round, writeText } from "./util.mjs";

const dirs = (depth) => "../".repeat(depth);
const link = (depth, p) => `${dirs(depth)}${p}`;

const HOME_LABEL = "首页";

function icon(name) {
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

function layout({ title, depth, active, body, subtitle = "", context = "", latest = "", dateRange = "", sidebar = "", showTools = true }) {
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

export const SECTOR_ORDER = ["internet", "academia"];

export const SECTOR_META = {
  internet: {
    key: "internet",
    label: "互联网",
    sub: "实时热点",
    emoji: "🌐",
    page: "index.html",
  },
  academia: {
    key: "academia",
    label: "学术界",
    sub: "科研成果",
    emoji: "🎓",
    page: "academia.html",
  },
};

/** 按频道统计：条数、当日 Δ 合计、各领域分布。 */
function sectorStats(events) {
  const byDomain = new Map();
  let totalDelta = 0;
  let direct = 0;
  let indirect = 0;
  for (const e of events) {
    const isIndirect = e.relation === "indirect";
    if (isIndirect) indirect += 1;
    else direct += 1;
    totalDelta += Number(e.delta ?? 0);
    const cur = byDomain.get(e.domain) ?? { domain: e.domain, events: 0, delta: 0, direct: 0, indirect: 0 };
    cur.events += 1;
    cur.delta += Number(e.delta ?? 0);
    if (isIndirect) cur.indirect += 1;
    else cur.direct += 1;
    byDomain.set(e.domain, cur);
  }
  return {
    count: events.length,
    totalDelta,
    direct,
    indirect,
    domains: [...byDomain.values()].sort((a, b) => b.delta - a.delta),
  };
}

/** 频道内每日 Δ 走势，用于频道页的迷你折线。 */
function sectorSeries(sector, dates, dayLoader) {
  return dates.map((d) => ({
    date: d,
    delta: (dayLoader(d)?.events ?? []).filter((e) => (e.sector ?? "academia") === sector).reduce((s, e) => s + Number(e.delta ?? 0), 0),
  }));
}

/**
 * 频道页取一段时间窗而不是单日。
 * 原因是发布日 ≠ 采集日：公司博客和媒体常常在几天后才被采到，且发布日就是事件发生日，
 * 按发布日归档是对的。只看单日会让工业界频道几乎空掉（实测单日 3 条 vs 近 7 天 30 条）。
 */
function windowEvents(sector, dates, dayLoader, windowDays, latest) {
  const from = dates.slice(-windowDays);
  const out = [];
  for (const d of [...from].reverse()) {
    for (const e of dayLoader(d)?.events ?? []) {
      if ((e.sector === "internet" ? "internet" : "academia") === sector) out.push({ ...e, date: e.date ?? d });
    }
  }
  out.sort((a, b) => b.value - a.value || b.delta - a.delta || a.id.localeCompare(b.id));
  return { events: out, from: from[0] ?? latest, days: from.length };
}

function domainMeta(domains, key) {
  return domains.find((d) => d.key === key) ?? { key, label: key, emoji: "", scale: 50 };
}

function fmtSigned(n, digits = 2) {
  const v = Number(n ?? 0);
  const s = v > 0 ? "+" : v < 0 ? "" : "±";
  return `${s}${v.toFixed(digits)}`;
}

function cls(n) {
  const v = Number(n ?? 0);
  return v > 0.0001 ? "pos" : v < -0.0001 ? "neg" : "zero";
}

function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  const pad = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function heatColor(value) {
  const t = Math.max(0, Math.min(1, (Number(value) - 0.3) / 0.6));
  const stops = [
    [0.0, [148, 163, 184]], // 石板灰
    [0.25, [251, 191, 36]], // 琥珀
    [0.5, [249, 115, 22]], // 橙
    [0.75, [220, 38, 38]], // 红
    [1.0, [153, 27, 27]], // 深红
  ];
  let a = stops[0];
  let b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i += 1) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) {
      a = stops[i];
      b = stops[i + 1];
      break;
    }
  }
  const span = b[0] - a[0] || 1;
  const k = (t - a[0]) / span;
  const c = a[1].map((v, i) => Math.round(v + (b[1][i] - v) * k));
  return `rgb(${c[0]} ${c[1]} ${c[2]})`;
}

/** 火焰档位：0-5，半档精度，让 0.50 / 0.55 / 0.60 / 0.65 能区分开。 */
function flameLevel(value) {
  return Math.max(0.5, Math.min(5, Math.round(Number(value) * 10) / 2));
}

/**
 * 可信度只强调两端。
 * 证据类型先验天然分三带：社区/厂商 0.4-0.5、预印本/新闻 0.55-0.7、同行评议/第三方复现/政府文件 0.8-0.92。
 * 中间那档占绝大多数（实测 120 条里 94 条），全部标记等于没标记，所以只把高低两端挑出来。
 */
const CONF_HIGH = 0.75;
const CONF_LOW = 0.5;

function confTier(c) {
  if (c >= CONF_HIGH) return "high";
  if (c < CONF_LOW) return "low";
  return "mid";
}

const TIERS = [
  [0.9, "里程碑"],
  [0.7, "显著跃升"],
  [0.5, "扎实进展"],
  [0.3, "增量改进"],
  [0, "弱相关"],
];

/* 火焰图标暂时留空。
   它本该表示「高讨论度」，但当前没有任何数据能算出讨论量（见 README「做不到的标签」）。
   曾经拿它标「推进强度 ≥0.70」——那是模型的打分，和「多少人在讨论」是两回事，
   读者看到一个火苗会以为那是社区热度。宁可空着，也不要一个名不副实的图标。 */

/* ============ 备注标签 ============
   设计原则：标签只标「例外」，不标「常态」。
   一个标签如果命中 80% 以上的条目就没有区分度（「一手信息」在学术界命中 99%），
   所以这里只留真正能给读者额外信息的少数几种，且每种都能从已有字段直接判定，
   不引入需要再采集的数据。
   成对出现的标签是同一个问题的两端：同行评议 ↔ 厂商自述 ↔ 小道消息。 */
const FIRST_RE = /首次|首个|第一次|全球首|世界首|首款|首创/;

function tagsOf(e) {
  const t = [];
  // 证据强度：独立于当事人的验证，最硬
  if (e.evidence_type === "peer_reviewed") t.push(["ok", "同行评议", "已通过同行评议，证据强度最高"]);
  else if (e.evidence_type === "third_party_reproduced") t.push(["ok", "已复现", "第三方独立复现，证据强度最高"]);
  else if (e.evidence_type === "government_filing") t.push(["ok", "官方文件", "政府或监管机构文件"]);
  // 利益相关：当事人自己说的
  else if (e.evidence_type === "vendor_claim") t.push(["warn", "厂商自述", "厂商自己的说法，未经独立验证"]);
  // 未经核实的社区转述
  else if (e.evidence_type === "community_report" && e.confidence < 0.6)
    t.push(["warn", "小道消息", "社区转述，未经核实"]);
  // 首次/首个：从标题和摘要原文里认，不是模型打分推出来的
  if (FIRST_RE.test(`${e.title_zh ?? ""}${e.summary_zh ?? ""}`)) t.push(["first", "首次", "标题或摘要明确称首次/首个"]);
  // 只是推断，不是观测
  if (e.relation === "indirect") t.push(["pot", "潜力", "只是具备替代潜力，属推断而非观测；不参与指数计算"]);
  return t;
}

function tierLabel(value) {
  return (TIERS.find(([min]) => Number(value) >= min) ?? TIERS.at(-1))[1];
}

function flagLabel(verdict) {
  return (
    {
      over_scored: "偏高",
      under_scored: "偏低",
      misclassified: "领域存疑",
      not_relevant: "无关",
      agree: "一致",
    }[verdict] ?? verdict
  );
}

/**
 * 事件卡片。
 * 按需求只保留：领域、推进强度（火焰 + 数字 + 热色条）、当日 Δ、可信度、标题、中文摘要。
 * 证据类型、来源、日期、关键词、原文引文等一律不进卡片，需要时去方法页看口径。
 */
const RE_SPECIAL = /[.*+?^${}()|[\]\\]/g;
const RE_ASCII = /^[\x00-\x7F]+$/;

/**
 * 把公司名和关键概念在文本里标出来。
 *
 * 做法是先按**原文**切分再逐段转义，而不是先转义再替换——后者会把 &lt; 里的字母也当成
 * 可匹配文本，而且模型给的词一旦含 < > 就会注入。切分时用「最长优先」避免短词吃掉长词，
 * 纯 ASCII 词加 \b 边界，否则 "AI" 会在 "said" 里命中。
 */
function highlightTerms(text, companies = [], concepts = []) {
  const cls = new Map();
  for (const t of companies) {
    const k = String(t).trim();
    if (k.length >= 2) cls.set(k.toLowerCase(), "hl-ent");
  }
  for (const t of concepts) {
    const k = String(t).trim();
    if (k.length >= 2 && !cls.has(k.toLowerCase())) cls.set(k.toLowerCase(), "hl-con");
  }
  const keys = [...cls.keys()].sort((a, b) => b.length - a.length);
  if (!keys.length) return escapeHtml(text);

  const pattern = keys
    .map((k) => (RE_ASCII.test(k) ? `\\b${k.replace(RE_SPECIAL, "\\$&")}\\b` : k.replace(RE_SPECIAL, "\\$&")))
    .join("|");
  const re = new RegExp(`(${pattern})`, "gi");

  let out = "";
  let last = 0;
  for (const m of text.matchAll(re)) {
    out += escapeHtml(text.slice(last, m.index));
    out += `<mark class="${cls.get(m[0].toLowerCase())}">${escapeHtml(m[0])}</mark>`;
    last = m.index + m[0].length;
  }
  return out + escapeHtml(text.slice(last));
}

function eventItem(e, { domains, scoring, audit, number = 1 }) {
  const dm = domainMeta(domains, e.domain);
  const text = [e.title, e.title_zh, e.summary_zh, e.why_zh, e.evidence_quote, e.source_name, (e.keywords ?? []).join(" "), e.model]
    .join(" ").toLowerCase().replace(/"/g, "'");
  const review = audit?.get(e.id);
  const titleId = `v2-title-${String(e.id).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const detailsId = `v2-details-${String(e.id).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const evidence = scoring.evidenceTypes?.[e.evidence_type]?.label ?? "待核实";
  const tags = tagsOf(e).map(([type, label, tip]) => `<span class="tag tag-${type}" title="${escapeHtml(tip)}">${escapeHtml(label)}</span>`).join("");
  const reviewNote = review && review.verdict !== "agree"
    ? `<span class="flag" title="独立复核：${escapeHtml(review.reason ?? "")}">${escapeHtml(flagLabel(review.verdict))}${review.audited_value != null ? ` ${Number(e.value).toFixed(2)}→${Number(review.audited_value).toFixed(2)}` : ""}</span>`
    : "";
  const value = Number(e.value ?? 0);
  const confidence = Number(e.confidence ?? 0);
  const quoteStatus = e.evidence_verified ? "引文已核对" : "引文待核对";
  return `<article class="story${number === 1 ? " is-featured" : ""}" data-v2-record data-id="${escapeHtml(e.id)}" data-domain="${escapeHtml(e.domain)}" data-date="${escapeHtml(e.date)}" data-value="${value}" data-confidence="${confidence}" data-relation="${e.relation === "indirect" ? "indirect" : "direct"}" data-verified="${Boolean(e.evidence_verified)}" data-text="${escapeHtml(text)}" style="--heat:${heatColor(value)};--domain-dot:${heatColor(value)}">
  <span class="story-number" aria-hidden="true">${String(number).padStart(2, "0")}</span>
  <div class="story-body">
    <span class="story-kicker">本期重点</span>
    <div class="story-meta"><span class="domain-text"><i aria-hidden="true"></i>${escapeHtml(dm.label)}</span><time datetime="${escapeHtml(e.date)}">${escapeHtml(e.date)}</time></div>
    <div class="v2-entry-header" data-action="expand" data-id="${escapeHtml(e.id)}" aria-expanded="false" aria-controls="${detailsId}">
      <h2 id="${titleId}" class="story-title"><a class="v2-title-link" href="${escapeHtml(e.source_url)}" target="_blank" rel="noopener noreferrer"${e.title_zh && e.title_zh !== e.title ? ` title="原标题：${escapeHtml(e.title)}"` : ""}>${highlightTerms(e.title_zh || e.title, e.companies, e.concepts)}</a></h2>
    </div>
    <div class="v2-story-baseline"><p class="v2-source-line"><span>${escapeHtml(e.source_name || "原始来源")}</span><span class="v2-meta-dot" aria-hidden="true">·</span><span>${e.relation === "indirect" ? "潜力观察" : "直接任务进展"}</span>${reviewNote}</p><button class="v2-read-toggle" type="button" data-action="expand" data-id="${escapeHtml(e.id)}" aria-expanded="false" aria-controls="${detailsId}"><span data-toggle-label>阅读摘要</span>${icon("chevron")}</button></div>
    <section id="${detailsId}" class="v2-details" aria-labelledby="${titleId}" hidden>
      <div class="v2-summary-section"><h3>事件摘要</h3><p class="v2-summary">${highlightTerms(e.summary_zh || "暂无摘要，可直接阅读原文。", e.companies, e.concepts)}</p></div>
${e.why_zh ? `      <div class="v2-why"><h3>为什么值得关注</h3><p>${highlightTerms(e.why_zh, e.companies, e.concepts)}</p></div>` : ""}
      <div class="v2-evidence"><div class="v2-evidence-heading"><h3>原文证据</h3><span class="v2-verification${e.evidence_verified ? " verified" : ""}">${icon(e.evidence_verified ? "check" : "filter")}${quoteStatus}</span></div><blockquote>${highlightTerms(e.evidence_quote || "暂无可核对的原文引文。", e.companies, e.concepts)}</blockquote></div>
${tags || reviewNote ? `      <div class="v2-detail-tags">${tags}${reviewNote}</div>` : ""}
      <div class="v2-detail-footer"><dl class="v2-score-list"><div><dt>推进强度</dt><dd>${value.toFixed(2)}${e.value_capped ? "*" : ""}</dd></div><div><dt>证据可信度</dt><dd>${confidence.toFixed(2)}</dd></div><div><dt>证据类型</dt><dd class="v2-evidence-type">${escapeHtml(evidence)}</dd></div></dl><a class="v2-original" href="${escapeHtml(e.source_url)}" target="_blank" rel="noopener noreferrer">阅读原文 ${icon("external")}</a></div>
      <p class="v2-reading-note">评分由模型辅助评估；引文核对仅确认文字出处。${e.relation === "indirect" ? "本条属于潜力观察，不计入进程指数。" : ""}${e.value_capped ? ` 推进强度已受证据上限约束：${escapeHtml(e.value_capped.includes("no_basis") ? "缺少具体基准或部署依据。" : "当前证据类型不足以支撑更高分值。")}` : ""}</p>
    </section>
  </div>
  <div class="story-save"><button class="save-button" type="button" data-action="save" data-id="${escapeHtml(e.id)}" aria-pressed="false" aria-label="加入稍后读" title="加入稍后读">${icon("bookmark")}</button></div>
</article>`;
}

function listSection(events, { domains, scoring, title, audit, depth = 0, extra = "" }) {
  return `<main class="editorial-main" id="main-content">
  <div class="edition-context"><div class="context-copy"><span id="view-title">${escapeHtml(title)}</span><span id="result-count" aria-live="polite">${events.length} 条记录</span><span id="applied-filters"></span></div><div class="v2-sort"><span id="sort-caption">排序</span><button id="sort-trigger" class="v2-sort-trigger" type="button" popovertarget="sort-menu" aria-haspopup="menu" aria-expanded="false" aria-labelledby="sort-caption sort-label"><span id="sort-label">推进强度</span>${icon("chevron")}</button></div></div>
${extra ? `  ${extra}` : ""}
  <div class="story-list" id="story-list">${events.map((e, i) => eventItem(e, { domains, scoring, audit, number: i + 1 })).join("\n")}</div>
  <p id="empty-results" class="empty-state" hidden>这个筛选范围内没有记录。请调整搜索或筛选条件。</p>
</main>`;
}

function editorialSidebar(events, domains, { depth = 0, dates = [], dateRange = "" } = {}) {
  const grouped = new Map(domains.map((d) => [d.key, { ...d, count: 0 }]));
  for (const e of events) {
    const row = grouped.get(e.domain);
    if (row) row.count += 1;
  }
  const rows = [...grouped.values()].filter((d) => d.count > 0).sort((a, b) => b.count - a.count);
  const max = Math.max(1, ...rows.map((d) => d.count));
  const domainNav = rows.map((d) => `<div class="domain-row"><button class="domain-button" type="button" data-domain-filter="${escapeHtml(d.key)}" title="筛选当前列表中的${escapeHtml(d.label)}记录"><span><i class="domain-dot" aria-hidden="true"></i>${escapeHtml(d.label)}</span><span class="domain-count">${d.count}</span></button><a class="domain-page-link" href="${link(depth, `domain/${d.key}.html`)}" aria-label="打开${escapeHtml(d.label)}领域页">↗</a></div>`).join("");
  const distribution = rows.map((d) => `<div class="coverage-row"><span>${escapeHtml(d.label)}</span><span>${d.count}</span><i><b style="width:${Math.round((d.count / max) * 100)}%"></b></i></div>`).join("");
  const dayLinks = dates.slice(-10).reverse().map((d) => `<a href="${link(depth, `day/${d}.html`)}"><time datetime="${escapeHtml(d)}">${escapeHtml(d)}</time>${dateRange === d ? " · 当前" : ""}</a>`).join("");
  return `<aside class="edition-aside"><section class="edition-note"><div class="eyebrow">本期观察</div><h2>AI 承担人类任务的进展</h2><p>按领域整理互联网与学术界的相关事件。展开记录可查看摘要、原文证据、推进强度和证据可信度。</p><div class="issue-stat"><strong>${events.length}</strong><span>条记录<br>${escapeHtml(dateRange || "持续更新")}</span></div></section>
  <div class="section-heading small"><h2>沿着领域阅读</h2><span>INDEX</span></div><nav class="domain-list" aria-label="领域筛选">${domainNav || '<p class="muted">当前没有领域记录</p>'}</nav>
  <section class="coverage"><div class="section-label">当前内容分布</div>${distribution || '<p class="muted">暂无统计</p>'}</section>
  ${dayLinks ? `<section class="date-index"><div class="section-label">按日期浏览</div>${dayLinks}</section>` : ""}
  <section class="edition-method"><span class="method-mark" aria-hidden="true">i</span><p>高分不等于事实已被证实。<br>每条内容都值得回到来源核对。</p><a href="${link(depth, "method.html")}">我们如何评估进展 ↗</a></section></aside>`;
}

function dateNavigation(current, dates, depth) {
  const index = dates.indexOf(current);
  const previous = index > 0 ? dates[index - 1] : null;
  const next = index >= 0 && index < dates.length - 1 ? dates[index + 1] : null;
  return `<nav class="date-navigation" aria-label="日期导航">${previous ? `<a href="${link(depth, `day/${previous}.html`)}">← 前一天 <time datetime="${previous}">${previous}</time></a>` : '<span class="date-nav-empty"></span>'}<a class="date-index-link" href="${link(depth, "archive.html")}">返回归档</a>${next ? `<a href="${link(depth, `day/${next}.html`)}"><time datetime="${next}">${next}</time> 后一天 →</a>` : '<span class="date-nav-empty"></span>'}</nav>`;
}

function allEventsForDomain(root, domain, dates, dayLoader) {
  const out = [];
  for (const d of [...dates].reverse()) {
    const day = dayLoader(d);
    for (const e of day?.events ?? []) if (e.domain === domain) out.push(e);
  }
  return out;
}

export function renderSite({ root, domains, scoring, indexData, dates, dayLoader, runReports, healthRows, sourcesConfig, auditLoader }) {
  const site = path.join(root, "site");
  ensureDir(path.join(site, "assets"));
  ensureDir(path.join(site, "day"));
  ensureDir(path.join(site, "domain"));

  // 「工业界」频道已改名为「互联网」：清掉改名前的遗留页面，避免旧链接指向过期内容
  for (const stale of ["industry.html", "internet.html"]) {
    const f = path.join(site, stale);
    if (fs.existsSync(f)) fs.rmSync(f);
  }

  fs.copyFileSync(path.join(root, "theme", "style.css"), path.join(site, "assets", "style.css"));
  fs.copyFileSync(path.join(root, "theme", "app.js"), path.join(site, "assets", "app.js"));

  // GitHub Pages 用 Jekyll 处理时会跳过 `_` 开头的文件/目录。当前产物里没有这类名字，
  // 但加一个空 .nojekyll 一是免掉整条 Jekyll 构建、部署更快，二是防止以后新增的
  // `_` 前缀资源被静默吞掉。用 Actions 发布时它无害，用分支发布时它必需。
  writeText(path.join(site, ".nojekyll"), "");

  const auditFor = (d) => {
    const a = auditLoader?.(d);
    if (!a?.rows?.length) return null;
    return new Map(a.rows.map((r) => [r.id, { ...r, auditor_model: a.auditor_model }]));
  };
  const latest = dates.at(-1);
  const latestAudit = latest ? auditFor(latest) : null;
  const latestDay = latest ? dayLoader(latest) : null;
  const latestEvents = latestDay?.events ?? [];
  const dateRange = dates.length ? `${dates[0].slice(5)} — ${dates.at(-1).slice(5)}` : "";

  // ---------- 两个频道页 ----------
  const sectorOf = (e) => (e.sector === "internet" ? "internet" : "academia");

  const WINDOW = 7; // 频道页的滚动窗口天数
  for (const key of SECTOR_ORDER) {
    const meta = SECTOR_META[key];
    const win = windowEvents(key, dates, dayLoader, WINDOW, latest);
    const events = win.events;
    const stats = sectorStats(events);
    const byDomain = new Map(stats.domains.map((d) => [d.domain, d]));
    const spread = `${escapeHtml(win.from.slice(5))}–${escapeHtml(latest.slice(5))}`;

    const body = listSection(events, { domains, scoring, title: meta.label, audit: latestAudit });

    writeText(
      path.join(site, meta.page),
      layout({
        title: `${meta.label}${meta.sub} · AI 替代进程 ${latest ?? ""}`,
        depth: 0,
        active: meta.page,
        body,
        subtitle: `AI 在${meta.label}的${meta.sub}：近 ${WINDOW} 天按推进强度排序的记录`,
        context: `${meta.emoji} ${meta.label}`,
        latest,
        dateRange: `${dateRange} · 近 ${win.days} 日`,
        sidebar: editorialSidebar(events, domains, { depth: 0, dates, dateRange }),
      }),
    );
  }

  // ---------- 各日期页 ----------
  for (const d of dates) {
    const day = dayLoader(d);
    const events = day?.events ?? [];
    const dayDelta = indexData.domains.reduce((s, dm) => s + ((dm.series ?? []).find((x) => x.date === d)?.delta ?? 0), 0);
    const byDomain = new Map(
      indexData.domains
        .map((dm) => {
          const row = (dm.series ?? []).find((x) => x.date === d) ?? { delta: 0, events: 0 };
          return [dm.domain, { domain: dm.domain, delta: row.delta, events: row.events }];
        })
        .filter(([, v]) => v.events > 0),
    );
    const body = listSection(events, { domains, scoring, title: d, audit: auditFor(d), depth: 1, extra: dateNavigation(d, dates, 1) });
    writeText(
      path.join(site, "day", `${d}.html`),
      layout({ title: `AI 替代进程 ${d}`, depth: 1, active: "archive.html", body, context: `📅 ${d}`, latest, dateRange: d, sidebar: editorialSidebar(events, domains, { depth: 1, dates, dateRange: d }) }),
    );
  }

  // ---------- 领域页 ----------
  for (const dm of indexData.domains) {
    const meta = domainMeta(domains, dm.domain);
    const events = allEventsForDomain(root, dm.domain, dates, dayLoader);
    const body = `${listSection(events, { domains, scoring, title: meta.label, audit: latestAudit, depth: 1 })}
<p class="pagenote">指数 = 100 × (1 − e^(−累计贡献 / ${meta.scale ?? 50}))，衡量自基准日起的累计进程，非绝对真值。口径见<a href="${link(1, "method.html")}">方法页</a>。</p>`;
    writeText(
      path.join(site, "domain", `${dm.domain}.html`),
      layout({
        title: `${meta.label} · AI 替代进程`,
        depth: 1,
        active: "",
        body,
        context: `${meta.emoji} ${meta.label}`,
        latest,
        dateRange,
        sidebar: editorialSidebar(events, domains, { depth: 1, dates, dateRange }),
      }),
    );
  }

  // ---------- 归档：重点事件时间轴 ----------
  // 不做「每天一堆条目」的流水账，只挑每天最值得看的那几条，
  // 让归档页回答一个问题：这段时间里最要紧的事是什么。
  const TOP_PER_DAY = 5;
  const archiveEvents = dates.flatMap((d) => dayLoader(d)?.events ?? []);
  const timeline = [...dates].reverse().map((d) => {
    const day = dayLoader(d);
    const events = [...(day?.events ?? [])].sort((a, b) => b.value - a.value || b.delta - a.delta);
    const top = events.slice(0, TOP_PER_DAY);
    const delta = indexData.domains.reduce((s, dm) => s + ((dm.series ?? []).find((x) => x.date === d)?.delta ?? 0), 0);
    return `<section class="tl-day"><div class="tl-date"><a href="${link(0, `day/${d}.html`)}">${escapeHtml(d)}</a><span class="tl-delta ${cls(delta)}">Δ ${fmtSigned(delta, 2)}</span><span class="tl-count">${events.length} 条中取前 ${top.length}</span></div><div class="story-list">${top.map((e, i) => eventItem(e, { domains, scoring, audit: auditFor(d), number: i + 1 })).join("\n")}</div></section>`;
  });

  const archiveBody = `<main class="editorial-main" id="main-content"><div class="edition-context"><div class="context-copy"><span id="view-title">归档</span><span id="result-count" aria-live="polite">${archiveEvents.length} 条记录</span><span id="applied-filters"></span></div><div class="v2-sort"><span id="sort-caption">排序</span><button id="sort-trigger" class="v2-sort-trigger" type="button" popovertarget="sort-menu" aria-haspopup="menu" aria-expanded="false" aria-labelledby="sort-caption sort-label"><span id="sort-label">推进强度</span>${icon("chevron")}</button></div></div><div id="story-list" class="archive-feed">${timeline.join("\n")}</div><p id="empty-results" class="empty-state" hidden>这个筛选范围内没有记录。请调整搜索或筛选条件。</p></main>`;

  writeText(
    path.join(site, "archive.html"),
    layout({
      title: "时间轴 · AI 替代进程",
      depth: 0,
      active: "archive.html",
      context: "🕓 归档",
      body: archiveBody,
      latest,
      dateRange,
      sidebar: editorialSidebar(archiveEvents, domains, { depth: 0, dates, dateRange }),
    }),
  );

  // ---------- 方法页 ----------
  const latestReport = latest ? runReports[latest] : null;
  const evidenceRows = Object.entries(scoring.evidenceTypes)
    .filter(([k]) => k !== "$comment")
    .map(([k, v]) => `<tr><td><code>${k}</code></td><td>${escapeHtml(v.label)}</td><td class="score">${v.prior}</td><td>${escapeHtml(v.desc)}</td></tr>`)
    .join("\n");
  const domainRows = domains
    .map((d) => `<tr><td><code>${d.key}</code></td><td>${escapeHtml(d.emoji)} ${escapeHtml(d.label)}</td><td>${escapeHtml(d.blurb)}</td><td class="score">${d.dailyBaseline}</td><td class="score">${d.scale}</td></tr>`)
    .join("\n");

  const evidenceCapRows = Object.entries(scoring.valueCaps?.caps ?? {})
    .map(([k, v]) => `<tr><td><code>${k}</code></td><td>${escapeHtml(scoring.evidenceTypes?.[k]?.label ?? k)}</td><td class="score">≤ ${Number(v).toFixed(2)}</td></tr>`)
    .join("\n");

  const latestDist = latestReport?.distribution ?? null;
  const latestAuditReport = latest ? auditLoader?.(latest) ?? null : null;

  const calibrationBlock = latestDist
    ? `<table>
<tr><th>指标</th><th>最新一天</th><th>预期</th></tr>
<tr><td>value 中位数</td><td class="score">${latestDist.medianValue}</td><td>${(scoring.calibration?.expectedMedianValue ?? [0.3, 0.55]).join(" – ")}</td></tr>
<tr><td>value 四分位（p25 / p75）</td><td class="score">${latestDist.p25Value} / ${latestDist.p75Value}</td><td>—</td></tr>
<tr><td>高价值(≥0.7)占比</td><td class="score">${(latestDist.highValueShare * 100).toFixed(0)}%</td><td>≤ ${((scoring.calibration?.expectedHighValueShare ?? 0.15) * 100).toFixed(0)}%</td></tr>
<tr><td>confidence 中位数</td><td class="score">${latestDist.medianConfidence}</td><td>${(scoring.calibration?.expectedMedianConfidence ?? [0.4, 0.75]).join(" – ")}</td></tr>
<tr><td>因「无具体依据」被截断</td><td class="score">${latestDist.cappedByBasis}</td><td>越少越好</td></tr>
<tr><td>因「证据类型不足」被截断</td><td class="score">${latestDist.cappedByEvidenceType}</td><td>—</td></tr>
<tr><td>引文未通过核对</td><td class="score">${latestDist.unverifiedQuotes}</td><td>0 最佳</td></tr>
</table>
<p>流水线每天自动比对这张表。中位数或高价值占比越界时，运行日志会给出「评分分布告警」，说明当天 AI 打分整体偏宽或偏严——这类漂移是这类系统的头号故障模式。</p>`
    : "<p>尚未有运行记录。</p>";
  const healthTable = (healthRows ?? [])
    .map(
      (h) => `<tr>
  <td>${escapeHtml(h.name)}</td>
  <td><code>${escapeHtml(h.id)}</code></td>
  <td>${h.lastStatus === 200 ? '<span class="pos">可用</span>' : h.lastStatus ? `<span class="neg">HTTP ${h.lastStatus}</span>` : '<span class="zero">未探测</span>'}</td>
  <td class="score">${h.successes}</td>
  <td class="score">${h.failures}</td>
  <td>${escapeHtml(truncate(h.lastError || "—", 60))}</td>
</tr>`,
    )
    .join("\n");

  const methodBody = `<main class="editorial-main method-main" id="main-content"><section class="head">
  <h1>方法与口径</h1>
  <p class="sub">这个站点如何产生每日记录、分数意味着什么、以及它在哪里不可靠。</p>
</section>
<div class="prose">
<h2>1. 每日流水线</h2>
<ol>
  <li><strong>原始资讯采集</strong>：读取 <code>config/sources.json</code> 中注册的全部源（RSS/Atom 与 JSON API），带超时、重试与同源节流，原文缓存到 <code>data/raw/&lt;日期&gt;/</code>。单个源失败不影响整体。</li>
  <li><strong>规则初筛</strong>：按日期窗口剔除旧闻、按 <code>data/seen.json</code> 剔除已收录条目、按正/负词典剔除离题与征稿通知，再用优先级评分把候选收敛到可承受规模。</li>
  <li><strong>AI 初筛</strong>：批量送入 ${escapeHtml(scoring.models.screening)}，判断相关性、领域、初版价值/替代度/方向与证据类型；灰区相似对交由 AI 复核是否同一事件。</li>
  <li><strong>相似合并</strong>：标题 2-gram Jaccard + 摘要 SimHash 聚类，同一事件只保留一条主记录，其余记为「另有来源」——多来源独立报道本身是可信度信号。</li>
  <li><strong>内容填充</strong>：批量送入 ${escapeHtml(scoring.models.enrichment)}，生成中文摘要、关键词、原文证据片段与最终评分。</li>
  <li><strong>落盘与展示</strong>：写入 <code>data/events/&lt;日期&gt;.json</code>，重算指数，再渲染成静态 HTML 到 <code>site/</code>。</li>
</ol>

<h2>2. 两个频道：学术界与互联网</h2>
<p>每条记录归入一个频道，<strong>按来源划分</strong>（不是按内容临时判断）：</p>
<ul>
  <li><strong>学术界（科研成果）</strong>：arXiv、期刊、独立基准机构 —— 产出是论文与理论结果。</li>
  <li><strong>互联网（实时热点）</strong>：热榜、社区（Hacker News / Reddit / V2EX / Lobsters）、科技媒体、大公司动态、产品榜 —— 反映当下互联网在关注什么。</li>
</ul>
<p>归属只在 AI 初筛阶段判定一次，后续环节不再改写——两个阶段各判一次会互相覆盖（实测填充阶段把互联网条目几乎全改回 academia）。</p>

<h3>互联网频道的相关性口径更宽</h3>
<p>学术界要求能指出「哪类人类工作会变少」。互联网频道<strong>允许间接关系</strong>：一个好用的产品、一种新的交互方式、一次成本大幅下降，都可能具备<strong>替代潜力</strong>，即使当下还没人因此失业。</p>
<p>但仍然<strong>必须与 AI 或自动化有关</strong>：热榜里排名第一的娱乐、体育、时政新闻照样排除（实测抓取的今日头条热榜前三是「日媒惊呼中国队出了怪物级天才」这类内容）。</p>

<h3>「直接」与「潜力」分开算</h3>
<p>每条记录带 <code>relation</code> 字段：</p>
<ul>
  <li><code>direct</code>：能指出已被替代的具体岗位或流程 —— <strong>计入指数</strong>。</li>
  <li><code>indirect</code>：只是具备替代潜力，关系是间接的 —— 页面照常显示，但<strong>贡献恒为 0，不计入指数</strong>。</li>
</ul>
<p>这么做是因为「这个产品有替代潜力」是<strong>推断</strong>而不是<strong>观测</strong>。把推断计入进程指数，会让「AI 取代人类」看起来比实际快——正是这个项目一开始花大力气修掉的评分膨胀。判断不了时一律按 <code>indirect</code> 处理，宁可低估。</p>
<p>频道页头部会同时给出两个数字：直接替代 N 条（计入指数）、具备潜力 M 条（不计入指数）。</p>

<h3>为什么用滚动窗口</h3>
<p>频道页取<strong>近 7 天</strong>，而不是单日。原因是发布日 ≠ 采集日：公司博客和媒体常在发布几天后才被采到，而事件日期取发布日是对的。只看单日会让互联网频道几乎空掉。带灰色日期标签的条目不是今天发布的。</p>

<h2>3. 事件 schema</h2>
<pre>${escapeHtml(JSON.stringify(
    {
      date: "2026-09-27",
      sector: "internet",
      domain: "healthcare",
      value: 0.62,
      delta: 0.03,
      model: "xxx",
      source_url: "https://...",
      evidence_quote: "原文片段",
      evidence_type: "third_party_reproduced",
      confidence: 0.9,
    },
    null,
    2,
  ))}</pre>
<p>前九个字段是约定 schema。此外每条记录还带有用于展示与审计的字段：<code>id</code>、<code>title</code>、<code>summary_zh</code>、<code>keywords</code>、<code>why_zh</code>、<code>displacement</code>、<code>direction</code>、<code>ai_systems</code>、<code>evidence_verified</code>、<code>source_name</code>、<code>also_reported_by</code>、<code>screened_by</code>、<code>scored_by</code>、<code>index_contribution</code>。</p>
<p>其中 <code>model</code> 指<strong>事件涉及的 AI 系统</strong>（如某个模型或产品），给这条内容打分的模型记录在 <code>scored_by</code>。</p>

<h2>4. 三个分数</h2>
<table>
<tr><th>字段</th><th>含义</th><th>口径</th></tr>
<tr><td><code>value</code></td><td>推进强度 0-1</td><td>该事件在「AI 承担原本由人类完成的任务」这条轴上推进了多少</td></tr>
<tr><td><code>displacement</code></td><td>替代程度 0-1</td><td>该环节的人类角色可以被移除到什么程度（1 = 整环替代）</td></tr>
<tr><td><code>confidence</code></td><td>可信度 0-1</td><td>由证据类型基准出发，按独立性与可复现性调整；引文无法在原文中核对时会显著下调</td></tr>
</table>

<h3>value 档位</h3>
<table><tr><th>区间</th><th>档位</th><th>说明</th></tr>
${scoring.valueRubric.bands.map((b) => `<tr><td class="score">${b.min.toFixed(2)}-${(b.max ?? 1).toFixed(2)}</td><td>${escapeHtml(b.label)}</td><td>${escapeHtml(b.desc)}</td></tr>`).join("\n")}
</table>

<h2>5. 证据类型</h2>
<table><tr><th>key</th><th>名称</th><th>基准可信度</th><th>说明</th></tr>
${evidenceRows}
</table>
<p><strong>证据核对闸门</strong>：模型给出的 <code>evidence_quote</code> 会被程序逐字回查原文，核对不上的引文不会写入，同时该条 <code>confidence</code> 乘 0.6。这是防止模型编造引文的主要手段。</p>

<h2>6. 指数与 delta</h2>
<p>每个领域有一个 0-100 的进程指数，用饱和曲线把累计贡献映射成指数：</p>
<pre>贡献 c = direction × value × confidence        （advance = +1，setback = −1，neutral = 0）
指数 I = 100 × (1 − e^(−累计贡献 / K))
      K = dailyBaseline × horizonDays           （horizonDays = ${scoring.indexModel?.horizonDays ?? 90}）

单条事件的 delta = I(累计值 + c) − I(累计值)
</pre>
<p><code>dailyBaseline</code> 是该领域的日均贡献基线，<code>K</code> 由它推导。这样定义的好处是：在正常节奏下，<strong>每个领域的指数都约在 ${scoring.indexModel?.horizonDays ?? 90} 天后达到 63%</strong>，日环比变化量级统一（正常一天合计约 +1 到 +3），单日热点不会把不同领域拉出量级差异。</p>
<p>因此<strong>同一领域同一天所有事件的 delta 之和，恒等于该领域当日指数变化量</strong>——可加、可核验。流水线每次运行都会独立复算一遍并断言这个恒等式。</p>
<p>指数刻意用饱和曲线：单日热点不会把指数顶满，长期累积才会。它衡量的是「自基准日起的累计进程」，不是绝对真值，也不能跨领域直接比较。</p>
<table><tr><th>key</th><th>领域</th><th>范围</th><th>日均基线</th><th>尺度 K</th></tr>
${domainRows}
</table>

<h2>7. 硬闸门：证据不足就不许给高分</h2>
<p>光靠提示词约束不了模型。因此有两道<strong>代码强制</strong>的闸门，在 AI 打分之后套用：</p>
<ol>
  <li><strong>依据闸门</strong>：<code>value ≥ ${scoring.screening?.requireAbove ?? 0.65}</code> 时必须填写 <code>evidence_basis</code>（具体基准名与数字，或真实部署规模）。写不出具体依据的，直接压到 ≤ ${scoring.screening?.basislessValueCap ?? 0.6}。</li>
  <li><strong>证据类型闸门</strong>：证据类型决定 value 的上限——没有对应等级的证据，就不允许给出对应等级的推进强度。</li>
</ol>
<table><tr><th>证据类型</th><th>名称</th><th>value 上限</th></tr>
${evidenceCapRows}
</table>
<p>被闸门截断的记录在列表里带 <sup>*</sup> 标记，字段里带 <code>value_capped</code>。</p>

<h2>8. 评分分布自检</h2>
${calibrationBlock}

<h2>8b. <span id="audit"></span>跨模型独立复核</h2>
<p>评分通胀是这类系统最主要的失效模式，而<strong>同一个模型无法发现自己的偏差</strong>——让它自查，结果会和打分时高度相关。所以另设一个复核脚本，用<strong>不同族的模型</strong>重新给当天事件打分，专门找被高估的条目：</p>
<pre>npm run audit -- --date ${escapeHtml(latest ?? "YYYY-MM-DD")}              # 用 .env 配置的模型复核（默认 deepseek 系）
npm run audit -- --date ${escapeHtml(latest ?? "YYYY-MM-DD")} --sample 30  # 只抽查价值最高的 30 条
npm run audit -- --date ${escapeHtml(latest ?? "YYYY-MM-DD")} --engine codex  # 交给 codex agent 深度复核</pre>
<p>复核结果落在 <code>data/audits/&lt;日期&gt;.json</code>，与原评分不一致的条目会在列表里带「复核」标记。<strong>复核不会自动改写分数</strong>——单个复核模型的判断同样可能错，它的作用是产生一个可人工抽查的候选清单，而不是自动裁决。</p>
${latestAuditReport
  ? `<p>最近一次复核（<code>${escapeHtml(latestAuditReport.auditor_model)}</code>，engine=${escapeHtml(latestAuditReport.engine)}，比对 ${latestAuditReport.summary.compared} 条）：平均差 <b class="score">${latestAuditReport.summary.meanDiff}</b>，一致率 <b class="score">${(latestAuditReport.summary.agreeRate * 100).toFixed(0)}%</b>，判为高估 ${latestAuditReport.summary.overScored} 条、领域不一致 ${latestAuditReport.summary.domainMismatch} 条。</p>
<p style="color:var(--fg-faint);font-size:13px">结论：${latestAuditReport.summary.verdict.map((v) => escapeHtml(v)).join("；")}</p>`
  : "<p>还没有复核记录。首次运行的发现通常是「安全/评测类基准被误判为劳动替代」与「预印本自述被高估」这两类。</p>"}

<h2>9. 数据源健康</h2>
<p>流水线每次运行都会记录每个源的可用性；连续失败 ${sourcesConfig.settings?.healthSkipAfterFailures ?? 3} 次的源会被临时跳过（${sourcesConfig.settings?.healthCooldownDays ?? 7} 天冷却），可用 <code>--force-sources</code> 强制重试。</p>
<table><tr><th>源</th><th>id</th><th>状态</th><th>成功</th><th>失败</th><th>最近错误</th></tr>
${healthTable || '<tr><td colspan="6">尚未运行过流水线</td></tr>'}
</table>

<h2>10. 已知局限</h2>
<ul>
  <li><strong>来源覆盖取决于网络可达性</strong>。当前环境下大量媒体与期刊站点不可达，因此记录偏向预印本与官方博客，这对「真实岗位替代」类事件不敏感。</li>
  <li><strong>评分是模型判断，不是测量</strong>。同一事件换一个模型可能差 0.1-0.2。档位表与证据类型权重是为了压低这种漂移，但不能消除。</li>
  <li><strong>预印本不等于事实</strong>。大量记录的 <code>evidence_type</code> 是 <code>preprint</code>，其可信度基准仅 0.55。</li>
  <li><strong>指数不可跨领域比较</strong>。各领域的 K 与事件密度不同，只适合看单领域随时间的走向。</li>
  <li><strong>分数通胀是主要风险</strong>。模型倾向于把普通论文打成「显著跃升」。上述两道硬闸门与分布自检就是为了压制它，但仍需人工抽查。</li>
  <li><strong>候选上限</strong>：初筛候选上限 ${scoring.screening.candidatesCap} 条、填充上限 ${scoring.screening.enrichCap} 条，超出部分留待提高配置后处理。</li>
</ul>

<h2>11. 复现</h2>
<pre>npm run pipeline            # 完整跑一次当日流水线
npm run pipeline -- --date 2026-09-27 --refresh   # 指定日期并强制刷新源
npm run pipeline -- --offline                     # 只用本地缓存，不联网
npm run render              # 只重算指数并重新渲染 HTML
npm run probe               # 探测数据源可达性</pre>
<p>所有 AI 调用按 prompt 哈希缓存在 <code>data/cache/ai/</code>，同一天重跑不会重复计费，结果可复现。</p>
</div></main>`;

  writeText(path.join(site, "method.html"), layout({ title: "方法与口径 · AI 替代进程", depth: 0, active: "method.html", body: methodBody, latest, dateRange, showTools: false }));

  log("info", `渲染完成：site/（学术界 + 互联网 + ${dates.length} 个日期页 + ${indexData.domains.length} 个领域页 + 归档 + 方法页）`);
}

export { round, exists };
