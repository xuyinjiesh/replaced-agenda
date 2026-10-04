import fs from "node:fs";
import path from "node:path";
import { ensureDir, exists, log, readJSON, writeJSON } from "./util.mjs";

export function paths(root) {
  return {
    root,
    eventsDir: path.join(root, "data", "events"),
    dayFile: (d) => path.join(root, "data", "events", `${d}.json`),
    indexFile: path.join(root, "data", "index.json"),
    seenFile: path.join(root, "data", "seen.json"),
    runsDir: path.join(root, "data", "runs"),
    runFile: (d) => path.join(root, "data", "runs", `${d}.json`),
    rawDir: (d) => path.join(root, "data", "raw", d),
    cacheDir: path.join(root, "data", "cache", "ai"),
    siteDir: path.join(root, "site"),
  };
}

export function listEventDates(root) {
  const dir = paths(root).eventsDir;
  if (!exists(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

export function loadDay(root, date) {
  return readJSON(paths(root).dayFile(date), null);
}

export function loadAllEvents(root) {
  const out = [];
  for (const date of listEventDates(root)) {
    const day = loadDay(root, date);
    for (const e of day?.events ?? []) out.push(e);
  }
  return out;
}

/** 合并同日事件：按 id 去重，新数据覆盖旧数据（保证重跑幂等）。 */
export function mergeDay(existing, incoming, { date }) {
  const map = new Map();
  for (const e of existing?.events ?? []) map.set(e.id, e);
  let added = 0;
  let updated = 0;
  for (const e of incoming) {
    if (map.has(e.id)) updated += 1;
    else added += 1;
    map.set(e.id, e);
  }
  const events = [...map.values()].sort((a, b) => b.value - a.value || b.delta - a.delta || a.id.localeCompare(b.id));
  return { events, added, updated, total: events.length };
}

export function saveDay(root, date, events, meta) {
  const file = paths(root).dayFile(date);
  const payload = {
    date,
    generated_at: new Date().toISOString(),
    schema_version: 1,
    ...meta,
    event_count: events.length,
    events,
  };
  writeJSON(file, payload);
  return file;
}

export function saveIndex(root, index) {
  writeJSON(paths(root).indexFile, index);
}

export function loadIndex(root) {
  const local = paths(root).indexFile;
  const published = path.join(root, "site", "data", "index.json");
  return readJSON(exists(local) ? local : published, null);
}

export function loadSeen(root) {
  const local = paths(root).seenFile;
  const published = path.join(root, "site", "data", "seen.json");
  const data = readJSON(exists(local) ? local : published, null);
  return data?.ids ?? {};
}

export function saveSeen(root, ids) {
  const current = loadSeen(root);
  if (JSON.stringify(current) === JSON.stringify(ids)) return;
  writeJSON(paths(root).seenFile, { updated_at: new Date().toISOString(), ids });
}

export function saveRun(root, date, report) {
  writeJSON(paths(root).runFile(date), report);
}

export function seedEventsFromCache(root, date) {
  const day = loadDay(root, date);
  return day?.events ?? [];
}

/** 把机器可读数据同步到站点目录，供前端直接 fetch。 */
export function publishData(root, dates) {
  const site = paths(root).siteDir;
  const dataDir = path.join(site, "data");
  ensureDir(dataDir);
  for (const d of dates) {
    const src = paths(root).dayFile(d);
    if (!exists(src)) throw new Error(`缺少正式事件数据：${src}`);
    fs.copyFileSync(src, path.join(dataDir, `${d}.json`));
  }
  const idx = paths(root).indexFile;
  if (exists(idx)) fs.copyFileSync(idx, path.join(dataDir, "index.json"));
  const seen = paths(root).seenFile;
  if (exists(seen)) fs.copyFileSync(seen, path.join(dataDir, "seen.json"));
  const expected = new Set(dates.map((d) => `${d}.json`));
  for (const file of fs.readdirSync(dataDir)) {
    if (/^\d{4}-\d{2}-\d{2}\.json$/.test(file) && !expected.has(file)) {
      fs.rmSync(path.join(dataDir, file));
    }
  }
  log("info", `已同步 ${dates.length} 天的数据到 site/data/`);
}
