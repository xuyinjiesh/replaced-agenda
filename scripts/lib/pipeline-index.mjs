import fs from "node:fs";
import path from "node:path";
import { sourceStats } from "./dedupe.mjs";
import { computeIndex, verifyIndex } from "./score.mjs";
import { listEventDates, loadDay, loadIndex, paths, saveDay, saveIndex } from "./store.mjs";

export function recomputeIndex({ root: ROOT, date, dayEvents, domains, scoring, verify = verifyIndex }) {
  // ---------- 8. 全量重算指数 ----------
  const existingDates = listEventDates(ROOT);
  const previousDays = existingDates
    .filter((d) => d !== date)
    .map((d) => loadDay(ROOT, d))
    .filter(Boolean);
  const eventsById = new Map();
  for (const event of previousDays.flatMap((d) => d.events ?? [])) eventsById.set(event.id, event);
  for (const event of dayEvents) eventsById.set(event.id, event);
  const allEvents = [...eventsById.values()];
  const indexData = computeIndex(allEvents, { domains, epoch: scoring.indexModel.epoch });
  const verification = verify(allEvents, { domains });
  if (!verification.ok) {
    throw new Error(`指数一致性校验未通过：${JSON.stringify(verification.failures)}`);
  }

  // 把重算后的 delta / 指数写回每一天的文件，保证整份语料自洽
  const byDate = new Map();
  for (const e of allEvents) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }
  for (const [d, evs] of byDate) {
    const prev = loadDay(ROOT, d);
    const sorted = [...evs].sort((a, b) => b.value - a.value || b.delta - a.delta || a.id.localeCompare(b.id));
    const domSummary = indexData.domains
      .map((dm) => {
        const row = (dm.series ?? []).find((s) => s.date === d);
        return row && (row.events > 0 || row.delta !== 0) ? { domain: dm.domain, ...row } : null;
      })
      .filter(Boolean);
    if (!prev || JSON.stringify(prev.events) !== JSON.stringify(sorted) || JSON.stringify(prev.domains) !== JSON.stringify(domSummary)) {
      saveDay(ROOT, d, sorted, {
        generated_at: prev?.generated_at ?? new Date().toISOString(),
        recomputed_at: new Date().toISOString(),
        previous_event_count: prev?.event_count ?? 0,
        domains: domSummary,
        stats: prev?.stats ?? null,
      });
    }
  }
  for (const d of existingDates) {
    if (!byDate.has(d)) {
      fs.rmSync(paths(ROOT).dayFile(d), { force: true });
      fs.rmSync(path.join(ROOT, "site", "data", `${d}.json`), { force: true });
    }
  }
  const nextIndex = {
    ...indexData,
    source_stats: sourceStats(allEvents),
    verification,
  };
  const previousIndex = loadIndex(ROOT);
  const withoutTimestamp = ({ computedAt, ...value }) => value;
  if (previousIndex && JSON.stringify(withoutTimestamp(previousIndex)) === JSON.stringify(withoutTimestamp(nextIndex))) {
    return { indexData: previousIndex, verification };
  }
  saveIndex(ROOT, nextIndex);

  return { indexData: nextIndex, verification };
}
