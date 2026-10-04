function quantile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
}

export function valueDistribution(events) {
  const vals = events.map((e) => e.value).sort((a, b) => a - b);
  const confs = events.map((e) => e.confidence).sort((a, b) => a - b);
  const high = vals.filter((v) => v >= 0.7).length;
  const byType = {};
  for (const e of events) byType[e.evidence_type] = (byType[e.evidence_type] ?? 0) + 1;
  return {
    count: events.length,
    medianValue: Number(quantile(vals, 0.5).toFixed(3)),
    p25Value: Number(quantile(vals, 0.25).toFixed(3)),
    p75Value: Number(quantile(vals, 0.75).toFixed(3)),
    maxValue: vals.at(-1) ?? 0,
    medianConfidence: Number(quantile(confs, 0.5).toFixed(3)),
    highValueShare: vals.length ? Number((high / vals.length).toFixed(3)) : 0,
    cappedByBasis: events.filter((e) => (e.value_capped ?? "").includes("no_basis")).length,
    cappedByEvidenceType: events.filter((e) => (e.value_capped ?? "").includes("evidence_type")).length,
    unverifiedQuotes: events.filter((e) => !e.evidence_verified).length,
    evidenceTypes: byType,
  };
}

export function checkCalibration(dist, cfg) {
  const warnings = [];
  if (!cfg || !dist.count) return { ok: true, warnings };
  const [lo, hi] = cfg.expectedMedianValue ?? [0.3, 0.55];
  if (dist.medianValue < lo || dist.medianValue > hi) {
    warnings.push(`value 中位数 ${dist.medianValue} 超出预期区间 [${lo}, ${hi}]`);
  }
  if (dist.highValueShare > (cfg.expectedHighValueShare ?? 0.15) * 1.6) {
    warnings.push(`高价值(≥0.7)占比 ${(dist.highValueShare * 100).toFixed(0)}% 明显偏高，评分可能过宽`);
  }
  const [clo, chi] = cfg.expectedMedianConfidence ?? [0.4, 0.75];
  if (dist.medianConfidence < clo || dist.medianConfidence > chi) {
    warnings.push(`confidence 中位数 ${dist.medianConfidence} 超出预期区间 [${clo}, ${chi}]`);
  }
  return { ok: warnings.length === 0, warnings };
}
