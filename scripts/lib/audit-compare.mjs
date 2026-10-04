import { truncate } from "./text.mjs";

export function compareAudit(events, auditItems, scoring) {
  const byId = new Map(auditItems.map((a) => [String(a.id), a]));
  const rows = [];
  for (const e of events) {
    const a = byId.get(e.id);
    if (!a) continue;
    const diff = Number(a.value) - e.value;
    const domainMismatch = String(a.domain) !== e.domain;
    rows.push({
      id: e.id,
      title: truncate(e.title, 90),
      domain: e.domain,
      audited_domain: a.domain,
      value: e.value,
      audited_value: Number(Number(a.value).toFixed(3)),
      diff: Number(diff.toFixed(3)),
      verdict: domainMismatch && a.verdict === "agree" ? "misclassified" : a.verdict,
      reason: a.reason,
      evidence_type: e.evidence_type,
      confidence: e.confidence,
      source: e.source_name,
    });
  }
  const n = rows.length || 1;
  const meanDiff = rows.reduce((s, r) => s + r.diff, 0) / n;
  const meanAbsDiff = rows.reduce((s, r) => s + Math.abs(r.diff), 0) / n;
  const over = rows.filter((r) => r.diff <= -0.15).length;
  const under = rows.filter((r) => r.diff >= 0.15).length;
  const flagged = rows.filter((r) => r.verdict !== "agree");
  const domainMismatch = rows.filter((r) => r.audited_domain && r.audited_domain !== r.domain).length;

  const median = (xs) => {
    if (!xs.length) return null;
    const a = [...xs].sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };
  const originalMedian = median(rows.map((r) => r.value));
  const auditedMedian = median(rows.map((r) => r.audited_value));
  const [lo, hi] = scoring.calibration?.expectedMedianValue ?? [0.3, 0.55];
  const verdicts = [];
  // 措辞保持中性：两个模型的分歧方向不能直接归因于某一方错了
  if (meanDiff <= -0.12) verdicts.push(`复核模型整体比原评分低 ${(-meanDiff).toFixed(2)}（原评分偏宽，或复核模型偏严）`);
  if (meanDiff >= 0.12) verdicts.push(`复核模型整体比原评分高 ${meanDiff.toFixed(2)}（原评分偏严，或复核模型偏宽）`);
  if (over / n > 0.3) verdicts.push(`${((over / n) * 100).toFixed(0)}% 的条目两个模型相差 ≥0.15`);
  if (domainMismatch / n > 0.2) verdicts.push(`${((domainMismatch / n) * 100).toFixed(0)}% 的领域判定不一致`);
  if (!verdicts.length) verdicts.push("两个模型的分歧在可接受范围内");

  return {
    rows,
    summary: {
      compared: rows.length,
      meanDiff: Number(meanDiff.toFixed(3)),
      meanAbsDiff: Number(meanAbsDiff.toFixed(3)),
      overScored: over,
      underScored: under,
      flagged: flagged.length,
      domainMismatch,
      agreeRate: Number(((rows.length - flagged.length) / n).toFixed(3)),
      originalMedian: originalMedian === null ? null : Number(originalMedian.toFixed(3)),
      auditedMedian: auditedMedian === null ? null : Number(auditedMedian.toFixed(3)),
      expectedMedianRange: [lo, hi],
      verdict: verdicts,
    },
  };
}
