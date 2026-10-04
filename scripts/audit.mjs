/**
 * 独立复核：用一个「不同的模型」重新给当天的事件打分，检查是否存在系统性高估/低估或领域误判。
 *
 * 为什么需要它：评分通胀是这类系统最主要的失效模式，而同一个模型无法发现自己的偏差
 * （自查会与打分时高度相关）。跨模型复核是能自动化、且成本可接受的独立信号。
 *
 *   node scripts/audit.mjs --date 2026-09-28                          # 复核模型取 AI_MODEL_AUDIT，未设置则回落到打分模型
 *   node scripts/audit.mjs --date 2026-09-28 --sample 30              # 只抽查价值最高的 30 条
 *   node scripts/audit.mjs --date 2026-09-28 --engine codex           # 交给 codex agent 做深度复核
 *   node scripts/audit.mjs --date 2026-09-28 --model deepseek-v4-pro  # 显式指定复核模型（宜与打分模型不同族）
 *
 * 产物：data/audits/<日期>.json
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveModelName } from "./lib/providers.mjs";
import { loadDay } from "./lib/store.mjs";
import { ensureDir, isDateISO, log, parseArgs, readJSON, todayISO, writeJSON } from "./lib/util.mjs";
import { compareAudit } from "./lib/audit-compare.mjs";
import { createAuditEngines } from "./lib/audit-engines.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = parseArgs();
const date = String(args.date ?? todayISO());
if (!isDateISO(date)) throw new Error(`--date 需要 YYYY-MM-DD，收到 ${date}`);

const day = loadDay(ROOT, date);
if (!day || !day.events?.length) {
  log("error", `${date} 没有可复核的记录（先跑 npm run pipeline）`);
  process.exit(1);
}

const scoring = readJSON(path.join(ROOT, "config", "scoring.json"));
const domainsConfig = readJSON(path.join(ROOT, "config", "domains.json"));
const domains = domainsConfig.domains;

const sampleSize = Number(args.sample ?? 0);
// 默认抽查价值最高的一批：高价值条目判断错，对指数的影响最大
const events = [...day.events].sort((a, b) => b.value - a.value).slice(0, sampleSize > 0 ? sampleSize : day.events.length);

const engine = String(args.engine ?? "chat");
const auditorModel = String(args.model ?? resolveModelName("audit", { root: ROOT, fallback: scoring.models.enrichment }));

const { runChatEngine, runCodexEngine } = createAuditEngines({ root: ROOT, args, date, events, scoring, domains, auditorModel });
const run = engine === "codex" ? runCodexEngine : runChatEngine;
log("info", `=== 独立复核 ${date}（${events.length} 条，engine=${engine}）===`);
const audit = await run();
const { rows, summary } = compareAudit(events, audit.items, scoring);

const outFile = path.join(ROOT, "data", "audits", `${date}.json`);
ensureDir(path.dirname(outFile));
writeJSON(outFile, {
  date,
  engine: audit.engine,
  coverage: audit.coverage ?? null,
  auditor_model: audit.model,
  scored_by: scoring.models.enrichment,
  ran_at: new Date().toISOString(),
  summary,
  auditor_notes: audit.summaries,
  rows: rows.sort((a, b) => a.diff - b.diff),
});

log("info", `复核完成：比对 ${summary.compared} 条，平均差 ${summary.meanDiff}，平均绝对差 ${summary.meanAbsDiff}`);
if (summary.originalMedian !== null) {
  log("info", `中位数对照：原评分 ${summary.originalMedian} vs 复核 ${summary.auditedMedian}（真实区间大致落在这两者之间）`);
}
log("info", `完全一致 ${(summary.agreeRate * 100).toFixed(0)}%，复核更低 ${summary.overScored} 条，复核更高 ${summary.underScored} 条，领域不一致 ${summary.domainMismatch} 条`);
for (const v of summary.verdict) {
  const level = v.includes("可接受") ? "info" : "warn";
  log(level, `结论：${v}`);
}
const worst = rows.filter((r) => r.diff <= -0.15).slice(0, 5);
if (worst.length) {
  log("info", "分歧最大、最值得人工抽查的条目：");
  for (const r of worst) {
    process.stdout.write(`  · [原 ${r.value.toFixed(2)} → 复核 ${r.audited_value.toFixed(2)}] ${r.title}\n    ${r.reason}\n`);
  }
}
log("info", `产物：${path.relative(ROOT, outFile)}`);
