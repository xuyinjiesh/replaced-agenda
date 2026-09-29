import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { log, sleep } from "./util.mjs";

/**
 * LLM 传输层。AIClient 负责缓存、并发、JSON 修复；provider 只负责「把 messages 送出去、把文本拿回来」。
 *
 * 支持三种：
 *   - openai : 任意 OpenAI 兼容端点（DashScope compatible-mode / OpenAI / vLLM ...），直连 HTTP
 *   - bl     : 阿里云百炼 CLI（子进程），在没有可用 key 时作为兜底
 *   - auto   : 有可用 key 就用 openai，否则用 bl
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

/** 百炼 CLI 兜底：无 key 环境下使用（子进程开销较大）。 */
class BlProvider {
  constructor({ bin = process.env.BL_BIN || "bl", tmpDir, timeoutMs = 300000, retries = 2 }) {
    this.name = "bl";
    this.bin = bin;
    this.tmpDir = tmpDir;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
  }

  async chat({ model, system, user, temperature = 0.2, maxTokens = 4096 }) {
    return this.#once({ model, system, user, temperature, maxTokens });
  }

  #once({ model, system, user, temperature, maxTokens }) {
    return new Promise((resolve) => {
      const msgFile = path.join(this.tmpDir, `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
      fs.writeFileSync(msgFile, JSON.stringify([{ role: "user", content: user }]), "utf8");
      const cleanup = () => {
        try {
          fs.unlinkSync(msgFile);
        } catch {
          /* ignore */
        }
      };
      const args = [
        "text", "chat",
        "--model", model,
        "--messages-file", msgFile,
        "--output", "json",
        "--temperature", String(temperature),
        "--max-tokens", String(maxTokens),
      ];
      if (system) args.push("--system", system);

      const child = spawn(this.bin, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, NO_COLOR: "1", CI: "1" },
      });
      let out = "";
      let err = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        cleanup();
        resolve({ ok: false, content: "", usage: {}, error: `AI 超时 ${this.timeoutMs}ms`, model });
      }, this.timeoutMs);

      child.stdout.on("data", (d) => {
        out += d.toString();
      });
      child.stderr.on("data", (d) => {
        err += d.toString();
      });
      child.on("error", (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        resolve({ ok: false, content: "", usage: {}, error: `无法启动 ${this.bin}: ${e.message}`, model });
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        if (code !== 0) {
          resolve({ ok: false, content: "", usage: {}, error: `bl 退出码 ${code}: ${err.slice(0, 200)}`, model });
          return;
        }
        let env = null;
        try {
          env = JSON.parse(out);
        } catch {
          /* 非 JSON 输出，退回按纯文本处理 */
        }
        const content = (env?.choices?.[0]?.message?.content ?? out).trim();
        if (!content) {
          resolve({ ok: false, content: "", usage: {}, error: `响应为空: ${out.slice(0, 160)}`, model });
          return;
        }
        resolve({ ok: true, content, usage: env?.usage ?? {}, error: "", model: env?.model ?? model });
      });
    });
  }

  async ping(model) {
    const r = await this.chat({ model, system: "reply tersely", user: "Reply with exactly: PONG", maxTokens: 16 });
    return r.ok && /PONG/i.test(r.content);
  }
}

/**
 * 选择传输方式。
 * @returns {{provider: object, info: object}}
 */
export function resolveProvider({ root, mode = "auto", timeoutMs, retries, tmpDir }) {
  const creds = mode === "bl" ? null : resolveCredentials({ root });
  if (mode !== "bl" && creds) {
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
  if (mode === "openai") {
    log("warn", "指定了 --provider openai 但没找到可用的 API key，回退到 bl CLI");
  }
  return {
    provider: new BlProvider({ tmpDir, timeoutMs: timeoutMs ? timeoutMs * 1.5 : undefined, retries }),
    info: { provider: "bl", baseUrl: "bailian-cli", keyFrom: "-", defaultModel: "qwen3.7-max" },
  };
}

export { OpenAIProvider, BlProvider };