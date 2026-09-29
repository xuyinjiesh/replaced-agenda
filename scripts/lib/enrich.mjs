import { buildEnrichPrompt, buildSummaryPrompt, ENRICHER_SYSTEM } from "./prompts.mjs";
import { canonicalEvidenceCheck } from "./evidence.mjs";
import { clamp, evidenceCeilingCap, log, round, resolveSector, takeWithFloor } from "./util.mjs";

function normalizeEnriched(raw, item, scoring, validDomains) {
  // 保留模型给出的真实证据类型，封顶只作用在分值上（见 util.mjs 的 evidenceCeilingCap）
  const evType = Object.hasOwn(scoring.evidenceTypes, String(raw?.evidence_type ?? ""))
    ? String(raw.evidence_type)
    : item.evidenceType && Object.hasOwn(scoring.evidenceTypes, item.evidenceType)
      ? item.evidenceType
      : "unknown";

  const dir = String(raw?.direction ?? item.direction ?? "advance");
  const keywords = Array.isArray(raw?.keywords)
    ? raw.keywords.map((k) => String(k).trim()).filter(Boolean).slice(0, 6)
    : [];

  const titleZh = String(raw?.title_zh ?? "").trim();
  const pickTerms = (v, max) =>
    (Array.isArray(v) ? v : [])
      .map((x) => String(x).trim())
      .filter(Boolean)
      .slice(0, max);

  const quote = String(raw?.evidence_quote ?? "").trim();
  const check = canonicalEvidenceCheck(quote, item);

  let confidence = clamp(Number(raw?.confidence ?? scoring.evidenceTypes[evType].prior), 0, 1);
  // 证据无法在原文中核对时，降低可信度（这是防止模型编造引文的关键闸门）
  if (quote && !check.verified) confidence = clamp(confidence * 0.6, 0, 1);
  if (!quote) confidence = clamp(confidence * 0.85, 0, 1);

  // ---- 硬闸门 1：给不出具体依据就不允许给高价值 ----
  const basisRaw = String(raw?.evidence_basis ?? item.valueBasis ?? "").trim();
  const basis = /^(none|n\/a|-|无|无具体依据)$/i.test(basisRaw) ? "" : basisRaw;
  const requireAbove = scoring.screening?.requireBasisAbove ?? 0.65;
  const basislessCap = scoring.screening?.basislessValueCap ?? 0.6;

  // ---- 硬闸门 2：证据类型决定的价值上限（预印本不允许声称里程碑） ----
  const typeCap = evidenceCeilingCap(evType, item.evidenceCeiling, scoring);

  let value = clamp(Number(raw?.value ?? item.value), 0, 1);
  let cappedBy = "";
  if (value >= requireAbove && !basis) {
    value = Math.min(value, basislessCap);
    cappedBy = "no_basis";
  }
  if (value > typeCap) {
    value = typeCap;
    cappedBy = cappedBy ? `${cappedBy}+evidence_type` : "evidence_type";
  }
  value = clamp(value, 0, 1);

  return {
    ...item,
    // 标题与摘要都可能有英文原文；title_zh 缺失时退回原标题（仍比空白强）
    titleZh: titleZh || String(item.title ?? "").trim(),
    summaryZh: String(raw?.summary_zh ?? "").trim(),
    companies: pickTerms(raw?.companies, 6),
    concepts: pickTerms(raw?.concepts, 6),
    keywords,
    whyZh: String(raw?.why_zh ?? "").trim(),
    evidenceQuote: check.quote || quote,
    evidenceVerified: check.verified,
    evidenceMatchRatio: check.ratio,
    domain: (() => {
      const d = String(raw?.domain ?? "").trim();
      return validDomains.has(d) ? d : item.domain;
    })(),
    value,
    valueCapped: cappedBy,
    valueBasis: basis,
    displacement: clamp(Number(raw?.displacement ?? item.displacement), 0, 1),
    direction: ["advance", "setback", "neutral"].includes(dir) ? dir : "advance",
    // 频道归属只在初筛判定一次，这里原样沿用；
    // 若初筛缺值才退回来源先验。两个阶段都判会互相覆盖（实测填充阶段把工业界全改回 academia）。
    sector: resolveSector(item.sector, item.sectorHint),
    evidenceType: evType,
    model: String(raw?.model ?? "").trim() || "未指明",
    confidence: round(confidence, 3),
    enriched: true,
  };
}

