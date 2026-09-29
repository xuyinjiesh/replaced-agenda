import { clamp, round } from "./util.mjs";

export const DIRECTION_SIGN = { advance: 1, setback: -1, neutral: 0 };

/**
 * 单条事件对领域指数的贡献。
 * relation="indirect" 的条目贡献恒为 0：它们说的是「这个产品有替代潜力」，
 * 是推断而不是观测。把推断计入进程指数会让「AI 取代人类」看起来比实际快，
 * 正是这个项目一开始花大力气修掉的评分膨胀。它们在页面上照常显示，只是不参与指数。
 */
export function contributionOf(e) {
  if (e.relation === "indirect") return 0;
  const sign = DIRECTION_SIGN[e.direction] ?? 1;
  return sign * e.value * e.confidence;
}

/**
 * 由 dailyBaseline × horizonDays 推导各领域的指数尺度 K。
 * 语义：在保持日均基线贡献的节奏下，该领域指数约在 horizonDays 天后达到 63%。
 */
export function resolveDomains(domains, scoring) {
  const horizon = scoring?.indexModel?.horizonDays ?? 90;
  return domains.map((d) => ({
    ...d,
    horizonDays: horizon,
    scale: Math.max(1, Math.round((d.dailyBaseline ?? 2) * horizon)),
  }));
}

/** 领域进程指数：0-100 的饱和曲线。cum 为历史累计贡献（可为负 = 净回退）。 */
export function indexOf(cumulative, scale) {
  const k = scale > 0 ? scale : 50;
  return clamp(100 * (1 - Math.exp(-cumulative / k)), -100, 100);
}

/**
 * 把填充后的条目转成 schema 记录。
 * 必需字段严格按约定：date / domain / value / delta / model / source_url / evidence_quote / evidence_type / confidence
 */
export function toEvent(item, { scoring }) {
  const value = round(clamp(item.value, 0, 1), 3);
  const confidence = round(clamp(item.confidence, 0, 1), 3);
  return {
    // ---- 约定 schema ----
    date: item.itemDate,
    domain: item.domain,
    value,
    delta: 0, // 由 computeIndex 回填
    model: item.model || "未指明",
    source_url: item.url,
    evidence_quote: item.evidenceQuote || "",
    evidence_type: item.evidenceType,
    confidence,
    // ---- 展示与审计所需的附加字段 ----
    id: item.id,
    title: item.title,
    title_zh: item.titleZh || item.title,
    title_zh_missing: Boolean(item.titleZhMissing),
    companies: item.companies ?? [],
    concepts: item.concepts ?? [],
    summary_zh: item.summaryZh,
    keywords: item.keywords ?? [],
    why_zh: item.whyZh ?? "",
    displacement: round(clamp(item.displacement ?? 0, 0, 1), 3),
    sector: item.sector === "internet" ? "internet" : "academia",
    relation: item.relation === "direct" ? "direct" : "indirect",
    direction: item.direction ?? "advance",
    // relation 决定这条是否计入指数，见 computeIndex
    value_capped: item.valueCapped || "",
    value_basis: item.valueBasis || "",
    ai_systems: item.aiSystems?.length ? item.aiSystems : item.model && item.model !== "未指明" ? [item.model] : [],
    evidence_verified: Boolean(item.evidenceVerified),
    evidence_match_ratio: round(item.evidenceMatchRatio ?? 0, 2),
    source_name: item.sourceName,
    source_group: item.sourceGroup,
    source_id: item.sourceId,
    published_at: item.published,
    authors: item.authors ?? [],
    also_reported_by: item.alsoReportedBy ?? [],
    cluster_size: item.clusterSize ?? 1,
    screened_by: scoring.models.screening,
    scored_by: scoring.models.enrichment,
    index_contribution: 0, // 由 computeIndex 回填
  };
}

/**
 * 计算领域指数与每条事件的 delta。
 *
 * delta_i = Index(cum_before + c_i) - Index(cum_before)
 * 因此同一领域同一天所有事件的 delta 之和恒等于该领域当日指数变化量 —— 可加、可核验。
 */
