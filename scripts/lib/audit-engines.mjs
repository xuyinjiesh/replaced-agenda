import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AIClient } from "./ai.mjs";
import { NO_THINKING } from "./providers.mjs";
import { paths } from "./store.mjs";
import { extractJSON, truncate } from "./text.mjs";
import { ensureDir, log } from "./util.mjs";

export function createAuditEngines({ root: ROOT, args, date, events, scoring, domains, auditorModel }) {
  /**
   * 文本输出契约。兼容端点不一定支持结构化输出，因此从最终消息解析 JSON。
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

  return { runChatEngine, runCodexEngine };
}
