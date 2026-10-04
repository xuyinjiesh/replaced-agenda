import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { AIClient } from "./lib/ai.mjs";
import { applyModelOverrides } from "./lib/providers.mjs";
import { collect } from "./lib/collect.mjs";
import { dedupe, applyMergeDecisions, sourceStats } from "./lib/dedupe.mjs";
import { aiEnrich } from "./lib/enrich.mjs";
import { describeHealth } from "./lib/http.mjs";
import { renderSite } from "./lib/render.mjs";
import { aiMergeGray, aiScreen, rulePrefilter } from "./lib/screen.mjs";
import { computeIndex, resolveDomains, toEvent, verifyIndex } from "./lib/score.mjs";
import {
  listEventDates,
  loadAllEvents,
  loadDay,
  loadIndex,
  loadSeen,
  mergeDay,
  paths,
  publishData,
  saveDay,
  saveIndex,
  saveRun,
  saveSeen,
} from "./lib/store.mjs";
import { isDateISO, log, parseArgs, readJSON, setLogLevel, todayISO } from "./lib/util.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

async function main() {
  const args = parseArgs();
  if (args["log-level"]) setLogLevel(String(args["log-level"]));
  const started = Date.now();

  const domainsConfig = readJSON(path.join(ROOT, "config", "domains.json"));
  const scoring = readJSON(path.join(ROOT, "config", "scoring.json"));
  const sourcesConfig = readJSON(path.join(ROOT, "config", "sources.json"));
  const domains = resolveDomains(domainsConfig.domains, scoring);
  const p = paths(ROOT);

  const skipCollect = Boolean(args["skip-collect"]);
  const skipEnrich = Boolean(args["skip-enrich"]);
  const skipAI = Boolean(args["skip-ai"]);
  const renderDate = skipCollect && (skipEnrich || skipAI) ? listEventDates(ROOT).at(-1) : null;
  const date = String(args.date ?? renderDate ?? todayISO());
  if (!isDateISO(date)) throw new Error(`--date 需要 YYYY-MM-DD 格式，收到 ${date}`);
  const offline = Boolean(args.offline);
  const reprocess = Boolean(args.reprocess);
  const refresh = Boolean(args.refresh);
  const dryRun = Boolean(args["dry-run"]);
  const windowDays = Number(args["window-days"] ?? 3);

  const effectiveScoring = structuredClone(scoring);
  // 模型名允许被环境变量覆盖（AI_MODEL_NAME 或阶段专属变量），避免把厂商模型名写死在 config 里
  effectiveScoring.models = applyModelOverrides(effectiveScoring.models, { root: ROOT });
  if (args["max-candidates"]) effectiveScoring.screening.candidatesCap = Number(args["max-candidates"]);
  if (args["max-enrich"]) effectiveScoring.screening.enrichCap = Number(args["max-enrich"]);

  log("info", `=== 流水线开始 date=${date}${dryRun ? " (dry-run)" : ""}${offline ? " (offline)" : ""} ===`);

  // ---------- 1. 采集 ----------
  let collectReport = loadRunReport(date)?.stages?.collect ?? null;
  let items = [];
  if (skipCollect) {
    log("info", "跳过采集：复用 data/raw 与已有 day 文件");
    items = [];
  } else {
    const res = await collect({
      root: ROOT,
      sourcesConfig,
      date,
      refresh,
      forceSources: Boolean(args["force-sources"]),
      offline,
    });
    items = res.items;
    collectReport = res.report;
  }

  // ---------- 2. 规则初筛 ----------
  const seen = reprocess ? {} : loadSeen(ROOT);
  if (reprocess) log("warn", "--reprocess：忽略 seen.json，重新评估窗口内全部条目");
  const { candidates, stats: prefilterStats } = rulePrefilter(items, {
    scoring: effectiveScoring,
    date,
    windowDays,
    seen,
    cap: effectiveScoring.screening.candidatesCap,
  });

  // ---------- 3. 规则去重 ----------
  const ruleDedupe = dedupe(candidates, effectiveScoring.dedupe);

  // ---------- 4. AI 初筛 ----------
  const client = new AIClient({
    cacheDir: p.cacheDir,
    concurrency: Number(args.concurrency ?? 3),
    offline,
    root: ROOT,
    timeoutMs: Number(args["ai-timeout"] ?? scoring.ai?.timeoutMs ?? 180000),
  });

  let screened;
  if (skipAI) {
    log("warn", "--skip-ai：跳过 AI 阶段，直接把候选当作通过（仅用于调试）");
    screened = {
      kept: ruleDedupe.merged.map((it) => ({
        ...it,
        relevance: 0.5,
        domain: it.hintDomain ?? "software",
        value: 0.4,
        displacement: 0.3,
        direction: "advance",
        evidenceType: "unknown",
        aiSystems: [],
        screenReason: "skip-ai",
      })),
      stats: { batches: 0, failed: 0, droppedByAI: 0, droppedByThreshold: 0, badDomain: 0 },
    };
  } else {
    screened = await aiScreen(client, ruleDedupe.merged, { domains, scoring: effectiveScoring, dryRun });
  }

  // ---------- 5. AI 灰区合并（只对通过初筛的条目复核） ----------
  let keptMerged = screened.kept;
  let grayStats = { asked: 0, merged: 0 };
  if (!skipAI && screened.kept.length > 1) {
    const second = dedupe(screened.kept, effectiveScoring.dedupe);
    if (second.grayPairs.length) {
      const { decisions, stats } = await aiMergeGray(client, second.prepared, second.grayPairs, {
        scoring: effectiveScoring,
      });
      grayStats = stats;
      if (decisions.length) {
        const applied = applyMergeDecisions(screened.kept, decisions);
        keptMerged = applied.merged;
        log("info", `灰区合并生效：${screened.kept.length} → ${keptMerged.length} 条`);
      }
    }
  }

  // ---------- 6. 内容填充 ----------
  let enriched = [];
  let enrichStats = { batches: 0, failed: 0, unverifiedQuotes: 0, emptyQuotes: 0 };
  if (skipEnrich || skipAI) {
    log("warn", "跳过内容填充：直接使用初筛判定（confidence 会被保守下调）");
    enriched = keptMerged.map((it) => ({
      ...it,
      summaryZh: it.title,
      keywords: ["AI"],
      whyZh: it.screenReason ?? "",
      evidenceQuote: "",
      evidenceVerified: false,
      evidenceMatchRatio: 0,
      model: it.aiSystems?.[0] ?? "未指明",
      confidence: Math.round(Math.min(0.45, it.value * 0.5) * 1000) / 1000,
      enriched: false,
    }));
  } else {
    const res = await aiEnrich(client, keptMerged, {
      scoring: effectiveScoring,
      domains,
      cap: effectiveScoring.screening.enrichCap,
    });
    enriched = res.enriched;
    enrichStats = res.stats;
  }

  if (dryRun) {
    log("info", "dry-run：不写盘、不渲染。样例输出：");
    console.log(JSON.stringify(enriched.slice(0, 3).map((e) => toEvent(e, { scoring: effectiveScoring })), null, 2));
    return;
  }

  // ---------- 7. 生成记录 ----------
  const newEvents = enriched.map((e) => toEvent(e, { scoring: effectiveScoring }));
  const existingDay = loadDay(ROOT, date);
  const { events: dayEvents, added, updated, total } = mergeDay(existingDay, newEvents, { date });
  log("info", `当日记录：新增 ${added} 条，更新 ${updated} 条，共 ${total} 条`);

  // ---------- 8. 全量重算指数 ----------
  const previousDays = listEventDates(ROOT)
    .filter((d) => d !== date)
    .map((d) => loadDay(ROOT, d))
    .filter(Boolean);
  const allEvents = [...previousDays.flatMap((d) => d.events ?? []), ...dayEvents];
  const indexData = computeIndex(allEvents, { domains, epoch: scoring.indexModel.epoch });
  const verification = verifyIndex(allEvents, { domains });

  // 把重算后的 delta / 指数写回每一天的文件，保证整份语料自洽
  const byDate = new Map();
  for (const e of allEvents) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }
  for (const [d, evs] of byDate) {
    const prev = loadDay(ROOT, d);
    const sorted = [...evs].sort((a, b) => b.value - a.value || b.delta - a.delta || a.id.localeCompare(b.id));
    const domSummary = indexData.domains
      .map((dm) => {
        const row = (dm.series ?? []).find((s) => s.date === d);
        return row && (row.events > 0 || row.delta !== 0) ? { domain: dm.domain, ...row } : null;
      })
      .filter(Boolean);
    saveDay(ROOT, d, sorted, {
      generated_at: prev?.generated_at ?? new Date().toISOString(),
      recomputed_at: new Date().toISOString(),
      previous_event_count: prev?.event_count ?? 0,
      domains: domSummary,
      stats: prev?.stats ?? null,
    });
  }
  saveIndex(ROOT, {
    ...indexData,
    source_stats: sourceStats(dayEvents),
    verification,
  });

  // ---------- 9. 记录已见，避免明天重复收录 ----------
  const seenNext = { ...seen };
  for (const e of dayEvents) {
    if (!seenNext[e.id]) seenNext[e.id] = e.date;
  }
  saveSeen(ROOT, seenNext);

  // ---------- 10. 运行报告 ----------
  const healthRows = describeHealth(
    readJSON(path.join(ROOT, "data", "source-health.json"), { sources: {} }),
    sourcesConfig.sources,
  );
  const distribution = valueDistribution(dayEvents);
  const calibration = checkCalibration(distribution, scoring.calibration);
  const report = {
    date,
    started_at: new Date(started).toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    flags: { offline, refresh, skipCollect, skipEnrich, skipAI, windowDays },
    mode: skipCollect && (skipEnrich || skipAI) ? "render-only" : "full",
    stages: {
      // 只重渲染时，保留上一轮真实跑出来的阶段统计，避免用空数据覆盖
      ...(skipCollect ? (loadRunReport(date)?.stages ?? {}) : {}),
      collect: collectReport,
      prefilter: prefilterStats,
      ruleDedupe: { input: candidates.length, output: ruleDedupe.merged.length },
      screen: screened.stats,
      grayMerge: grayStats,
      enrich: enrichStats,
    },
    day: { added, updated, total },
    domainCounts: Object.fromEntries(
      domains.map((d) => [d.key, dayEvents.filter((e) => e.domain === d.key).length]).filter(([, n]) => n > 0),
    ),
    index: {
      totalDelta: indexData.totalDelta,
      domains: indexData.domains.map((d) => ({ domain: d.domain, index: d.index, delta: d.delta, events: d.events })),
    },
    verification,
    distribution,
    calibration,
    ai: { ...client.stats, ...client.info },
    sourceStats: sourceStats(dayEvents),
  };
  saveRun(ROOT, date, report);
  if (!calibration.ok) {
    log("warn", `评分分布告警：${calibration.warnings.join("；")}`);
  } else {
    log("info", `评分分布正常：中位 value ${distribution.medianValue}，高价值占比 ${(distribution.highValueShare * 100).toFixed(0)}%`);
  }

  // ---------- 11. 渲染 ----------
  const dates = listEventDates(ROOT);
  renderSite({
    root: ROOT,
    domains,
    // 方法页要写明「实际送入的是哪个模型」，所以这里同步环境变量的覆盖结果，
    // 保证与事件里的 scored_by 一致
    scoring: { ...scoring, models: effectiveScoring.models },
    indexData: { ...indexData, source_stats: report.sourceStats },
    dates,
    dayLoader: (d) => loadDay(ROOT, d),
    runReports: Object.fromEntries(dates.map((d) => [d, loadRunReport(d)])),
    healthRows,
    sourcesConfig,
    auditLoader: (d) => readJSON(path.join(ROOT, "data", "audits", `${d}.json`), null),
  });
  publishData(ROOT, dates);

  log(
    "info",
    `=== 完成：${dayEvents.length} 条记录，合计 Δ ${indexData.totalDelta >= 0 ? "+" : ""}${indexData.totalDelta.toFixed(3)}，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s ===`,
  );
  log(
    "info",
    `AI 用量：${client.info.provider} · 调用 ${client.stats.calls} 次（缓存命中 ${client.stats.cacheHits}），失败 ${client.stats.failures}，tokens in/out ${client.stats.promptTokens}/${client.stats.completionTokens}`,
  );
  if (!verification.ok) {
    log("error", "指数一致性校验未通过", JSON.stringify(verification.failures));
    process.exitCode = 2;
  }
  log("info", `产物：${path.relative(ROOT, p.dayFile(date))}、${path.relative(ROOT, p.indexFile)}、site/index.html`);
}