export function computeIndex(events, { domains, epoch }) {
  const scaleOf = new Map(domains.map((d) => [d.key, d.scale ?? 50]));
  const ordered = [...events].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      b.value - a.value ||
      b.confidence - a.confidence ||
      a.id.localeCompare(b.id),
  );

  const cumulative = new Map();
  const domainSeries = new Map();
  const perDay = new Map();

  for (const e of ordered) {
    const scale = scaleOf.get(e.domain) ?? 50;
    const before = cumulative.get(e.domain) ?? 0;
    const contribution = contributionOf(e);
    const after = before + contribution;
    const delta = indexOf(after, scale) - indexOf(before, scale);
    cumulative.set(e.domain, after);

    e.index_contribution = round(contribution, 4);
    e.delta = round(delta, 4);
    e.domain_cumulative_after = round(after, 3);
    e.domain_index = round(indexOf(after, scale), 2);

    if (!domainSeries.has(e.domain)) domainSeries.set(e.domain, []);
    const dayKey = e.date;
    const bucket = perDay.get(`${e.domain}|${dayKey}`) ?? { domain: e.domain, date: dayKey, delta: 0, events: 0, valueSum: 0 };
    bucket.delta += delta;
    bucket.events += 1;
    bucket.valueSum += e.value * e.confidence;
    perDay.set(`${e.domain}|${dayKey}`, bucket);
  }

  // 每个领域的日序列（补齐缺口，便于画曲线）
  const dates = [...new Set(events.map((e) => e.date))].sort();
  for (const d of domains) {
    const rows = [];
    let last = 0;
    for (const date of dates) {
      const bucket = perDay.get(`${d.key}|${date}`);
      const delta = bucket ? bucket.delta : 0;
      last += delta;
      rows.push({
        date,
        delta: round(delta, 4),
        index: round(last, 2),
        events: bucket?.events ?? 0,
        value_sum: round(bucket?.valueSum ?? 0, 3),
      });
    }
    domainSeries.set(d.key, rows);
  }

  const today = dates.at(-1) ?? epoch;
  const summary = domains.map((d) => {
    const rows = domainSeries.get(d.key) ?? [];
    const todayRow = rows.find((r) => r.date === today) ?? { index: 0, delta: 0, events: 0 };
    const prevRow = rows.filter((r) => r.date < today).at(-1) ?? { index: 0 };
    return {
      domain: d.key,
      label: d.label,
      index: todayRow.index,
      delta: todayRow.delta,
      events: todayRow.events,
      cumulative: round(cumulative.get(d.key) ?? 0, 3),
      series: rows,
      index_7d_ago: rows.filter((r) => r.date <= dates[Math.max(0, dates.length - 8)]).at(-1)?.index ?? 0,
      prev_index: prevRow.index,
    };
  });

  const totalDelta = round(summary.reduce((s, d) => s + d.delta, 0), 4);
  return {
    epoch,
    computedAt: new Date().toISOString(),
    dates,
    domains: summary,
    totalDelta,
    eventCount: events.length,
    cumulativeByDomain: Object.fromEntries([...cumulative.entries()].map(([k, v]) => [k, round(v, 3)])),
  };
}

/**
 * 独立复算校验：不信任 computeIndex 写入的字段，重新按公式推导一遍，验证
 *   (1) 每条事件的 delta == Index(cum_after) - Index(cum_before)
 *   (2) 每条事件的 index_contribution == ±value × confidence
 *   (3) 可加性：同一领域同一天所有事件 delta 之和 == 该领域当日指数变化量
 */
export function verifyIndex(events, { domains, tolerance = 1e-3 } = {}) {
  const scaleOf = new Map(domains.map((d) => [d.key, d.scale ?? 50]));
  const ordered = [...events].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      b.value - a.value ||
      b.confidence - a.confidence ||
      a.id.localeCompare(b.id),
  );
  const failures = [];
  const cum = new Map();
  const dayStartIndex = new Map();
  const dayDeltaSum = new Map();
  const dayEndIndex = new Map();

  for (const e of ordered) {
    const scale = scaleOf.get(e.domain) ?? 50;
    const key = `${e.domain}|${e.date}`;
    const before = cum.get(e.domain) ?? 0;
    if (!dayStartIndex.has(key)) dayStartIndex.set(key, indexOf(before, scale));

    const contribution = contributionOf(e);
    const after = before + contribution;
    const expectedDelta = indexOf(after, scale) - indexOf(before, scale);
    cum.set(e.domain, after);

    dayDeltaSum.set(key, (dayDeltaSum.get(key) ?? 0) + e.delta);
    dayEndIndex.set(key, indexOf(after, scale));

    if (Math.abs(expectedDelta - e.delta) > tolerance) {
      failures.push({ id: e.id, kind: "delta_mismatch", expected: expectedDelta, stored: e.delta });
    }
    if (Math.abs(contribution - e.index_contribution) > tolerance) {
      failures.push({ id: e.id, kind: "contribution_mismatch", expected: contribution, stored: e.index_contribution });
    }
  }

  for (const [key, start] of dayStartIndex) {
    const expectedDayDelta = (dayEndIndex.get(key) ?? 0) - start;
    const storedSum = dayDeltaSum.get(key) ?? 0;
    if (Math.abs(expectedDayDelta - storedSum) > 1e-2) {
      failures.push({ key, kind: "day_not_additive", expected: expectedDayDelta, stored: storedSum });
    }
  }

  return { ok: failures.length === 0, failures: failures.slice(0, 10), checkedEvents: ordered.length };
}
