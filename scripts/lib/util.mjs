import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function readJSON(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJSON(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

export function writeText(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, value, "utf8");
  fs.renameSync(tmp, file);
}

export function exists(file) {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let currentLevel = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

export function setLogLevel(name) {
  currentLevel = LEVELS[name] ?? currentLevel;
}

export function log(level, msg, extra) {
  if ((LEVELS[level] ?? 20) < currentLevel) return;
  const stamp = new Date().toISOString().slice(11, 19);
  const tag = { debug: "DBG", info: "INF", warn: "WRN", error: "ERR" }[level] ?? "INF";
  const tail = extra === undefined ? "" : ` ${typeof extra === "string" ? extra : JSON.stringify(extra)}`;
  process[level === "error" ? "stderr" : "stdout"].write(`[${stamp}] ${tag} ${msg}${tail}\n`);
}

/** 并发闸门：限制同时运行的任务数。 */
export function createLimiter(concurrency) {
  let active = 0;
  const queue = [];
  const pump = () => {
    if (active >= concurrency || queue.length === 0) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        pump();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      pump();
    });
}

export function isDateISO(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** 本地时区的今天（YYYY-MM-DD）。 */
export function todayISO(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDaysISO(iso, delta) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(aISO, bISO) {
  const a = Date.parse(`${aISO}T00:00:00Z`);
  const b = Date.parse(`${bISO}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

export const SECTORS = ["academia", "internet"];
const SECTOR_SET = new Set(SECTORS);

/**
 * 归一化「学术界 / 工业界」归属。
 * AI 的判定优先；它没给或给了非法值时退回来源先验；都没有时按语料实际(default)兜底。
 * 先验只作提示 —— 公司发的论文应算 academia，学术机构做的落地应算 industry。
 */
/**
 * 按上限截取，但为某个分类预留最低占比。
 * 科研源条目量级远大于公司/媒体源，任何「按分数排序后截断」的环节都会把工业界挤掉，
 * 所以候选、填充两处都用同一个保底逻辑。
 */
export function takeWithFloor(items, cap, { key = (x) => x.sector, want = "internet", share = 0.25 } = {}) {
  if (items.length <= cap) return items;
  const target = Math.ceil(cap * share);
  const guaranteed = items.filter((x) => key(x) === want).slice(0, target);
  const gset = new Set(guaranteed);
  const rest = items.filter((x) => !gset.has(x));
  return [...guaranteed, ...rest.slice(0, Math.max(0, cap - guaranteed.length))];
}

/**
 * 自述型来源（GitHub Trending、Product Hunt 这类自荐渠道）不应该拿到高强度分值。
 *
 * 这里返回的是**允许的最高价值**，而不是改写后的证据类型。
 * 曾经的做法是把类型直接改成 ceiling——结果是展示层说出与原文相反的话：
 * 一条证据原文写着「已被弗吉尼亚理工独立复现」的条目，因为来自 GitHub Trending
 * 被标成了「厂商自述」。封顶应该只压分值，不该篡改「这份证据是什么」。
 */
export function evidenceCeilingCap(evidenceType, ceiling, scoring) {
  const caps = scoring?.valueCaps?.caps ?? {};
  const own = caps[evidenceType] ?? 1;
  if (!ceiling || caps[ceiling] == null) return own;
  return Math.min(own, caps[ceiling]);
}

export function resolveSector(aiValue, hint, fallback = "academia") {
  const v = String(aiValue ?? "").trim().toLowerCase();
  if (SECTOR_SET.has(v)) return v;
  const h = String(hint ?? "").trim().toLowerCase();
  if (SECTOR_SET.has(h)) return h;
  return SECTOR_SET.has(fallback) ? fallback : "academia";
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

export function round(n, digits = 4) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const k = keyFn(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

export function groupBy(arr, keyFn) {
  const map = new Map();
  for (const item of arr) {
    const k = keyFn(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

export function parseArgs(argv = process.argv.slice(2)) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split("=");
      if (inline !== undefined) args[k] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) args[k] = argv[++i];
      else args[k] = true;
    } else args._.push(a);
  }
  return args;
}