function loadRunReport(date) {
  return readJSON(paths(ROOT).runFile(date), null);
}

function quantile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
}

/** 当日评分分布，用于监控 AI 打分是否整体漂移。 */
function valueDistribution(events) {
  const vals = events.map((e) => e.value).sort((a, b) => a - b);
  const confs = events.map((e) => e.confidence).sort((a, b) => a - b);
  const high = vals.filter((v) => v >= 0.7).length;
  const byType = {};
  for (const e of events) byType[e.evidence_type] = (byType[e.evidence_type] ?? 0) + 1;
  return {
    count: events.length,
    medianValue: Number(quantile(vals, 0.5).toFixed(3)),
    p25Value: Number(quantile(vals, 0.25).toFixed(3)),
    p75Value: Number(quantile(vals, 0.75).toFixed(3)),
    maxValue: vals.at(-1) ?? 0,
    medianConfidence: Number(quantile(confs, 0.5).toFixed(3)),
    highValueShare: vals.length ? Number((high / vals.length).toFixed(3)) : 0,
    cappedByBasis: events.filter((e) => (e.value_capped ?? "").includes("no_basis")).length,
    cappedByEvidenceType: events.filter((e) => (e.value_capped ?? "").includes("evidence_type")).length,
    unverifiedQuotes: events.filter((e) => !e.evidence_verified).length,
    evidenceTypes: byType,
  };
}

