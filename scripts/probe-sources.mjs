/**
 * 数据源可达性探测：读取 config/sources.json，逐个探测并汇总。
 * 网络环境变化后跑一次，再跑 `npm run pipeline -- --force-sources` 重新纳入可达源。
 *
 *   node scripts/probe-sources.mjs            # 探测全部源
 *   node scripts/probe-sources.mjs --group research
 *   node scripts/probe-sources.mjs --json     # 额外输出机器可读结果
 */
import path from "node:path";
import { fetchText } from "./lib/http.mjs";
import { looksLikeFeed } from "./lib/xml.mjs";
import { log, parseArgs, readJSON } from "./lib/util.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);

const args = parseArgs();
const config = readJSON(path.join(ROOT, "config", "sources.json"));
const sources = config.sources.filter(
  (s) => s.enabled !== false && (!args.group || s.group === args.group),
);

log("info", `探测 ${sources.length} 个源（带重试与同源节流，避免触发限流）...`);
log("info", "这一步只做只读探测，不修改任何状态。");

const rows = [];
for (const s of sources) {
  const res = await fetchText(s.url, { timeoutMs: 15000, retries: 2, perHostDelayMs: 400 });
  let kind = "";
  let items = 0;
  if (res.ok) {
    if (s.kind === "json") {
      try {
        JSON.parse(res.body);
        kind = "json";
      } catch {
        kind = "bad-json";
      }
    } else if (looksLikeFeed(res.body)) {
      kind = "feed";
      items = (res.body.match(/<item[\s>]|<entry[\s>]/gi) ?? []).length;
    } else {
      kind = "not-a-feed";
    }
  }
  const ok = res.ok && (kind === "feed" || kind === "json");
  rows.push({ ...s, ok, status: res.status, kind, items, error: res.error, ms: res.ms });
  const mark = ok ? "OK  " : "--  ";
  process.stdout.write(
    `${mark} ${String(res.status).padStart(3)} ${kind.padEnd(11)} ${String(res.ms).padStart(6)}ms  ${s.name}${items ? `  items=${items}` : ""}${ok ? "" : `  ${res.error}`}\n`,
  );
}

const okRows = rows.filter((r) => r.ok);
const failed = rows.filter((r) => !r.ok);
log("info", `可用 ${okRows.length}/${rows.length}，共 ${okRows.reduce((n, r) => n + r.items, 0)} 条原始条目`);
if (failed.length) {
  log("warn", `不可达：${failed.map((f) => f.id).join(", ")}`);
  log("info", "不可达的源不影响流水线；连续失败 3 次后会自动进入冷却期被快速跳过。");
}
const byGroup = {};
for (const r of okRows) byGroup[r.group] = (byGroup[r.group] ?? 0) + 1;
log("info", `可用源按分组：${JSON.stringify(byGroup)}`);

if (args.json) {
  process.stdout.write(
    `${JSON.stringify(
      rows.map(({ id, name, group, url, ok, status, kind, items, error }) => ({ id, name, group, url, ok, status, kind, items, error })),
      null,
      2,
    )}\n`,
  );
}