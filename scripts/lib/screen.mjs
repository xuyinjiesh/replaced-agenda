import { buildScreenPrompt, SCREENER_SYSTEM } from "./prompts.mjs";
import { addDaysISO, clamp, daysBetween, groupBy, log, round, resolveSector } from "./util.mjs";
import { truncate } from "./text.mjs";

function dateOfItem(item, fallback) {
  if (!item.published) return fallback;
  const d = new Date(item.published);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toISOString().slice(0, 10);
}

/** 规则初筛：日期窗口、旧闻、词典相关性、去重前置，并把候选量收敛到 AI 可承受的规模。 */
export function rulePrefilter(items, { scoring, date, windowDays = 3, seen = {}, cap = 320, perSourceCap = 45 }) {
  const rel = scoring.relevance;
  const positives = rel.positive.map((p) => p.toLowerCase());
  const negatives = rel.negative.map((p) => p.toLowerCase());
  const cutoff = addDaysISO(date, -windowDays);
  const stats = { input: items.length, stale: 0, seen: 0, negative: 0, tooShort: 0, offTopic: 0, future: 0 };

  const scored = [];
  for (const item of items) {
    const itemDate = dateOfItem(item, date);
    if (itemDate < cutoff) {
      stats.stale += 1;
      continue;
    }
    if (itemDate > date) stats.future += 1;
    const firstSeen = seen[item.id];
    if (firstSeen && firstSeen !== date) {
      stats.seen += 1;
      continue;
    }
    const title = item.title.toLowerCase();
    const body = item.summary.toLowerCase();
    if (negatives.some((n) => title.includes(n) || body.includes(n))) {
      stats.negative += 1;
      continue;
    }
    if ((item.summary ?? "").length < (rel.minAbstractChars ?? 60) && item.sourceGroup === "research") {
      stats.tooShort += 1;
      continue;
    }

    let titleHits = 0;
    let bodyHits = 0;
    for (const p of positives) {
      if (title.includes(p)) titleHits += 1;
      else if (body.includes(p)) bodyHits += 1;
    }
    const researchFeed = item.sourceGroup === "research";
    if (titleHits === 0 && bodyHits === 0 && !researchFeed) {
      stats.offTopic += 1;
      continue;
    }
    const ageDays = Math.max(0, daysBetween(itemDate, date));
    const recencyBonus = (windowDays - Math.min(ageDays, windowDays)) * 0.6;
    // 分组权重。research（arXiv 等）条目量级远大于其他源，权重压低以免淹没公司/媒体；
    // labor 权重最高，因为裁员与招聘数据是「替代真的发生了」最直接的信号。
    const groupBonus =
      {
        labor: 1.5,
        benchmark: 1.2,
        company: 1.1,
        journal: 1.0,
        "ai-lab": 0.9,
        policy: 0.8,
        media: 0.7,
        engineering: 0.6,
        practitioner: 0.5,
        research: researchFeed ? 0.35 : 0,
        community: 0.3,
      }[item.sourceGroup] ?? 0;
    const priority = titleHits * 3 + Math.min(bodyHits, 8) + recencyBonus + groupBonus;
    scored.push({ ...item, itemDate, priority: round(priority, 3) });
  }

  scored.sort((a, b) => b.priority - a.priority || String(b.published).localeCompare(String(a.published)));

  // 按 hintDomain 分配配额：全局排序会让 AI 类目挤掉数学/物理等低频领域，
  // 按领域配额保证每个领域都有机会进入 AI 视野（最终领域由 AI 判定）。
  const capPerDomain = scoring.screening?.capPerDomain ?? Math.ceil(cap / 8);
  const perSource = new Map();
  const perDomain = new Map();
  const picked = [];
  const taken = new Set();
  for (const item of scored) {
    const dom = item.hintDomain ?? "_none";
    const dUsed = perDomain.get(dom) ?? 0;
    if (dUsed >= capPerDomain) continue;
    const sUsed = perSource.get(item.sourceId) ?? 0;
    if (sUsed >= perSourceCap) continue;
    perDomain.set(dom, dUsed + 1);
    perSource.set(item.sourceId, sUsed + 1);
    picked.push(item);
    taken.add(item.id);
  }
  // 频道保底：科研源条目量级远大于互联网源，只按优先级排会让互联网频道被完全挤掉。
  // 这里为互联网频道预留一个下限名额，且这些名额在后续裁剪中不会被砍掉。
  const sectorOf = (it) => (it.sectorHint === "internet" ? "internet" : "academia");
  const floorShare = scoring.screening?.sectorFloorShare ?? 0.25;
  const floorTarget = Math.ceil(cap * floorShare);
  const guaranteed = new Set();
  let netCount = picked.filter((it) => sectorOf(it) === "internet").length;
  if (netCount < floorTarget) {
    for (const item of scored) {
      if (netCount >= floorTarget) break;
      if (taken.has(item.id) || sectorOf(item) !== "internet") continue;
      picked.push(item);
      taken.add(item.id);
      guaranteed.add(item.id);
      netCount += 1;
    }
  }

  // 超出上限时按优先级裁剪，但保底名额不受影响
  if (picked.length > cap) {
    picked.sort((a, b) => b.priority - a.priority);
    const keep = picked.filter((it) => guaranteed.has(it.id));
    const rest = picked.filter((it) => !guaranteed.has(it.id));
    picked.length = 0;
    picked.push(...keep, ...rest.slice(0, Math.max(0, cap - keep.length)));
  }

  // 配额没用满全局上限时，用全局优先级最高的剩余条目补足
  if (picked.length < cap) {
    for (const item of scored) {
      if (picked.length >= cap) break;
      if (taken.has(item.id)) continue;
      picked.push(item);
      taken.add(item.id);
    }
  }
  picked.sort((a, b) => b.priority - a.priority);

  const domainMix = Object.fromEntries([...perDomain.entries()].sort((a, b) => b[1] - a[1]));
  log(
    "info",
    `规则初筛：${stats.input} → ${picked.length} 条候选`,
    `丢弃 旧闻${stats.stale} 已见${stats.seen} 排除词${stats.negative} 过短${stats.tooShort} 离题${stats.offTopic}`,
  );
  const sectorMix = picked.reduce((acc, it) => {
    const k = sectorOf(it);
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  log("info", `候选领域分布：${JSON.stringify(domainMix)}`);
  log("info", `候选频道分布：${JSON.stringify(sectorMix)}（互联网保底 ${floorTarget} 条）`);
  return { candidates: picked, stats: { ...stats, domainMix, sectorMix } };
}

/**
 * 判定 relation。
 * 学术界：严格口径已要求指出被替代的人类工作，因此一律 direct。
 * 互联网：口径放宽、允许间接关系，由 AI 判定；判断不了时按 indirect 保守处理。
 */
function relationOf(sector, aiValue) {
  if (sector === "academia") return "direct";
  return String(aiValue ?? "").trim().toLowerCase() === "direct" ? "direct" : "indirect";
}

function normalizeScreenResult(raw, item, scoring) {
  const domain = String(raw?.domain ?? "").trim();
  const dir = String(raw?.direction ?? "advance").trim();
  const basisRaw = String(raw?.evidence_basis ?? "").trim();
  const basis = /^(none|n\/a|-|无|无具体依据)$/i.test(basisRaw) ? "" : basisRaw;

  let value = clamp(Number(raw?.value ?? 0), 0, 1);
  // 硬闸门：给不出具体依据就不允许给高价值
  const requireAbove = scoring.screening?.requireBasisAbove ?? 0.65;
  const basislessCap = scoring.screening?.basislessValueCap ?? 0.6;
  let capped = false;
  if (value >= requireAbove && !basis) {
    value = Math.min(value, basislessCap);
    capped = true;
  }

  const sector = resolveSector(raw?.sector, item.sectorHint);

  // 证据类型保持模型的原判；自述型来源的分值封顶在填充阶段用 evidenceCeilingCap 施加
  const evidenceType = String(raw?.evidence_type ?? "unknown").trim();

  return {
    ...item,
    relevance: clamp(Number(raw?.relevance ?? 0), 0, 1),
    domain,
    value,
    valueBasis: basis,
    valueCappedByBasis: capped,
    displacement: clamp(Number(raw?.displacement ?? 0), 0, 1),
    sector,
    // 「直接替代」还是「具备替代潜力」，只对互联网频道有意义。
    // 学术界走的是严格口径（必须能指出哪类人类工作会变少），通过即等于直接替代；
    // 若这里也跟着标 indirect，指数会被抽空（实测 120 条里 89 条 indirect，总 Δ 从 10.5 掉到 2.6）。
    relation: relationOf(sector, raw?.relation),
    direction: ["advance", "setback", "neutral"].includes(dir) ? dir : "advance",
    evidenceType,
    aiSystems: Array.isArray(raw?.ai_systems) ? raw.ai_systems.map((s) => String(s)).filter(Boolean).slice(0, 5) : [],
    screenReason: String(raw?.reason ?? "").slice(0, 200),
    keep: raw?.keep !== false,
  };
}

/** AI 初筛：批处理判断相关性并以统一口径给出初版评分。 */
export async function aiScreen(client, candidates, { domains, scoring, dryRun = false }) {
  if (dryRun && candidates.length === 0) return { kept: [], stats: { batches: 0, failed: 0 } };
  const validDomains = new Set(domains.map((d) => d.key));
  const size = scoring.screening.maxItemsPerBatch ?? 12;
  const batches = [];
  for (let i = 0; i < candidates.length; i += size) batches.push(candidates.slice(i, i + size));

  const stats = { batches: batches.length, failed: 0, droppedByAI: 0, droppedByThreshold: 0, badDomain: 0 };
  const results = await Promise.all(
    batches.map(async (batch, bi) => {
      const res = await client.chatJSON({
        model: scoring.models.screening,
        system: SCREENER_SYSTEM,
        user: buildScreenPrompt({ items: batch, domains, scoring }),
        temperature: 0.1,
        maxTokens: 4096,
      });
      if (!res.ok) {
        stats.failed += 1;
        log("warn", `初筛批次 ${bi + 1}/${batches.length} 失败`, res.error);
        return [];
      }
      const byIndex = new Map();
      for (const row of res.data?.items ?? []) {
        const idx = Number(row?.i);
        if (Number.isInteger(idx)) byIndex.set(idx, row);
      }
      const out = [];
      for (let i = 0; i < batch.length; i += 1) {
        const raw = byIndex.get(i);
        if (!raw) continue; // 模型漏答的直接丢弃，宁可少不要滥
        const normalized = normalizeScreenResult(raw, batch[i], scoring);
        if (!normalized.keep) {
          stats.droppedByAI += 1;
          continue;
        }
        if (normalized.relevance < scoring.screening.minRelevance || normalized.value < scoring.screening.minValue) {
          stats.droppedByThreshold += 1;
          continue;
        }
        if (!validDomains.has(normalized.domain)) {
          normalized.domain = batch[i].hintDomain ?? "software";
          stats.badDomain += 1;
        }
        out.push(normalized);
      }
      return out;
    }),
  );

  const kept = results.flat().sort((a, b) => b.value - a.value || b.priority - a.priority);
  const mix = (list, f) => list.reduce((a, x) => ((a[f(x)] = (a[f(x)] ?? 0) + 1), a), {});
  log(
    "info",
    `AI 初筛：${candidates.length} → ${kept.length} 条通过`,
    `通过频道 ${JSON.stringify(mix(kept, (x) => x.sector))} / 候选频道 ${JSON.stringify(mix(candidates, (x) => x.sectorHint ?? "academia"))}`,
  );
  log(
    "info",
    `AI 初筛：${candidates.length} → ${kept.length} 条通过`,
    `批次${stats.batches} 失败${stats.failed} AI判定无关${stats.droppedByAI} 低于阈值${stats.droppedByThreshold} 领域兜底${stats.badDomain}`,
  );
  return { kept, stats };
}

/** 灰区相似对复核（规则拿不准时让 AI 判断是否同一件事）。 */
export async function aiMergeGray(client, prepared, grayPairs, { scoring }) {
  if (grayPairs.length === 0) return { decisions: [], stats: { asked: 0, merged: 0 } };
  const { buildMergePrompt, MERGER_SYSTEM } = await import("./prompts.mjs");
  const limited = grayPairs.slice(0, 40);
  const chunks = [];
  for (let i = 0; i < limited.length; i += 8) chunks.push(limited.slice(i, i + 8));

  const stats = { asked: limited.length, merged: 0, failed: 0 };
  const decisions = [];
  await Promise.all(
    chunks.map(async (chunk) => {
      const clusters = chunk.map(([i, j]) => [prepared[i], prepared[j]]);
      const res = await client.chatJSON({
        model: scoring.models.merger,
        system: MERGER_SYSTEM,
        user: buildMergePrompt({ clusters }),
        temperature: 0,
        maxTokens: 1024,
      });
      if (!res.ok) {
        stats.failed += 1;
        return;
      }
      for (const row of res.data?.clusters ?? []) {
        const idx = Number(row?.c);
        if (!Number.isInteger(idx) || idx >= chunk.length) continue;
        const [i, j] = chunk[idx];
        if (row?.merge === true) {
          stats.merged += 1;
          decisions.push({ i, j, keep: Number(row?.keep_j) === 1 ? j : i, reason: String(row?.reason ?? "") });
        }
      }
    }),
  );
  log("info", `灰区复核：询问 ${stats.asked} 对，判定合并 ${stats.merged} 对`);
  return { decisions, stats };
}

export { truncate, groupBy };