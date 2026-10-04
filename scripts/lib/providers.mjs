import fs from "node:fs";
import path from "node:path";
import { sleep } from "./util.mjs";

/**
 * LLM 传输层。AIClient 负责缓存、并发、JSON 修复；provider 只负责「把 messages 送出去、把文本拿回来」。
 *
 * 只有一种传输：任意 OpenAI 兼容端点（DashScope compatible-mode / OpenAI / vLLM ...），直连 HTTP。
 * 没有可用凭据时不做兜底，交给 MissingCredentialsProvider 在真正调用时报错。
 */

/** 解析 .env：同时支持 YAML 风格 `key: value` 与 shell 风格 `KEY=value`。 */
export function loadEnvFile(file) {
  const out = {};
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const m = s.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*[:=]\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const KEY_NAMES = [
  "AI_API_KEY",
  "OPENAI_API_KEY",
  "DASHSCOPE_API_KEY",
  "api_key",
  "OPENAI_KEY",
  "LLM_API_KEY",
];
const BASE_NAMES = ["AI_BASE_URL", "OPENAI_BASE_URL", "base_url", "OPENAI_API_BASE", "LLM_BASE_URL"];

/** 按优先级找出可用的 OpenAI 兼容端点凭据：真实环境变量 > .env 文件。 */
export function resolveCredentials({ root, envFile = ".env" } = {}) {
  const fileEnv = loadEnvFile(path.join(root, envFile));
  const pick = (names) => {
    for (const n of names) {
      if (process.env[n]) return { value: process.env[n], from: `env:${n}` };
    }
    for (const n of names) {
      if (fileEnv[n]) return { value: fileEnv[n], from: `${envFile}:${n}` };
    }
    return null;
  };
  const key = pick(KEY_NAMES);
  const base = pick(BASE_NAMES);
  if (!key || !base) return null;
  let baseUrl = base.value.replace(/\/+$/, "");
  if (!/\/v\d+$/.test(baseUrl)) baseUrl = `${baseUrl}`;
  return {
    apiKey: key.value,
    baseUrl,
    keyFrom: key.from,
    baseFrom: base.from,
    defaultModel: fileEnv.model_name || process.env.AI_MODEL || "",
  };
}

function normalizeBase(baseUrl) {
  const b = baseUrl.replace(/\/+$/, "");
  return /\/chat\/completions$/.test(b) ? b : `${b}/chat/completions`;
}

/** 全局模型变量，作用于所有阶段。 */
const GLOBAL_MODEL_KEYS = ["AI_MODEL_NAME", "AI_MODEL", "model_name"];
/** 阶段专属模型变量，只覆盖对应阶段。 */
const STAGE_MODEL_KEYS = {
  screening: ["AI_MODEL_SCREENING", "model_screening"],
  merger: ["AI_MODEL_MERGER", "model_merger"],
  enrichment: ["AI_MODEL_ENRICHMENT", "model_enrichment"],
  summarizer: ["AI_MODEL_SUMMARIZER", "model_summarizer"],
  audit: ["AI_MODEL_AUDIT", "model_audit"],
};

/**
 * 解析某阶段使用的模型名。
 * 优先级：阶段专属变量 > 全局变量（AI_MODEL_NAME / AI_MODEL / model_name）> 传入的兜底值。
 * 之所以走环境变量而不是在 config 里写死，是为了让同一份代码能对接不同厂商的端点
 * （DeepSeek 只认 deepseek-flash，DashScope 才认 qwen-flash，写死哪个都会在另一端点上失败）。
 */
export function resolveModelName(stage, { root, fallback = "", envFile = ".env" } = {}) {
  const fileEnv = loadEnvFile(path.join(root, envFile));
  const pick = (names) => {
    for (const n of names) if (process.env[n]) return process.env[n];
    for (const n of names) if (fileEnv[n]) return fileEnv[n];
    return "";
  };
  const hit = pick(STAGE_MODEL_KEYS[stage] ?? []) || pick(GLOBAL_MODEL_KEYS);
  return String(hit || fallback || "").trim();
}

/** 按环境变量覆盖各阶段模型名；未设置的阶段保留 config/scoring.json 的原值。 */
export function applyModelOverrides(models = {}, { root, envFile = ".env" } = {}) {
  const out = { ...models };
  for (const stage of Object.keys(models)) {
    if (stage.startsWith("$")) continue;
    out[stage] = resolveModelName(stage, { root, envFile, fallback: models[stage] });
  }
  return out;
}

function providerError(status, body) {
  let msg = `HTTP ${status}`;
  try {
    const j = JSON.parse(body);
    msg = j?.error?.message ?? j?.message ?? msg;
  } catch {
    if (body) msg = `HTTP ${status}: ${body.slice(0, 160)}`;
  }
  return msg;
}

/**
 * 关掉混合推理模型的思考模式。
 * 实测 deepseek-v4.1-flash 在这类批量 JSON 任务上会把全部 max_tokens 烧在
 * reasoning_content 上、content 为空，导致输出被截断。加上这个参数后
 * 同样的调用从数千 completion tokens 降到个位数，且输出干净可用。
 */
export const NO_THINKING = { enable_thinking: false };

/** OpenAI 兼容端点。无子进程开销，是默认传输方式。 */
class OpenAIProvider {
  constructor({ apiKey, baseUrl, timeoutMs = 180000, retries = 2 }) {
    this.name = "openai";
    this.apiKey = apiKey;
    this.endpoint = normalizeBase(baseUrl);
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
  }

  async chat({ model, system, user, temperature = 0.2, maxTokens = 4096, extraBody }) {
    const messages = [];
    if (system) messages.push({ role: "system", content: system });
    messages.push({ role: "user", content: user });
    // extraBody 用于传厂商专有参数（如 DashScope 的 enable_thinking）
    const payload = { model, messages, temperature, max_tokens: maxTokens, ...(extraBody ?? {}) };

    let last = "";
    for (let attempt = 1; attempt <= this.retries + 1; attempt += 1) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await fetch(this.endpoint, {
          method: "POST",
          signal: ctrl.signal,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(payload),
        });
        clearTimeout(timer);
        const body = await res.text();
        if (!res.ok) {
          last = providerError(res.status, body);
          // 4xx（除 429）是确定性错误，重试没意义
          if (res.status < 500 && res.status !== 429) break;
        } else {
          const json = JSON.parse(body);
          const choice = json?.choices?.[0] ?? {};
          const msg = choice.message ?? {};
          const finishReason = String(choice.finish_reason ?? "");
          const text = String(msg.content ?? "").trim();
          const reasoning = String(msg.reasoning_content ?? "").trim();

          // 推理模型（deepseek 系等）会把 token 大量花在 reasoning_content 上，
          // 一旦 max_tokens 用尽，content 会是空的、reasoning 是被截断的思维过程。
          // 把思维过程当成答案会造成「看起来成功、实际解析不出东西」的静默失败，
          // 所以只有在 finish_reason 不是 length 时才允许回退，并且明确标记来源。
          if (text) {
            return { ok: true, content: text, usage: json.usage ?? {}, error: "", model: json.model ?? model, finishReason, fromReasoning: false };
          }
          if (reasoning && finishReason !== "length") {
            return { ok: true, content: reasoning, usage: json.usage ?? {}, error: "", model: json.model ?? model, finishReason, fromReasoning: true };
          }
          if (reasoning && finishReason === "length") {
            last = `输出被 max_tokens 截断（reasoning 模型耗尽了预算，content 为空）。请提高 max_tokens 或减小批大小`;
          } else {
            last = `响应为空: ${body.slice(0, 160)}`;
          }
        }
      } catch (err) {
        clearTimeout(timer);
        last = err?.name === "AbortError" ? `超时 ${this.timeoutMs}ms` : String(err?.message ?? err);
      }
      if (attempt <= this.retries) await sleep(900 * attempt + Math.random() * 300);
    }
    return { ok: false, content: "", usage: {}, error: last || "unknown error", model };
  }

  async ping(model) {
    const r = await this.chat({ model, system: "reply tersely", user: "Reply with exactly: PONG", maxTokens: 64 });
    return r.ok && /PONG/i.test(r.content);
  }
}

