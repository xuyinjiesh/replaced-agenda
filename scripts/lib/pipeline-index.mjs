import { sourceStats } from "./dedupe.mjs";
import { computeIndex, verifyIndex } from "./score.mjs";
import { listEventDates, loadDay, saveDay, saveIndex } from "./store.mjs";

export function recomputeIndex({ root: ROOT, date, dayEvents, domains, scoring }) {
  // ---------- 8. 全量重算指数 ----------
  const previousDays = listEventDates(ROOT)
    .filter((d) => d !== date)
    .map((d) => loadDay(ROOT, d))
    .filter(Boolean);
  const allEvents = [...previousDays.flatMap((d) => d.events ?? []), ...dayEvents];
  const indexData = computeIndex(allEvents, { domains, epoch: scoring.indexModel.epoch });
  const verification = verifyIndex(allEvents, { domains });

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
    saveDay(ROOT, d, sorted, {
      generated_at: prev?.generated_at ?? new Date().toISOString(),
      recomputed_at: new Date().toISOString(),
      previous_event_count: prev?.event_count ?? 0,
      domains: domSummary,
      stats: prev?.stats ?? null,
    });
  }
  saveIndex(ROOT, {
    ...indexData,
    source_stats: sourceStats(dayEvents),
    verification,
  });

  return { indexData, verification };
}
