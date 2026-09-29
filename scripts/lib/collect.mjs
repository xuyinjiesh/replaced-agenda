import path from "node:path";
import { fetchCached, loadHealth, recordHealth, saveHealth, shouldSkipByHealth } from "./http.mjs";
import { parseFeed, looksLikeFeed } from "./xml.mjs";
import { canonicalUrl, cleanText, truncate } from "./text.mjs";
import { createLimiter, log, sha256, sleep } from "./util.mjs";

const HEALTH_FILE = "data/source-health.json";

function normalizeItem(raw, source, now) {
  const url = canonicalUrl(raw.url);
  if (!url || !raw.title) return null;
  const summary = cleanText(raw.summary).slice(0, 4000);
  return {
    id: sha256(url).slice(0, 16),
    sourceId: source.id,
    sourceName: source.name,
    sourceGroup: source.group,
    title: cleanText(raw.title),
    url: raw.url,
    canonicalUrl: url,
    summary,
    published: raw.published ?? null,
    authors: raw.authors ?? [],
    categories: raw.categories ?? [],
    hintDomain: source.hintDomain ?? null,
    // 「学术界 / 互联网」的来源先验；最终归属由 AI 按内容判定，这里只是提示
    sectorHint: source.sector ?? null,
    // 自述型来源的证据类型上限（见 config/sources.json 的 evidenceCeiling）
    evidenceCeiling: source.evidenceCeiling ?? null,
    fetchedAt: now,
  };
}

/**
 * 采集阶段：抓取全部启用的数据源，解析成统一条目。
 * 单个源失败不会中断整体流程，只记录健康度。
 */
export async function collect({ root, sourcesConfig, date, refresh = false, forceSources = false, offline = false }) {
  const settings = sourcesConfig.settings ?? {};
  const healthFile = path.join(root, HEALTH_FILE);
  const health = loadHealth(healthFile);
  const limiter = createLimiter(settings.concurrency ?? 3);
  const rawDir = path.join(root, "data", "raw", date);
  const now = new Date().toISOString();

  const enabled = sourcesConfig.sources.filter((s) => s.enabled !== false);
  const skipped = [];
  const targets = [];
  for (const s of enabled) {
    if (!forceSources && shouldSkipByHealth(health, s.id, {
      afterFailures: settings.healthSkipAfterFailures ?? 3,
      cooldownDays: settings.healthCooldownDays ?? 7,
    })) {
      skipped.push(s.id);
      continue;
    }
    targets.push(s);
  }
  if (skipped.length) {
    log("info", `按健康度跳过 ${skipped.length} 个长期不可达的源（--force-sources 可强制重试）`);
  }

  const results = await Promise.all(
    targets.map((source) =>
      limiter(async () => {
        const cacheFile = path.join(rawDir, `${source.id}.${source.kind === "json" ? "json" : "xml"}`);
        const res = await fetchCached(source.url, {
          cacheFile,
          refresh,
          offline,
          timeoutMs: settings.timeoutMs ?? 20000,
          retries: settings.retries ?? 3,
          perHostDelayMs: settings.perHostDelayMs ?? 0,
        });
        if (!res.ok) {
          if (offline) {
            return { source, ok: false, items: [], error: res.error, offlineMiss: true };
          }
          recordHealth(health, source.id, res);
          return { source, ok: false, items: [], error: res.error || `HTTP ${res.status}` };
        }
        let items = [];
        let parseError = "";
        try {
          if (source.kind === "json") {
            items = parseJsonSource(res.body, source);
          } else {
            if (!looksLikeFeed(res.body)) throw new Error("响应不是 feed");
            const parsed = parseFeed(res.body, { feedTitle: source.name, feedUrl: source.url });
            items = parsed.items;
          }
        } catch (err) {
          parseError = String(err?.message ?? err);
        }
        const normalized = items
          .map((it) => normalizeItem(it, source, now))
          .filter(Boolean)
          .slice(0, source.maxItems ?? 40);
        if (parseError) {
          recordHealth(health, source.id, { ok: false, error: `解析失败: ${parseError}` });
          return { source, ok: false, items: [], error: `解析失败: ${parseError}` };
        }
        recordHealth(health, source.id, { ok: true, status: 200 });
        return { source, ok: true, items: normalized, error: "" };
      }),
    ),
  );

  saveHealth(healthFile, health);

  const all = [];
  const seen = new Set();
  for (const r of results) {
    for (const it of r.items) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      all.push(it);
    }
  }

  const okSources = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const report = {
    date,
    checkedAt: now,
    sources: results.map((r) => ({
      id: r.source.id,
      name: r.source.name,
      group: r.source.group,
      ok: r.ok,
      items: r.items.length,
      error: r.error || "",
      cachedOnly: Boolean(r.offlineMiss),
    })),
    okCount: okSources.length,
    failedCount: failed.length,
    skippedByHealth: skipped,
    itemCount: all.length,
  };
  log(
    "info",
    `采集完成：${okSources.length}/${results.length} 个源可用，共 ${all.length} 条原始条目`,
    failed.length ? `失败: ${failed.map((f) => f.source.id).join(",")}` : undefined,
  );
  return { items: all, report };
}

function parseJsonSource(body, source) {
  const data = JSON.parse(body);
  const mapper = JSON_SOURCE_MAPPERS[source.id];
  if (!mapper) return [];
  return mapper(data, source);
}

const JSON_SOURCE_MAPPERS = {
  // 热榜类源没有正文，只有标题与热度。这里把热度写成 summary，
  // 让下游知道「这条是靠榜位与热度进来的」，而不是靠一篇文章。
  "toutiao-hot": (data) =>
    (data.data ?? []).map((row, i) => ({
      title: row.Title ?? row.title ?? "",
      url: row.Url ?? row.url ?? `https://www.toutiao.com/trending/${row.ClusterId ?? ""}`,
      summary:
        `今日头条实时热榜第 ${i + 1} 位，热度 ${row.HotValue ?? row.hot_value ?? "未知"}。` +
        `热榜只提供条目名称与热度，不含正文，需要结合标题本身判断与 AI 替代的关系。`,
      published: null,
      authors: [],
      categories: ["hotlist", `rank:${i + 1}`],
    })),
  "hn-algolia": (data) =>
    (data.hits ?? []).map((h) => ({
      title: h.title ?? h.story_title ?? "",
      url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
      summary: h.story_text ?? h.comment_text ?? "",
      published: h.created_at ?? null,
      authors: h.author ? [h.author] : [],
      categories: [],
    })),
};

export { truncate, sleep };