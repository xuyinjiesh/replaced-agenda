/**
 * 独立复核：用一个「不同的模型」重新给当天的事件打分，检查是否存在系统性高估/低估或领域误判。
 *
 * 为什么需要它：评分通胀是这类系统最主要的失效模式，而同一个模型无法发现自己的偏差
 * （自查会与打分时高度相关）。跨模型复核是能自动化、且成本可接受的独立信号。
 *
 *   node scripts/audit.mjs --date 2026-09-28                 # 用 .env 里配置的模型复核（默认 deepseek 系）
 *   node scripts/audit.mjs --date 2026-09-28 --sample 30     # 只抽查价值最高的 30 条
 *   node scripts/audit.mjs --date 2026-09-28 --engine codex  # 交给 codex agent 做深度复核
 *   node scripts/audit.mjs --date 2026-09-28 --model qwen-plus
 *
 * 产物：data/audits/<日期>.json
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AIClient } from "./lib/ai.mjs";
import { NO_THINKING, resolveCredentials } from "./lib/providers.mjs";
import { loadDay, paths } from "./lib/store.mjs";
import { ensureDir, isDateISO, log, parseArgs, readJSON, todayISO, writeJSON } from "./lib/util.mjs";
import { extractJSON, truncate } from "./lib/text.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
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

const creds = resolveCredentials({ root: ROOT });
const engine = String(args.engine ?? "chat");
const auditorModel = String(args.model ?? creds?.defaultModel ?? "qwen-plus");

/**
 * 期望输出的形状说明。
 * 注意：这里只作为「文本契约」写进提示词，不使用 codex 的 --output-schema ——
 * 实测 DashScope 兼容端点上的部分模型不支持结构化输出（会返回
 * `InternalError.Algo.InvalidParameter: This text.format type is unavailable now`），
 * 因此改为从最终消息里容错解析 JSON，兼容性更好。
 */
const AUDIT_CONTRACT = `{
  "summary": "一句话总结这批条目的整体偏差",
  "items": [
    { "id": "事件 id（原样复制）", "value": 0.0, "domain": "${domains.map((d) => d.key).join(" | ")}",
      "verdict": "agree | over_scored | under_scored | misclassified | not_relevant", "reason": "不超过25字" }
  ]
}`;

/**
 * 从模型返回的对象里找出审计条目数组。
 * 实测同一个提示词下，模型会把它叫 items / results / reviews / entries…，
 * 只认 items 会让整批结果静默丢失，所以这里做一次归一化。
 */
function pickAuditItems(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  for (const key of ["items", "results", "reviews", "entries", "audits", "data", "list"]) {
    if (Array.isArray(data[key])) return data[key];
  }
  // 兜底：取第一个「元素是带 id 字段的对象」的数组
  for (const v of Object.values(data)) {
    if (Array.isArray(v) && v.length && v.every((x) => x && typeof x === "object" && "id" in x)) return v;
  }
  return [];
}

function buildPrompt(batch, { withSource }) {
  const payload = batch.map((e) => ({
    id: e.id,
    title: e.title,
    domain_claimed: e.domain,
    value_claimed: e.value,
    displacement_claimed: e.displacement,
    evidence_type: e.evidence_type,
    confidence_claimed: e.confidence,
    evidence_quote: truncate(e.evidence_quote ?? "", 300),
    summary_zh: e.summary_zh,
    source: e.source_name,
    ...(withSource ? { url: e.source_url } : {}),
  }));

  // 复核必须对两个方向都保持中立：如果只要求「找出高估」，审计员会系统性地偏低，
  // 那样测到的就不是原评分的偏差，而是我自己的提示词偏差。
  return `你是一名独立评审，负责用自己的判断重新评估一批「AI 取代人类任务」事件的推进强度。

## 评分口径（与打分方使用同一套档位表）
value = 该事件在「AI 承担原本由人类完成的任务」轴上的推进强度（0-1）。
- 0.90-1.00 可验证地完成/超越人类专业级任务，且有独立验证
- 0.70-0.90 公认基准上大幅提升且有独立验证，或已进入真实生产环境替代人类环节
- 0.50-0.70 明确的能力提升，方法可信，但尚未独立验证或规模有限
- 0.30-0.50 常规改进、小数据集实验、方法组合
- 0.00-0.30 理论探索、与劳动替代关系间接

## 复核要求
- 请在**两个方向**上都保持中立：既指出你认为是高估的，也指出你认为是低估的。
- 你的 value 是你自己的独立判断，不要为了贴近 value_claimed 而调整，也不要为了显得严格而系统性压低。
- 如果领域归类有问题，在 verdict 里用 misclassified 标出。
- 如果某条根本不构成「替代人类任务」，用 not_relevant 标出。

## 待复核条目
${JSON.stringify(payload, null, 1)}

## 输出
对每一条输出 id、你独立判断的 value、你判断的 domain、verdict（agree / over_scored / under_scored / misclassified / not_relevant）、以及不超过 25 字的 reason。
verdict 用 over_scored / under_scored 表示你的 value 与原评分相差 ≥0.15，相差更小就用 agree。
summary 用一句话总结这批条目的整体情况。只输出 JSON。`;
}

