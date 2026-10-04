import fs from "node:fs";
import path from "node:path";
import { escapeHtml } from "./text.mjs";
import { icon, layout, link } from "./render-shell.mjs";
import { renderMethodBody } from "./render-method.mjs";
import { cls, dateNavigation, domainMeta, editorialSidebar, eventItem, fmtSigned, listSection } from "./render-records.mjs";
import { ensureDir, exists, log, round, writeText } from "./util.mjs";

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
  const dateRange = dates.length ? `${dates[0].slice(5)} — ${dates.at(-1).slice(5)}` : "";

  // ---------- 两个频道页 ----------
  const WINDOW = 7; // 频道页的滚动窗口天数
  for (const key of SECTOR_ORDER) {
    const meta = SECTOR_META[key];
    const win = windowEvents(key, dates, dayLoader, WINDOW, latest);
    const events = win.events;
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

  const methodBody = renderMethodBody({ latest, runReports, auditLoader, scoring, domains, healthRows, sourcesConfig });

  writeText(path.join(site, "method.html"), layout({ title: "方法与口径 · AI 替代进程", depth: 0, active: "method.html", body: methodBody, latest, dateRange, showTools: false }));

  log("info", `渲染完成：site/（学术界 + 互联网 + ${dates.length} 个日期页 + ${indexData.domains.length} 个领域页 + 归档 + 方法页）`);
}

export { round, exists };
