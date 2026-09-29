import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLimiter, ensureDir, exists, log, readJSON, sha256, sleep, writeJSON } from "./util.mjs";
import { extractJSON } from "./text.mjs";
import { resolveProvider } from "./providers.mjs";

/**
 * AI 调用层：负责缓存、并发限流、失败重试与 JSON 修复；
 * 实际传输交给 providers.mjs（OpenAI 兼容端点 / bl CLI）。
 */
export class AIClient {
  /**
   * @param {object} opts
   * @param {string} opts.cacheDir   磁盘缓存目录（相同 prompt 直接复用，省钱且可复现）
   * @param {number} opts.concurrency 并发上限
   * @param {boolean} opts.offline   只读缓存，绝不真正调用
   * @param {string} opts.root       项目根目录（用于定位 .env）
   * @param {string} opts.provider   auto | openai | bl
   */
  constructor({ cacheDir, concurrency = 3, offline = false, retries = 2, timeoutMs, root, provider = "auto" } = {}) {
    this.cacheDir = cacheDir;
    this.limiter = createLimiter(concurrency);
    this.offline = offline;
    this.retries = retries;
    this.stats = { calls: 0, cacheHits: 0, failures: 0, promptTokens: 0, completionTokens: 0 };
    if (cacheDir) ensureDir(cacheDir);

    this.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "replaced-agenda-ai-"));
    const { provider: transport, info } = resolveProvider({ root, mode: provider, timeoutMs, retries, tmpDir: this.tmpDir });
    this.transport = transport;
    this.info = info;
    log(
      "info",
      `AI 传输方式：${info.provider}${
        info.provider === "openai" ? ` → ${info.baseUrl}（${info.keyFingerprint}，来自 ${info.keyFrom}）` : "（bl CLI）"
      }`,
    );
  }

  cachePath(key) {
    return path.join(this.cacheDir, `${key.slice(0, 2)}`, `${key}.json`);
  }

  /**
   * 调用一次 chat completion。
   * @returns {Promise<{content:string, usage:object, cached:boolean, ok:boolean, error?:string, model:string}>}
   */
  async chat({ model, system, user, temperature = 0.2, maxTokens = 4096, cache = true, extraBody }) {
    // provider 与 extraBody 参与缓存键：不同端点/参数的结果不应互相污染
    const key = sha256(
      [this.info.provider, model, temperature, maxTokens, JSON.stringify(extraBody ?? {}), system ?? "", user].join("\u0000"),
    );
    const file = cache ? this.cachePath(key) : null;
    if (file && exists(file)) {
      const hit = readJSON(file, null);
      if (hit?.ok) {
        this.stats.cacheHits += 1;
        return { ...hit, cached: true };
      }
    }
    if (this.offline) {
      return { ok: false, content: "", usage: {}, cached: false, error: "offline: cache miss", model };
    }

    let last = null;
    for (let attempt = 1; attempt <= this.retries + 1; attempt += 1) {
      last = await this.limiter(() => this.transport.chat({ model, system, user, temperature, maxTokens, extraBody }));
      if (last.ok) break;
      log("warn", `AI 调用失败（第 ${attempt} 次）`, `${model}: ${last.error}`);
      if (attempt <= this.retries) await sleep(1200 * attempt);
    }
    this.stats.calls += 1;
    if (last?.ok) {
      this.stats.promptTokens += last.usage?.prompt_tokens ?? 0;
      this.stats.completionTokens += last.usage?.completion_tokens ?? 0;
    } else {
      this.stats.failures += 1;
    }
    if (last?.ok && last.fromReasoning) {
      log("warn", "该响应来自 reasoning_content 回退（模型未产出正式 content），JSON 解析可能不稳定", model);
    }
    if (file && last?.ok) writeJSON(file, last);
    return last;
  }

  /** 调用并解析 JSON 输出；解析失败时追加一次「修复」提示重试。 */
  async chatJSON(opts) {
    const res = await this.chat(opts);
    if (!res.ok) return { ok: false, data: null, raw: "", error: res.error, usage: res.usage, model: res.model };
    const data = extractJSON(res.content);
    if (data === null) {
      const repair = await this.chat({
        ...opts,
        cache: false,
        user: `${opts.user}\n\n注意：你上一次的输出不是合法 JSON。请只输出合法 JSON，不要任何解释文字或 markdown 围栏。`,
      });
      const repaired = repair.ok ? extractJSON(repair.content) : null;
      if (repaired === null) {
        return { ok: false, data: null, raw: res.content, error: "JSON 解析失败", usage: res.usage, model: res.model };
      }
      return { ok: true, data: repaired, raw: repair.content, usage: repair.usage, model: repair.model, cached: false };
    }
    return { ok: true, data, raw: res.content, usage: res.usage, model: res.model, cached: res.cached };
  }

  /** 探活：确认当前传输方式真的能出结果。 */
  async ping(model) {
    return this.transport.ping(model);
  }
}

export async function probeAI(model = "qwen-flash", opts = {}) {
  const client = new AIClient({ cacheDir: null, concurrency: 1, retries: 1, timeoutMs: 90000, ...opts });
  return client.ping(model);
}