/** 分布健康度自检：AI 打分整体过宽/过严时给出告警（不阻断流程）。 */
function checkCalibration(dist, cfg) {
  const warnings = [];
  if (!cfg || !dist.count) return { ok: true, warnings };
  const [lo, hi] = cfg.expectedMedianValue ?? [0.3, 0.55];
  if (dist.medianValue < lo || dist.medianValue > hi) {
    warnings.push(`value 中位数 ${dist.medianValue} 超出预期区间 [${lo}, ${hi}]`);
  }
  if (dist.highValueShare > (cfg.expectedHighValueShare ?? 0.15) * 1.6) {
    warnings.push(`高价值(≥0.7)占比 ${(dist.highValueShare * 100).toFixed(0)}% 明显偏高，评分可能过宽`);
  }
  const [clo, chi] = cfg.expectedMedianConfidence ?? [0.4, 0.75];
  if (dist.medianConfidence < clo || dist.medianConfidence > chi) {
    warnings.push(`confidence 中位数 ${dist.medianConfidence} 超出预期区间 [${clo}, ${chi}]`);
  }
  return { ok: warnings.length === 0, warnings };
}

main().catch((err) => {
  log("error", "流水线失败", String(err?.stack ?? err));
  process.exitCode = 1;
});

export { fs };