export const MISSING_CREDS_HINT =
  "未找到 AI 凭据：请在仓库根目录的 .env 或环境变量中同时设置 AI_API_KEY 与 AI_BASE_URL";

/**
 * 无凭据时的占位传输。
 * 刻意不在构造阶段抛错：`npm run render` 这类不真正调用 AI 的路径，
 * 在没有 .env 的机器上也应当照常可用；只有真的发起调用时才报出可操作的错误。
 */
class MissingCredentialsProvider {
  constructor() {
    this.name = "none";
  }

  async chat({ model } = {}) {
    return { ok: false, content: "", usage: {}, error: MISSING_CREDS_HINT, model };
  }

  async ping() {
    return false;
  }
}

/**
 * 选择传输方式：有凭据就直连 OpenAI 兼容端点，没有则返回会明确报错的占位实现。
 * @returns {{provider: object, info: object}}
 */
export function resolveProvider({ root, timeoutMs, retries }) {
  const creds = resolveCredentials({ root });
  if (!creds) {
    return {
      provider: new MissingCredentialsProvider(),
      info: { provider: "none", baseUrl: "-", keyFrom: "-", baseFrom: "-", defaultModel: "", keyFingerprint: "-" },
    };
  }
  return {
    provider: new OpenAIProvider({ apiKey: creds.apiKey, baseUrl: creds.baseUrl, timeoutMs, retries }),
    info: {
      provider: "openai",
      baseUrl: creds.baseUrl,
      keyFrom: creds.keyFrom,
      baseFrom: creds.baseFrom,
      defaultModel: creds.defaultModel,
      /** 脱敏后的端点指纹，便于在运行报告里核对用的是哪套凭据 */
      keyFingerprint: `${creds.apiKey.slice(0, 6)}…${creds.apiKey.slice(-4)}`,
    },
  };
}

export { OpenAIProvider };