/**
 * 内容填充阶段：中文摘要、关键词、原文证据片段、最终评分。
 * 用更强的模型复核初筛结果，输出即最终写入 schema 的字段。
 */
export async function aiEnrich(client, screened, { scoring, domains, cap = 120, batchSize = 6 }) {
  const validDomains = new Set((domains ?? []).map((d) => d.key));
  // 与候选阶段同样的频道保底，避免按分数截断时把工业界整段切掉
  const targets = takeWithFloor(screened, cap, {
    key: (x) => x.sector,
    want: "internet",
    share: scoring.screening?.sectorFloorShare ?? 0.25,
  });
  const dropped = screened.length - targets.length;
  if (dropped > 0) log("warn", `内容填充上限 ${cap}，其余 ${dropped} 条本轮不处理（提高 enrichCap 可纳入）`);

  const batches = [];
  for (let i = 0; i < targets.length; i += batchSize) batches.push(targets.slice(i, i + batchSize));

  const stats = { batches: batches.length, failed: 0, unverifiedQuotes: 0, emptyQuotes: 0, missing: 0, repaired: 0, repairFailed: 0 };
  const results = await Promise.all(
    batches.map(async (batch, bi) => {
      const res = await client.chatJSON({
        model: scoring.models.enrichment,
        system: ENRICHER_SYSTEM,
        user: buildEnrichPrompt({ items: batch, scoring, anchors: scoring.anchors?.items }),
        temperature: 0.1,
        maxTokens: 6144,
      });
      if (!res.ok) {
        stats.failed += 1;
        log("warn", `填充批次 ${bi + 1}/${batches.length} 失败`, res.error);
        // 失败时降级：保留初筛结果，摘要退化为原标题，并显著下调可信度
        return batch.map((item) => ({
          ...item,
          summaryZh: item.title,
          keywords: ["AI"],
          whyZh: item.screenReason,
          evidenceQuote: "",
          evidenceVerified: false,
          evidenceMatchRatio: 0,
          model: "未指明",
          confidence: round(clamp(item.value * 0.3, 0, 0.4), 3),
          enriched: false,
          enrichFailed: true,
        }));
      }
      const byIndex = new Map();
      for (const row of res.data?.items ?? []) {
        const idx = Number(row?.i);
        if (Number.isInteger(idx)) byIndex.set(idx, row);
      }
      const out = [];
      for (let i = 0; i < batch.length; i += 1) {
        const raw = byIndex.get(i);
        // 模型偶尔会漏返回某几条。静默丢弃会让条目凭空消失，
        // 这里保留下来并标记，交给后面的修复轮次补摘要与关键词。
        if (!raw) {
          stats.missing += 1;
          out.push({
            ...batch[i],
            summaryZh: "",
            keywords: [],
            whyZh: batch[i].screenReason ?? "",
            evidenceQuote: "",
            evidenceVerified: false,
            evidenceMatchRatio: 0,
            model: "未指明",
            confidence: round(clamp(batch[i].value * 0.5, 0, 0.5), 3),
            enriched: false,
            enrichMissing: true,
          });
          continue;
        }
        const enriched = normalizeEnriched(raw, batch[i], scoring, validDomains);
        if (!enriched.evidenceQuote) stats.emptyQuotes += 1;
        else if (!enriched.evidenceVerified) stats.unverifiedQuotes += 1;
        out.push(enriched);
      }
      return out;
    }),
  );

  let enriched = results.flat();

  // ---- 定向修复：中文摘要与关键词 ----
  // 主轮次要一次性产出七八个字段，实测有一部分条目会漏掉摘要。
  // 标题和摘要都是首页唯一可读的内容，缺了就等于把英文原文当中文显示，所以单独补一轮。
  const needsRepair = enriched.filter((e) => !hasChinese(e.titleZh) || !hasChinese(e.summaryZh) || !e.keywords?.length);
  if (needsRepair.length) {
    const repairStats = await fillSummaries(client, needsRepair, { scoring });
    stats.repaired = repairStats.repaired;
    stats.repairFailed = repairStats.failed;
    enriched = enriched.map((e) => {
      const p = repairStats.patches.get(e.id);
      if (!p) return e;
      return {
        ...e,
        titleZh: hasChinese(p.title_zh) ? String(p.title_zh).trim() : e.titleZh || e.title,
        summaryZh: hasChinese(p.summary_zh) ? String(p.summary_zh).trim() : e.summaryZh || e.title,
        keywords: Array.isArray(p.keywords) ? p.keywords.map((k) => String(k).trim()).filter(Boolean).slice(0, 6) : e.keywords,
        whyZh: String(p.why_zh ?? "").trim() || e.whyZh,
        summaryRepaired: true,
      };
    });
    log("info", `标题/摘要修复：${needsRepair.length} 条待补，成功 ${stats.repaired} 条`);
  }
  // 修复后仍没有中文摘要的，退回标题并标记，便于在页面上识别
  enriched = enriched.map((e) => (hasChinese(e.summaryZh) ? e : { ...e, summaryZh: e.title, summaryMissing: true }));
  // 标题没有中文的单独标记（页面会拿它当副标题显示英文原名，见渲染层）
  enriched = enriched.map((e) => (hasChinese(e.titleZh) ? e : { ...e, titleZhMissing: true }));

  enriched.sort((a, b) => b.value - a.value || b.confidence - a.confidence);
  const smix = (list) => list.reduce((a, x) => ((a[x.sector ?? "(无)"] = (a[x.sector ?? "(无)"] ?? 0) + 1), a), {});
  log("info", `频道归属 填充前 ${JSON.stringify(smix(screened))} → 填充后 ${JSON.stringify(smix(enriched))}`);
  log(
    "info",
    `内容填充：${screened.length} → ${enriched.length} 条完成`,
    `批次${stats.batches} 失败${stats.failed} 漏返回${stats.missing} 引文无法核对${stats.unverifiedQuotes} 无引文${stats.emptyQuotes}`,
    `无中文摘要${enriched.filter((e) => e.summaryMissing).length}`,
  );
  return { enriched, stats };
}