const AUDIT_SYSTEM = "你是独立评审员，需要用自己的判断重新评估，既不偏向确认原评分，也不偏向否定它。严格只输出 JSON。";

/** ---- 引擎 A：直接用另一个模型复核 ---- */
async function runChatEngine() {
  // 推理模型（deepseek 系）思维链开销大，批太大容易耗尽 max_tokens 导致输出被截断
  const batchSize = Number(args["batch-size"] ?? 4);
  const batches = [];
  for (let i = 0; i < events.length; i += batchSize) batches.push(events.slice(i, i + batchSize));
  const client = new AIClient({
    cacheDir: paths(ROOT).cacheDir,
    concurrency: Number(args.concurrency ?? 3),
    root: ROOT,
    provider: String(args.provider ?? "auto"),
  });
  log("info", `复核模型：${auditorModel}（与打分模型 ${scoring.models.enrichment} 不同族）`);
  const results = await Promise.all(
    batches.map(async (batch, i) => {
      const res = await client.chatJSON({
        model: auditorModel,
        system: AUDIT_SYSTEM,
        user: buildPrompt(batch, { withSource: false }),
        temperature: 0,
        maxTokens: Number(args["max-tokens"] ?? 8192),
        // 复核模型可能是混合推理模型，默认关掉思考模式，否则输出会被思维链挤爆
        extraBody: args.thinking ? undefined : NO_THINKING,
      });
      if (!res.ok) {
        log("warn", `复核批次 ${i + 1}/${batches.length} 失败`, res.error);
        return { items: [], summary: "", failed: true };
      }
      const items = pickAuditItems(res.data);
      // 静默缺条比报错更危险：返回条数与批大小不符时必须显式告警
      if (items.length !== batch.length) {
        log("warn", `复核批次 ${i + 1}/${batches.length} 条数不符：期望 ${batch.length}，实得 ${items.length}`);
      }
      return { items, summary: typeof res.data?.summary === "string" ? res.data.summary : "" };
    }),
  );
  const expected = events.length;
  const got = results.reduce((n, r) => n + (r.items?.length ?? 0), 0);
  if (got < expected) {
    log("warn", `复核覆盖不完整：期望 ${expected} 条，实得 ${got} 条（差异会被排除在比对之外）`);
  }
  return {
    engine: "chat",
    model: auditorModel,
    items: results.flatMap((r) => r.items ?? []),
    summaries: results.map((r) => r.summary).filter(Boolean),
    coverage: { expected, got },
  };
}

/** ---- 引擎 B：交给 codex agent 深度复核（可自行读文件、必要时访问来源） ---- */
async function runCodexEngine() {
  const { spawn } = await import("node:child_process");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "replaced-audit-"));
  // codex 需要可写的 CODEX_HOME（默认 ~/.codex 在受限沙箱里可能是只读的）。
  // 用临时目录而不是仓库内目录：凭据副本不应留在工作区里。
  const codexHome = path.join(tmp, "codex-home");
  ensureDir(codexHome);
  const realHome = process.env.CODEX_HOME_REAL || path.join(os.homedir(), ".codex");
  for (const f of ["auth.json", "config.toml"]) {
    const src = path.join(realHome, f);
    const dst = path.join(codexHome, f);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      try {
        fs.copyFileSync(src, dst);
      } catch (e) {
        log("warn", `复制 ${f} 到 CODEX_HOME 失败`, String(e.message));
      }
    }
  }
  const outFile = path.join(tmp, "out.json");

  const dayFile = path.relative(ROOT, paths(ROOT).dayFile(date));
  const prompt = `复核 ${date} 的评分质量（共 ${events.length} 条）。

步骤：
1. 读取 ${dayFile}，取出全部事件的 id 与标题。
2. 按下面的口径逐条独立判断 value 与 domain。
   如需了解当天统计与数据源情况，可读 ${path.relative(ROOT, path.join("data", "runs", `${date}.json`))}。

${buildPrompt([], { withSource: false }).split("## 待复核条目")[0]}
## 输出契约（最终消息必须只包含这一个 JSON 对象，不要 markdown 围栏、不要额外解释）
${AUDIT_CONTRACT}

对每条事件都要输出一条 items 记录。只做只读分析，不要修改仓库里的任何文件，
也不要执行除读取上面提到的这几个文件以外的命令。`;

  const argv = [
    "exec",
    "-s", "read-only",
    "-C", ROOT,
    "--skip-git-repo-check",
    "--ephemeral",
    "-o", outFile,
    "-m", auditorModel,
    // reasoning effort 高的模型在这种批量判断任务上开销过大，默认降到 medium
    "-c", `model_reasoning_effort="${args.effort ?? "medium"}"`,
    prompt,
  ];
  log("info", `启动 codex 复核（model=${auditorModel}, sandbox=read-only, effort=${args.effort ?? "medium"}）...`);
  const result = await new Promise((resolve) => {
    const child = spawn("codex", argv, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", CODEX_HOME: codexHome },
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, error: "codex 超时 900s" });
    }, 900000);
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.stderr.on("data", (d) => {
      err += d.toString();
    });
    child.on("error", (e) => resolve({ ok: false, error: String(e.message) }));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve({ ok: false, error: `codex 退出码 ${code}: ${err.slice(0, 300)}` });
      resolve({ ok: true, out });
    });
  });
  if (!result.ok) throw new Error(result.error);
  const rawOut = fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : "";
  const parsed = extractJSON(rawOut) ?? extractJSON(result.out);
  const codexItems = pickAuditItems(parsed);
  if (!parsed || !codexItems.length) {
    throw new Error(`codex 未产出可解析的审计结果。最后消息片段：${(rawOut || result.out).slice(-500)}`);
  }
  try {
    // 连同临时 CODEX_HOME 里的凭据副本一起删除
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  return {
    engine: "codex",
    model: auditorModel,
    items: codexItems,
    summaries: [parsed.summary].filter(Boolean),
    coverage: { expected: events.length, got: codexItems.length },
  };
}

