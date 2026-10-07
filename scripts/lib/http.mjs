import fs from "node:fs";
import path from "node:path";
import { describeFetchError, ensureDir, exists, log, sha256, sleep, writeJSON } from "./util.mjs";

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const hostLocks = new Map();

/** 同一 host 串行 + 最小间隔，避免被限流（arXiv 对突发并发很敏感）。 */
async function respectHostDelay(url, minDelayMs) {
  let host = "unknown";
  try {
    host = new URL(url).hostname;
  } catch {
    /* ignore */
  }
  const prev = hostLocks.get(host) ?? Promise.resolve();
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  hostLocks.set(
    host,
    prev.then(() => gate),
  );
  await prev;
  const last = hostLocks.get(`${host}:last`) ?? 0;
  const wait = Math.max(0, last + minDelayMs - Date.now());
  if (wait > 0) await sleep(wait);
  hostLocks.set(`${host}:last`, Date.now());
  return () => release();
}

/**
 * 带重试、超时、同源节流的取回。
 * @returns {{ok:boolean,status:number,body:string,error:string,attempts:number,ms:number}}
 */
export async function fetchText(url, opts = {}) {
  const {
    timeoutMs = 20000,
    retries = 3,
    perHostDelayMs = 0,
    headers = {},
    backoffBaseMs = 700,
  } = opts;

  let release = () => {};
  if (perHostDelayMs > 0) release = await respectHostDelay(url, perHostDelayMs);

  const started = Date.now();
  let lastError = "";
  let status = 0;
  try {
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          signal: ctrl.signal,
          redirect: "follow",
          headers: {
            "user-agent": UA,
            accept:
              "application/rss+xml, application/atom+xml, application/xml, text/xml, application/json, text/html;q=0.8, */*;q=0.5",
            "accept-language": "en-US,en;q=0.9,zh-CN;q=0.8",
            ...headers,
          },
        });
        status = res.status;
        const body = await res.text();
        clearTimeout(timer);
        if (res.status >= 200 && res.status < 300) {
          return { ok: true, status, body, error: "", attempts: attempt, ms: Date.now() - started };
        }
        lastError = `HTTP ${res.status}`;
        // 4xx（除 429）不重试，是确定性失败
        if (res.status < 500 && res.status !== 429) break;
      } catch (err) {
        clearTimeout(timer);
        lastError = err?.name === "AbortError" ? `timeout after ${timeoutMs}ms` : describeFetchError(err);
      }
      if (attempt < retries) await sleep(backoffBaseMs * attempt + Math.random() * 250);
    }
  } finally {
    release();
  }
  return { ok: false, status, body: "", error: lastError || "unknown error", attempts: retries, ms: Date.now() - started };
}

/**
 * 取回并缓存原文到 data/raw/<date>/<id>.<ext>。
 * 缓存命中时直接复用（--refresh 可强制刷新）。
 */
export async function fetchCached(url, { cacheFile, refresh = false, offline = false, ...opts } = {}) {
  if (cacheFile && !refresh && exists(cacheFile)) {
    const body = fs.readFileSync(cacheFile, "utf8");
    return { ok: true, status: 200, body, error: "", attempts: 0, ms: 0, cached: true };
  }
  if (offline) {
    return { ok: false, status: 0, body: "", error: "offline 模式：无可用缓存", attempts: 0, ms: 0 };
  }
  const res = await fetchText(url, opts);
  if (res.ok && cacheFile) {
    ensureDir(path.dirname(cacheFile));
    fs.writeFileSync(cacheFile, res.body, "utf8");
  }
  return res;
}

export function extFor(url, body = "") {
  if (/\.json(\?|$)/i.test(url) || /^\s*[[{]/.test(body.slice(0, 200))) return "json";
  return "xml";
}

/** 数据源健康状态，用于跳过长期不可达的源。 */
export function loadHealth(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { updatedAt: null, sources: {} };
  }
}

export function saveHealth(file, health) {
  health.updatedAt = new Date().toISOString();
  writeJSON(file, health);
}

export function recordHealth(health, id, result) {
  const cur = health.sources[id] ?? { failures: 0, successes: 0 };
  if (result.ok) {
    cur.failures = 0;
    cur.successes += 1;
    cur.lastOkAt = new Date().toISOString();
    cur.lastError = "";
  } else {
    cur.failures += 1;
    cur.lastFailAt = new Date().toISOString();
    cur.lastError = result.error || `HTTP ${result.status}`;
  }
  cur.lastStatus = result.status;
  cur.lastCheckedAt = new Date().toISOString();
  health.sources[id] = cur;
  return cur;
}

export function shouldSkipByHealth(health, id, { afterFailures = 3, cooldownDays = 7 } = {}) {
  const s = health.sources?.[id];
  if (!s || s.failures < afterFailures) return false;
  const last = Date.parse(s.lastFailAt ?? 0);
  if (!Number.isFinite(last)) return false;
  const ageDays = (Date.now() - last) / 86400000;
  return ageDays < cooldownDays;
}

export function describeHealth(health, sources) {
  const rows = sources.map((s) => {
    const h = health.sources?.[s.id];
    return {
      id: s.id,
      name: s.name,
      group: s.group,
      url: s.url,
      failures: h?.failures ?? 0,
      successes: h?.successes ?? 0,
      lastStatus: h?.lastStatus ?? null,
      lastError: h?.lastError ?? "",
      lastOkAt: h?.lastOkAt ?? null,
    };
  });
  return rows;
}

export function hashKey(...parts) {
  return sha256(parts.join("\u0000"));
}

export { log };