/** 判断字符串里是否含中文（用来识别「摘要其实是英文标题」这种退化情况）。 */
function hasChinese(s) {
  return /[\u4e00-\u9fff]/.test(String(s ?? ""));
}

/** 只补中文摘要与关键词的定向调用。 */
async function fillSummaries(client, items, { scoring, batchSize = 10 }) {
  const batches = [];
  for (let i = 0; i < items.length; i += batchSize) batches.push(items.slice(i, i + batchSize));
  // 以 item.id 为键，避免依赖批次内下标还原（多个批次的下标都从 0 开始，无法事后区分）
  const patches = new Map();
  let repaired = 0;
  let failed = 0;

  const results = await Promise.all(
    batches.map(async (batch, bi) => {
      const res = await client.chatJSON({
        model: scoring.models.summarizer ?? scoring.models.merger ?? scoring.models.enrichment,
        system: "你是中文科技编辑，负责把英文论文标题与摘要浓缩成准确的中文摘要。严格只输出 JSON。",
        user: buildSummaryPrompt({ items: batch }),
        temperature: 0.2,
        maxTokens: 3072,
      });
      if (!res.ok) {
        failed += batch.length;
        log("warn", `摘要修复批次 ${bi + 1}/${batches.length} 失败`, res.error);
        return [];
      }
      // 立刻把「批次内下标」解析成真实条目，后续不再需要批次信息
      return (res.data?.items ?? [])
        .map((row) => {
          const idx = Number(row?.i);
          const target = Number.isInteger(idx) ? batch[idx] : null;
          return target ? { id: target.id, row } : null;
        })
        .filter(Boolean);
    }),
  );

  for (const { id, row } of results.flat()) {
    patches.set(id, row);
    if (hasChinese(row.summary_zh)) repaired += 1;
  }
  return { patches, repaired, failed };
}
