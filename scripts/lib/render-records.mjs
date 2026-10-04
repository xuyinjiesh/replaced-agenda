import { escapeHtml } from "./text.mjs";
import { icon, link } from "./render-shell.mjs";

export function domainMeta(domains, key) {
  return domains.find((d) => d.key === key) ?? { key, label: key, emoji: "", scale: 50 };
}

export function fmtSigned(n, digits = 2) {
  const v = Number(n ?? 0);
  const s = v > 0 ? "+" : v < 0 ? "" : "±";
  return `${s}${v.toFixed(digits)}`;
}

export function cls(n) {
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

export function eventItem(e, { domains, scoring, audit, number = 1 }) {
  const dm = domainMeta(domains, e.domain);
  const text = [e.title, e.title_zh, e.summary_zh, e.why_zh, e.evidence_quote, e.source_name, (e.keywords ?? []).join(" "), e.model]
    .join(" ").toLowerCase().replace(/"/g, "'");
  const review = audit?.(e);
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

export function listSection(events, { domains, scoring, title, audit, depth = 0, extra = "" }) {
  return `<main class="editorial-main" id="main-content">
  <div class="edition-context"><div class="context-copy"><span id="view-title">${escapeHtml(title)}</span><span id="result-count" aria-live="polite">${events.length} 条记录</span><span id="applied-filters"></span></div><div class="v2-sort"><span id="sort-caption">排序</span><button id="sort-trigger" class="v2-sort-trigger" type="button" popovertarget="sort-menu" aria-haspopup="menu" aria-expanded="false" aria-labelledby="sort-caption sort-label"><span id="sort-label">推进强度</span>${icon("chevron")}</button></div></div>
${extra ? `  ${extra}` : ""}
  <div class="story-list" id="story-list">${events.map((e, i) => eventItem(e, { domains, scoring, audit, number: i + 1 })).join("\n")}</div>
  <p id="empty-results" class="empty-state" hidden>这个筛选范围内没有记录。请调整搜索或筛选条件。</p>
</main>`;
}

export function editorialSidebar(events, domains, { depth = 0, dates = [], dateRange = "" } = {}) {
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

export function dateNavigation(current, dates, depth) {
  const index = dates.indexOf(current);
  const previous = index > 0 ? dates[index - 1] : null;
  const next = index >= 0 && index < dates.length - 1 ? dates[index + 1] : null;
  return `<nav class="date-navigation" aria-label="日期导航">${previous ? `<a href="${link(depth, `day/${previous}.html`)}">← 前一天 <time datetime="${previous}">${previous}</time></a>` : '<span class="date-nav-empty"></span>'}<a class="date-index-link" href="${link(depth, "archive.html")}">返回归档</a>${next ? `<a href="${link(depth, `day/${next}.html`)}"><time datetime="${next}">${next}</time> 后一天 →</a>` : '<span class="date-nav-empty"></span>'}</nav>`;
}