function compare(auditItems) {
  const byId = new Map(auditItems.map((a) => [String(a.id), a]));
  const rows = [];
  for (const e of events) {
    const a = byId.get(e.id);
    if (!a) continue;
    const diff = Number(a.value) - e.value;
    const domainMismatch = String(a.domain) !== e.domain;
    rows.push({
      id: e.id,
      title: truncate(e.title, 90),
      domain: e.domain,
      audited_domain: a.domain,
      value: e.value,
      audited_value: Number(Number(a.value).toFixed(3)),
      diff: Number(diff.toFixed(3)),
      verdict: domainMismatch && a.verdict === "agree" ? "misclassified" : a.verdict,
      reason: a.reason,
      evidence_type: e.evidence_type,
      confidence: e.confidence,
      source: e.source_name,
    });
  }
  const n = rows.length || 1;
  const meanDiff = rows.reduce((s, r) => s + r.diff, 0) / n;
  const meanAbsDiff = rows.reduce((s, r) => s + Math.abs(r.diff), 0) / n;
  const over = rows.filter((r) => r.diff <= -0.15).length;
  const under = rows.filter((r) => r.diff >= 0.15).length;
  const flagged = rows.filter((r) => r.verdict !== "agree");
  const domainMismatch = rows.filter((r) => r.audited_domain && r.audited_domain !== r.domain).length;

  const median = (xs) => {
    if (!xs.length) return null;
    const a = [...xs].sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };
  const originalMedian = median(rows.map((r) => r.value));
  const auditedMedian = median(rows.map((r) => r.audited_value));
  const [lo, hi] = scoring.calibration?.expectedMedianValue ?? [0.3, 0.55];
  const verdicts = [];
  // 措辞保持中性：两个模型的分歧方向不能直接归因于某一方错了
  if (meanDiff <= -0.12) verdicts.push(`复核模型整体比原评分低 ${(-meanDiff).toFixed(2)}（原评分偏宽，或复核模型偏严）`);
  if (meanDiff >= 0.12) verdicts.push(`复核模型整体比原评分高 ${meanDiff.toFixed(2)}（原评分偏严，或复核模型偏宽）`);
  if (over / n > 0.3) verdicts.push(`${((over / n) * 100).toFixed(0)}% 的条目两个模型相差 ≥0.15`);
  if (domainMismatch / n > 0.2) verdicts.push(`${((domainMismatch / n) * 100).toFixed(0)}% 的领域判定不一致`);
  if (!verdicts.length) verdicts.push("两个模型的分歧在可接受范围内");

  return {
    rows,
    summary: {
      compared: rows.length,
      meanDiff: Number(meanDiff.toFixed(3)),
      meanAbsDiff: Number(meanAbsDiff.toFixed(3)),
      overScored: over,
      underScored: under,
      flagged: flagged.length,
      domainMismatch,
      agreeRate: Number(((rows.length - flagged.length) / n).toFixed(3)),
      originalMedian: originalMedian === null ? null : Number(originalMedian.toFixed(3)),
      auditedMedian: auditedMedian === null ? null : Number(auditedMedian.toFixed(3)),
      expectedMedianRange: [lo, hi],
      verdict: verdicts,
    },
  };
}

const run = engine === "codex" ? runCodexEngine : runChatEngine;
log("info", `=== 独立复核 ${date}（${events.length} 条，engine=${engine}）===`);
const audit = await run();
const { rows, summary } = compare(audit.items);

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