/**
 * 自检：不联网、不调用 AI，验证核心算法的不变量。
 * 运行：node scripts/selftest.mjs
 */
import { canonicalEvidenceCheck } from "./lib/evidence.mjs";
import { dedupe, applyMergeDecisions } from "./lib/dedupe.mjs";
import { parseFeed } from "./lib/xml.mjs";
import { computeIndex, verifyIndex, indexOf, contributionOf } from "./lib/score.mjs";
import { canonicalUrl, extractJSON, jaccard, normalizeTitle, shingles, simhash, hamming, tokenize } from "./lib/text.mjs";
import { aiEnrich } from "./lib/enrich.mjs";
import { toEvent } from "./lib/score.mjs";
import { aiScreen } from "./lib/screen.mjs";
import { readJSON, resolveSector, takeWithFloor } from "./lib/util.mjs";
import { checkCalibration, valueDistribution } from "./lib/pipeline-report.mjs";
import { compareAudit } from "./lib/audit-compare.mjs";

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("\n[1] RSS / Atom 解析");
{
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>arXiv cs.AI</title>
  <item><title>Scaling Laws for &amp; Agents</title><link>https://arxiv.org/abs/2601.00001v2</link>
  <description><![CDATA[We <b>propose</b> a new &amp; better method.]]></description>
  <pubDate>Mon, 28 Sep 2026 04:00:00 +0000</pubDate><dc:creator>Alice; Bob</dc:creator></item>
  <item><title>Second</title><link>https://example.com/b</link><description>plain</description></item>
  </channel></rss>`;
  const out = parseFeed(rss);
  check("条目数", out.items.length === 2, String(out.items.length));
  check("feed 标题", out.feedTitle === "arXiv cs.AI", out.feedTitle);
  check("实体解码", out.items[0].title === "Scaling Laws for & Agents", out.items[0].title);
  check("HTML 去标签", out.items[0].summary === "We propose a new & better method.", out.items[0].summary);
  check("日期解析", out.items[0].published?.startsWith("2026-09-28"), String(out.items[0].published));
  check("作者提取", out.items[0].authors.includes("Alice"), JSON.stringify(out.items[0].authors));
}
{
  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
  <entry><title>Atom Entry</title><link href="https://x.com/a"/><summary>hello</summary><updated>2026-09-27T10:00:00Z</updated></entry>
  </feed>`;
  const out = parseFeed(atom);
  check("Atom 条目", out.items.length === 1 && out.items[0].url === "https://x.com/a", JSON.stringify(out.items[0]?.url));
}

console.log("\n[2] URL 归一");
{
  check("去 utm", canonicalUrl("https://www.Example.com/Path/?utm_source=x&b=1&a=2") === "https://example.com/Path?a=2&b=1", canonicalUrl("https://www.Example.com/Path/?utm_source=x&b=1&a=2"));
  check("arXiv 版本归一", canonicalUrl("https://arxiv.org/pdf/2601.00001v2") === "https://arxiv.org/abs/2601.00001", canonicalUrl("https://arxiv.org/pdf/2601.00001v2"));
}

console.log("\n[3] 文本相似度与去重");
{
  const a = tokenize(normalizeTitle("Scaling Laws for Neural Language Models"));
  const b = tokenize(normalizeTitle("Scaling laws for neural language models."));
  check("标题归一后一致", jaccard(shingles(a, 2), shingles(b, 2)) === 1, String(jaccard(shingles(a, 2), shingles(b, 2))));
  check("SimHash 同文距离 0", hamming(simhash(a), simhash(b)) === 0);

  const items = [
    { id: "1", title: "Scaling Laws for Neural Language Models", summary: "We study scaling laws for neural language models and find power laws relating loss to compute and data.".repeat(1), url: "https://arxiv.org/abs/1", canonicalUrl: "https://arxiv.org/abs/1", sourceId: "a", sourceName: "A", sourceGroup: "research" },
    { id: "2", title: "Scaling laws for neural language models", summary: "We study scaling laws for neural language models and find power laws relating loss to compute and data.", url: "https://arxiv.org/abs/2", canonicalUrl: "https://arxiv.org/abs/2", sourceId: "b", sourceName: "B", sourceGroup: "research" },
    { id: "3", title: "A Completely Different Topic About Protein Folding", summary: "Protein structure prediction with diffusion models and cryo-EM density maps for drug discovery pipelines.", url: "https://example.com/3", canonicalUrl: "https://example.com/3", sourceId: "c", sourceName: "C", sourceGroup: "research" },
  ];
  const { merged } = dedupe(items, { titleJaccard: 0.72, simhashHamming: 3 });
  check("重复被合并", merged.length === 2, `merged=${merged.length}`);
  const dup = merged.find((m) => m.title.toLowerCase().includes("scaling"));
  check("保留 also_reported_by", (dup?.alsoReportedBy ?? []).length === 1, JSON.stringify(dup?.alsoReportedBy));
}

console.log("\n[4] 灰区合并决策");
{
  const items = [
    { id: "a", title: "A", url: "ua", sourceName: "S1", summary: "" },
    { id: "b", title: "B", url: "ub", sourceName: "S2", summary: "" },
    { id: "c", title: "C", url: "uc", sourceName: "S3", summary: "" },
  ];
  const { merged, mergedCount } = applyMergeDecisions(items, [{ i: 0, j: 1, keep: 1 }]);
  check("合并后条数", merged.length === 2, String(merged.length));
  check("合并计数", mergedCount === 1);
  check("保留 AI 选定的主记录", merged.find((m) => m.id === "b")?.alsoReportedBy?.length === 1, JSON.stringify(merged.map((m) => m.id)));
}

console.log("\n[5] 指数模型与 delta 可加性");
{
  const K = 50;
  check("累计 0 → 指数 0", indexOf(0, K) === 0);
  check("单调递增", indexOf(10, K) > indexOf(5, K));
  check("饱和于 100", Math.abs(indexOf(1e6, K) - 100) < 1e-6, String(indexOf(1e6, K)));

  const domains = [{ key: "math", scale: 40 }, { key: "software", scale: 80 }];
  const mk = (id, domain, date, value, confidence, direction) => ({
    id, domain, date, value, confidence, direction, index_contribution: 0, delta: 0,
  });
  const events = [
    mk("e1", "math", "2026-09-27", 0.8, 0.9, "advance"),
    mk("e2", "math", "2026-09-27", 0.5, 0.6, "advance"),
    mk("e3", "math", "2026-09-28", 0.9, 0.8, "advance"),
    mk("e4", "software", "2026-09-28", 0.7, 0.9, "advance"),
    mk("e5", "software", "2026-09-28", 0.6, 0.5, "setback"),
    mk("e6", "software", "2026-09-28", 0.4, 0.8, "neutral"),
  ];
  const idx = computeIndex(events, { domains, epoch: "2026-09-27" });
  const v = verifyIndex(events, { domains });
  check("一致性校验通过", v.ok, JSON.stringify(v.failures));
  check("neutral 不产生 delta", events.find((e) => e.id === "e6").delta === 0);
  check("setback delta 为负", events.find((e) => e.id === "e5").delta < 0, String(events.find((e) => e.id === "e5").delta));

  // 逐日可加性：同日同领域 delta 之和 == 该日指数变化
  // 注意：写入 schema 的 delta 保留 4 位小数，多条累加后会有 1e-4 量级的舍入残差
  for (const d of domains) {
    for (const date of ["2026-09-27", "2026-09-28"]) {
      const sum = events.filter((e) => e.domain === d.key && e.date === date).reduce((s, e) => s + e.delta, 0);
      const row = idx.domains.find((x) => x.domain === d.key).series.find((x) => x.date === date);
      check(`${d.key} ${date} 可加`, Math.abs(sum - row.delta) < 1e-3, `sum=${sum} row=${row.delta}`);
    }
  }
  // 重排后不变量仍成立（同一日多事件顺序变化会改变分配，但当日总量不变）
  const shuffled = [...events].reverse();
  for (const e of shuffled) { e.delta = 0; e.index_contribution = 0; }
  computeIndex(shuffled, { domains, epoch: "2026-09-27" });
  const v2 = verifyIndex(shuffled, { domains });
  check("乱序输入仍自洽", v2.ok, JSON.stringify(v2.failures));
}

console.log("\n[6] 证据引文核对闸门");
{
  const item = { title: "A New Benchmark", summary: "We evaluate our system on 12 tasks and observe a 31% improvement over the previous state of the art." };
  check("逐字引文通过", canonicalEvidenceCheck("a 31% improvement over the previous", item).verified);
  check("编造引文被拒", !canonicalEvidenceCheck("this completely fabricated sentence does not exist anywhere", item).verified);
  check("空引文不通过", !canonicalEvidenceCheck("", item).verified);
  const partial = canonicalEvidenceCheck("We evaluate our system on 12 tasks and observe a 31% gain", item);
  check("轻微改写可容忍但不写入改写文本", partial.verified && item.summary.toLowerCase().includes(partial.quote.toLowerCase()), JSON.stringify(partial));
}

console.log("\n[7] 模型输出 JSON 抽取");
{
  check("裸 JSON", extractJSON('{"a":1}')?.a === 1);
  check("围栏 JSON", extractJSON('```json\n{"a":2}\n```')?.a === 2);
  check("带前后废话", extractJSON('好的，结果如下：{"a":3,"b":[1,2]} 以上。')?.a === 3);
  check("嵌套括号", extractJSON('{"a":{"b":"}"},"c":1}')?.a?.b === "}");
  check("非法输入返回 null", extractJSON("no json here") === null);
}


console.log("\n[8] 内容填充的退化处理与定向修复");
{
  const scoring = readJSON("config/scoring.json");
  const domains = readJSON("config/domains.json").domains;
  const mkScreened = (n) =>
    Array.from({ length: n }, (_, i) => ({
      id: `t${i}`,
      title: `Paper ${i}`,
      abstract: "We present a robot controller achieving dexterous manipulation on a real humanoid platform with measured success rates.",
      url: `https://example.com/${i}`,
      domain: "robotics",
      value: 0.4,
      displacement: 0.3,
      direction: "advance",
      confidence: 0.5,
      evidenceType: "preprint",
      sourceName: "test",
      date: "2026-09-28",
    }));

  /** 从提示词里抠出嵌入的条目数组（含 i 字段） */
  const promptItems = (user) => {
    const start = user.indexOf("[\n");
    let depth = 0;
    for (let k = start; k < user.length; k += 1) {
      if (user[k] === "[") depth += 1;
      else if (user[k] === "]") {
        depth -= 1;
        if (depth === 0) return JSON.parse(user.slice(start, k + 1));
      }
    }
    return [];
  };

  /** mode=drop 时主轮次漏返回条目；mode=blank 时漏掉 summary_zh */
  const fakeClient = (mode) => ({
    async chatJSON({ user }) {
      const items = promptItems(user);
      if (user.includes("中文摘要和关键词")) {
        // 用标题（全局唯一）而不是批次内下标来生成摘要，否则无法区分「归位对了」和「恰好下标相同」
        return { ok: true, data: { items: items.map((e) => ({ i: e.i, summary_zh: `${e.title} 的中文摘要。`, keywords: ["机器人"] })) } };
      }
      const rows = items
        .filter((e) => !(mode === "drop" && e.i % 3 === 0))
        .map((e) => ({
          i: e.i, value: 0.4, displacement: 0.3, direction: "advance", confidence: 0.5,
          domain: "robotics", evidence_type: "preprint", model: "X", keywords: [],
          evidence_quote: "", summary_zh: mode === "blank" ? "" : `${e.title} 的中文摘要。`, why_zh: "",
        }));
      return { ok: true, data: { items: rows } };
    },
  });

  const blank = await aiEnrich(fakeClient("blank"), mkScreened(12), { scoring, domains });
  check("漏摘要时不再回退成英文标题", blank.enriched.every((e) => e.summaryZh !== e.title), blank.enriched[0]?.summaryZh);
  check("定向修复补齐全部摘要", blank.enriched.every((e) => /[\u4e00-\u9fff]/.test(e.summaryZh)), JSON.stringify(blank.stats));
  // 修复调用按批进行，批次内下标会重复，所以必须验证摘要落在正确的条目上
  check(
    "摘要按条目归位（不串行）",
    blank.enriched.every((e) => e.summaryZh === `${e.title} 的中文摘要。`),
    blank.enriched.filter((e) => e.summaryZh !== `${e.title} 的中文摘要。`).map((e) => `${e.id}:${e.summaryZh}`).join(" "),
  );

  const drop = await aiEnrich(fakeClient("drop"), mkScreened(12), { scoring, domains });
  check("模型漏返回条目不丢条目", drop.enriched.length === 12, String(drop.enriched.length));
  check("漏返回条目也补上摘要", drop.enriched.every((e) => /[\u4e00-\u9fff]/.test(e.summaryZh)));
  check("漏返回条目降可信度", drop.enriched.filter((e) => e.enrichMissing).every((e) => e.confidence <= 0.5));
}

console.log("\n[9] 学术界 / 互联网频道归属");
{
  const domains = readJSON("config/domains.json").domains;
  const scoring = readJSON("config/scoring.json");
  // 归一化：AI 判定优先，其次来源先验，最后兜底
  check("AI 判定有效时采用 AI", resolveSector("internet", "academia") === "internet");
  check("AI 缺值时退回来源先验", resolveSector(null, "internet") === "internet");
  check("AI 给非法值时退回先验", resolveSector("creative", "internet") === "internet");
  check("都缺时兜底 academia", resolveSector(undefined, undefined) === "academia");
  check("大小写与空白被归一", resolveSector("  INTERNET ", null) === "internet");

  // 保底：按上限截断时不能把某一类整段切掉
  const many = [
    ...Array.from({ length: 90 }, (_, i) => ({ id: `a${i}`, sector: "academia", value: 0.9 - i * 0.001 })),
    ...Array.from({ length: 10 }, (_, i) => ({ id: `i${i}`, sector: "internet", value: 0.4 - i * 0.001 })),
  ];
  const picked = takeWithFloor(many, 40, { key: (x) => x.sector, want: "internet", share: 0.25 });
  check("截断后总数为上限", picked.length === 40, String(picked.length));
  check("截断后互联网不少于保底", picked.filter((x) => x.sector === "internet").length >= 10, String(picked.filter((x) => x.sector === "internet").length));
  check("未超上限时原样返回", takeWithFloor(many.slice(0, 5), 40).length === 5);

  // 初筛 → 事件：sector 必须原样贯穿，且只允许两个值
  const mkItem = (i, sectorHint) => ({
    id: `s${i}`, title: `Item ${i}`, url: `https://e.com/${i}`, canonicalUrl: `https://e.com/${i}`,
    summary: "x".repeat(200), sourceName: "S", sourceGroup: "media", sourceId: "s",
    published: "2026-09-28", itemDate: "2026-09-28", hintDomain: "software",
    sectorHint, value: 0.5, displacement: 0.3, direction: "advance", relevance: 0.9,
    evidenceType: "news_report", priority: 1,
  });
  const screenedIn = [mkItem(1, "internet"), mkItem(2, "academia"), mkItem(3, "internet")];
  const screenClient = {
    async chatJSON() {
      return { ok: true, data: { items: screenedIn.map((_, i) => ({
        i, keep: true, relevance: 0.9, domain: "software", value: 0.5, displacement: 0.3,
        direction: "advance", evidence_type: "news_report", evidence_basis: "none", ai_systems: [], reason: "ok",
      })) } };
    },
  };
  const scr = await aiScreen(screenClient, screenedIn, { domains, scoring });
  check("初筛按来源先验落 sector", scr.kept.filter((k) => k.sector === "internet").length === 2, JSON.stringify(scr.kept.map((k) => k.sector)));

  const evs = scr.kept.map((k) => toEvent(k, { scoring }));
  check("事件保留初筛的 sector", evs.filter((e) => e.sector === "internet").length === 2, JSON.stringify(evs.map((e) => e.sector)));
  check("sector 只有两个合法值", evs.every((e) => e.sector === "academia" || e.sector === "internet"));

  // 填充阶段不得覆盖初筛结论（曾因两个阶段各判一次，工业界被整段改回 academia）
  const enrichClient = {
    async chatJSON() {
      return { ok: true, data: { items: screenedIn.map((_, i) => ({
        i, summary_zh: "中文摘要内容。", keywords: ["k"], why_zh: "理由", evidence_quote: "",
        evidence_type: "news_report", model: "M", domain: "software", value: 0.5,
        displacement: 0.3, direction: "advance", confidence: 0.6, evidence_basis: "none",
        sector: "academia", // 模型即使硬塞一个相反的 sector，也必须被忽略
      })) } };
    },
  };
  const enr = await aiEnrich(enrichClient, scr.kept, { scoring, domains });
  check("填充不覆盖初筛的 sector", enr.enriched.filter((e) => e.sector === "internet").length === 2, JSON.stringify(enr.enriched.map((e) => e.sector)));

  // 「直接替代」vs「具备替代潜力」：间接条目不参与指数
  // 学术界通过严格口径即视为直接替代；互联网未表态时保守判为间接
  check("学术界一律 direct", scr.kept.filter((k) => k.sector === "academia").every((k) => k.relation === "direct"));
  check("互联网未表态时判为 indirect", scr.kept.filter((k) => k.sector === "internet").every((k) => k.relation === "indirect"), JSON.stringify(scr.kept.map((k) => k.relation)));
  const relIn = [mkItem(1, "internet"), mkItem(2, "internet")];
  const relCli = { async chatJSON() { return { ok: true, data: { items: relIn.map((_, i) => ({
    i, keep: true, relevance: 0.9, domain: "software", value: 0.5, displacement: 0.3, direction: "advance",
    evidence_type: "news_report", evidence_basis: "none", ai_systems: [], reason: "ok",
    relation: i === 0 ? "direct" : "whatever" })) } }; } };
  const relScr = await aiScreen(relCli, relIn, { domains, scoring });
  check("互联网频道采纳 AI 的 direct", relScr.kept.find((k) => k.id === "s1")?.relation === "direct");
  check("互联网频道非法值回落 indirect", relScr.kept.find((k) => k.id === "s2")?.relation === "indirect");

  // 自述型来源：README 里写「已被第三方复现」不能自证第三方复现。
  // 但封顶压的是**分值**，不是证据类型——改写类型会让展示层说出与原文相反的话：
  // 一条引文写着「已被弗吉尼亚理工独立复现」的条目曾被标成「厂商自述」。
  const ceilIn = [{ ...mkItem(9, "internet"), evidenceCeiling: "vendor_claim" }, mkItem(10, "academia")];
  const ceilCli = { async chatJSON() { return { ok: true, data: { items: ceilIn.map((_, i) => ({
    i, keep: true, relevance: 0.9, domain: "software", value: 0.5, displacement: 0.3, direction: "advance",
    evidence_type: "third_party_reproduced", evidence_basis: "README 自称已被复现", ai_systems: [], reason: "ok" })) } }; } };
  const ceilScr = await aiScreen(ceilCli, ceilIn, { domains, scoring });
  check(
    "初筛保留证据类型原判（不改写）",
    ceilScr.kept.find((k) => k.id === "s9")?.evidenceType === "third_party_reproduced",
    ceilScr.kept.find((k) => k.id === "s9")?.evidenceType,
  );
  check("非自述型来源不受封顶影响", ceilScr.kept.find((k) => k.id === "s10")?.evidenceType === "third_party_reproduced");

  // 封顶必须在填充阶段再执行一次：只加在初筛会被填充覆盖（实测 GitHub Trending 冲到 0.92）
  const ceilEnrCli = { async chatJSON() { return { ok: true, data: { items: ceilIn.map((_, i) => ({
    i, summary_zh: "中文摘要。", keywords: ["k"], why_zh: "理由", evidence_quote: "",
    evidence_type: "third_party_reproduced", model: "M", domain: "software", value: 0.92,
    displacement: 0.3, direction: "advance", confidence: 0.9, evidence_basis: "README 自称已被复现" })) } }; } };
  const ceilEnr = await aiEnrich(ceilEnrCli, ceilScr.kept, { scoring, domains });
  const selfDesc = ceilEnr.enriched.find((e) => e.evidenceCeiling === "vendor_claim");
  check(
    "填充保留证据类型原判（改写会让界面说反话）",
    selfDesc?.evidenceType === "third_party_reproduced",
    selfDesc?.evidenceType,
  );
  // 但分值必须仍然被压住，否则「自荐渠道冲到 0.92」的老问题会回来
  check(
    "自荐渠道的分值仍被封顶压住",
    Number(selfDesc?.value) <= (scoring.valueCaps.caps.vendor_claim ?? 1),
    `value=${selfDesc?.value} 上限=${scoring.valueCaps.caps.vendor_claim}`,
  );
  check("封顶后价值被压到上限内", selfDesc?.value <= (scoring.valueCaps.caps.vendor_claim ?? 1), String(selfDesc?.value));
  check("间接条目贡献为 0", contributionOf({ relation: "indirect", direction: "advance", value: 0.9, confidence: 0.9 }) === 0);
  check("直接条目按 方向×价值×可信度 贡献", Math.abs(contributionOf({ relation: "direct", direction: "advance", value: 0.6, confidence: 0.5 }) - 0.3) < 1e-9);
  check("直接的负向条目贡献为负", contributionOf({ relation: "direct", direction: "setback", value: 0.6, confidence: 0.5 }) < 0);

  // 混合语料下，指数仍然自洽：间接条目不进累加，直接条目可加
  const mix = [
    { id: "d1", date: "2026-09-28", domain: "math", direction: "advance", relation: "direct", value: 0.6, confidence: 0.5, source_id: "a" },
    { id: "i1", date: "2026-09-28", domain: "math", direction: "advance", relation: "indirect", value: 0.9, confidence: 0.9, source_id: "b" },
    { id: "d2", date: "2026-09-28", domain: "math", direction: "advance", relation: "direct", value: 0.4, confidence: 0.5, source_id: "c" },
  ];
  // computeIndex 就地写回 delta / index_contribution，所以传副本、查副本
  const mixCopy = mix.map((e) => ({ ...e }));
  const mi = computeIndex(mixCopy, { domains, epoch: "2026-09-28" });
  const ind = mixCopy.find((e) => e.id === "i1");
  check("间接条目落盘 delta 为 0", ind.delta === 0, String(ind.delta));
  check("间接条目 index_contribution 为 0", ind.index_contribution === 0, String(ind.index_contribution));
  check("加入间接条目不改变指数", Math.abs(mi.domains.find((d) => d.domain === "math").delta - (() => {
    const only = [
      { id: "d1", date: "2026-09-28", domain: "math", direction: "advance", relation: "direct", value: 0.6, confidence: 0.5, source_id: "a" },
      { id: "d2", date: "2026-09-28", domain: "math", direction: "advance", relation: "direct", value: 0.4, confidence: 0.5, source_id: "c" },
    ];
    return computeIndex(only, { domains, epoch: "2026-09-28" }).domains.find((d) => d.domain === "math").delta;
  })()) < 1e-9);
  const mv = verifyIndex(mixCopy, { domains });
  check("混合语料仍通过一致性校验", mv.ok, JSON.stringify(mv.failures?.slice(0, 2)));
}


  // ---------- [10] 高亮标记的样式覆盖 ----------
  // 这类 bug 已经犯过两次：.bar 重名、.title .hl-ent 作用域太窄。
  // 共同点是「CSS 写对了但没命中」——渲染出来的 HTML 完全正常，只有肉眼看才发现。
  // 所以这里反过来验证：把页面里真实出现的 mark 祖先类名抓出来，逐个回到 CSS 里查有没有规则命中。
  {
    const { readFileSync, readdirSync, existsSync } = await import("node:fs");
    const css = readFileSync(new URL("../theme/style.css", import.meta.url), "utf8");

    // 收集 CSS 里所有以 mark / .hl-ent / .hl-con 结尾或包含它们的选择器
    const selectors = css
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("}")
      .map((block) => block.split("{")[0].trim())
      .filter((sel) => sel && !sel.startsWith("@"))
      .flatMap((sel) => sel.split(",").map((x) => x.trim()))
      .filter((sel) => /(^|\s)(mark|\.hl-ent|\.hl-con)(\s|$|:|\[)/.test(sel));

    const isGlobal = (sel) => /^(mark|\.hl-ent|\.hl-con)(:|\[|\s*$)/.test(sel);

    check("高亮选择器没有被祖先限定", selectors.some(isGlobal), `实得：${selectors.join(" | ")}`);
    check("mark 浏览器默认黄底被重置", selectors.some((x) => /^mark\s*$/.test(x) || /^mark\s*:/.test(x)));

    // 渲染产物里出现的 mark 类名必须都被覆盖，且不带别的类名
    const siteDir = new URL("../site/", import.meta.url);
    if (existsSync(siteDir)) {
      const pages = readdirSync(siteDir, { recursive: true }).filter((f) => String(f).endsWith(".html"));
      const used = new Set();
      for (const f of pages) {
        const html = readFileSync(new URL(String(f).replace(/\\/g, "/"), siteDir), "utf8");
        for (const m of html.matchAll(/<mark class="([^"]*)"/g)) used.add(m[1]);
      }
      check("页面只产出 hl-ent / hl-con 两种标记", [...used].every((c) => c === "hl-ent" || c === "hl-con"), [...used].join(","));
      check("两种标记都有全局规则", selectors.some(isGlobal) && used.size > 0, `页面用到 ${used.size} 种`);
    }
  }

  // ---------- [11] 详情默认收起，控制行留在详情外 ----------
  {
    const { readFileSync, readdirSync, existsSync } = await import("node:fs");
    const siteDir = new URL("../site/", import.meta.url);
    if (existsSync(siteDir)) {
      const pages = readdirSync(siteDir, { recursive: true })
        .map((f) => String(f).replace(/\\/g, "/"))
        .filter((f) => f.endsWith(".html"));
      let records = 0, hidden = 0, controls = 0, stray = 0;
      for (const f of pages) {
        const html = readFileSync(new URL(f, siteDir), "utf8");
        const rows = (html.match(/<article class="story[^>]*data-v2-record/g) ?? []).length;
        const panels = (html.match(/<section id="v2-details-[^"]+" class="v2-details"[^>]*>/g) ?? []);
        records += rows;
        hidden += panels.filter((x) => /\shidden(?:\s|>)/.test(x)).length;
        controls += (html.match(/class="v2-read-toggle"/g) ?? []).length;
        stray += (html.match(/has-js/g) ?? []).length;
      }
      check("记录头部与摘要控制行保留在详情内容之外", records > 0 && controls === records, `记录 ${records} / 控制 ${controls}`);
      check("详情默认收起", hidden === records, `收起 ${hidden} / 记录 ${records}`);
      check("已清除 has-js 那套开关", stray === 0, `残留 ${stray} 处`);
    }
  }

  // ---------- [11b] CSS 里不该有渲染产物中不存在的类 ----------
  // 这条是三次同类 bug 的通用防线：改了 HTML 的类名，却漏改了 CSS（尤其是 @media 里的覆写）。
  // 症状全都极其隐蔽——CSS 语法正确、HTML 也正确，只是规则不再命中，只有肉眼看才发现。
  // 反向检查：把 CSS 里出现的每个类名拿去渲染产物里找，找不到就说明是残留。
  {
    const { readFileSync, readdirSync, existsSync } = await import("node:fs");
    const siteDir = new URL("../site/", import.meta.url);
    if (existsSync(siteDir)) {
      const css = readFileSync(new URL("../theme/style.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      // 注意：不能用 split("}") 取选择器——@media 内的规则会被切碎而整个漏掉，
      // 「.row .conf-high 丢了」就是这么漏过去的。改成按花括号深度逐字符收集选择器。
      const inCss = new Set();
      let depth = 0, buf = "";
      for (const ch of css) {
        if (ch === "{") {
          for (const c of buf.matchAll(/\.([a-zA-Z][\w-]*)/g)) inCss.add(c[1]);
          buf = ""; depth += 1;
        } else if (ch === "}") { buf = ""; depth -= 1; }
        else buf += ch;
      }
      const inHtml = new Set();
      for (const f of readdirSync(siteDir, { recursive: true }).map((x) => String(x).replace(/\\/g, "/"))) {
        if (!f.endsWith(".html")) continue;
        for (const m of readFileSync(new URL(f, siteDir), "utf8").matchAll(/class="([^"]*)"/g)) {
          for (const c of m[1].split(/\s+/)) if (c) inHtml.add(c);
        }
      }
      // 这些类由筛选交互或特定语料状态触发，静态初始 HTML 中可能不存在
      const CONDITIONAL = new Set(["flag", "flag-low", "flag-high", "flag-offtopic", "flag-irrelevant", "empty", "empty-state", "count", "sechead", "tag-first", "tag-warn", "tag-ok", "tag-pot", "has-filter", "is-saved", "neg", "pos", "zero"]);
      const stale = [...inCss].filter((c) => !inHtml.has(c) && !CONDITIONAL.has(c)).sort();
      check("CSS 没有渲染产物中不存在的类", stale.length === 0, stale.length ? `残留：${stale.join(", ")}` : "");

      // 反方向：HTML 用到的类必须在 CSS 里有定义。漏定义比残留更严重——
      // 「高可信/低可信」的徽标样式曾被误删，页面上退化成一串没有底色的普通文字。
      const undefinedCls = [...inHtml].filter((c) => !inCss.has(c)).sort();
      check("HTML 用到的类都在 CSS 里有定义", undefinedCls.length === 0, undefinedCls.length ? `缺失：${undefinedCls.join(", ")}` : "");
    }
  }

  // ---------- [11c] CSS 里不该有同选择器的顶层重复 ----------
  // 这是本轮踩的坑：改布局时把新规则插在前面，旧的 flex 规则留在文件后面，
  // 同选择器、同特异性，后面的赢——grid 布局被静默覆盖成 flex，页面上完全看不出原因。
  // 顶层出现两次同一选择器就是可疑信号（@media 里的覆写是合法的，所以只查顶层）。
  {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(new URL("../theme/style.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

    // 只收集顶层规则：用一个深度计数跳过 @media 内部
    const seen = new Map();
    let depth = 0;
    let buf = "";
    for (const ch of css) {
      if (depth === 0) {
        if (ch === "{") {
          // buf 是选择器（可能以 @media 开头）
          const sel = buf.trim();
          // 只看「单独成条」的选择器：`th, td {}` 和 `th {}` 同时存在是正常的，
          // 真正可疑的是同一条选择器被整条定义了两次——后面的会静默覆盖前面的。
          if (sel && !sel.startsWith("@")) {
            const parts = sel.split(",").map((x) => x.trim()).filter(Boolean);
            if (parts.length === 1) seen.set(parts[0], (seen.get(parts[0]) ?? 0) + 1);
          }
          buf = "";
          depth += 1;
        } else if (ch === "}") {
          buf = "";
        } else {
          buf += ch;
        }
      } else if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
    }
    const dupes = [...seen].filter(([, n]) => n > 1).map(([k, n]) => `${k}×${n}`).sort();
    check("CSS 顶层没有重复选择器", dupes.length === 0, dupes.length ? `重复：${dupes.join(", ")}` : "");
  }

  // ---------- [12] CSS 花括号平衡 ----------
  // 上一轮用脚本替换 CSS 区块时算错了结束位置，留下一个多余的 }（175 开 / 176 闭）。
  // 浏览器会丢弃顶层多余的 }，症状因此很隐蔽——所以直接守住这条不变量。
  {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(new URL("../theme/style.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const open = (css.match(/\{/g) ?? []).length;
    const close = (css.match(/\}/g) ?? []).length;
    check("CSS 花括号平衡", open === close, `${open} 开 / ${close} 闭`);
    let depth = 0, stray = 0;
    for (const ch of css) {
      if (ch === "{") depth += 1;
      else if (ch === "}") { depth -= 1; if (depth < 0) { stray += 1; depth = 0; } }
    }
    check("CSS 没有多余的顶层 }", stray === 0, `多余 ${stray} 个`);
    check("CSS 没有未闭合的块", depth === 0, `结束时深度 ${depth}`);
  }

  // ---------- [13] 编辑式页面交互契约 ----------
  {
    const { readFileSync } = await import("node:fs");
    const app = readFileSync(new URL("../theme/app.js", import.meta.url), "utf8");
    check("搜索、领域、证据和强度条件都会重新筛选", app.includes("state.query =") && app.includes("state.domain =") && app.includes("state.verified =") && app.includes("state.min ="));
    check("排序支持强度、日期和可信度", app.includes("localeCompare(a.dataset.date)") && app.includes("state.sort") && app.includes("confidence"));
    check("展开只切换详情区并保持控制按钮", app.includes("panel.hidden = !open") && app.includes("data-toggle-label") && !app.includes("innerHTML"));
    check("标题和原文链接不被记录展开事件接管", app.includes('target.closest("a")'));
    check("稍后读保存在浏览器本地", app.includes("localStorage.getItem(savedKey)") && app.includes("localStorage.setItem(savedKey"));
  }

console.log("\n[14] 正式编辑式 UI 与站内路由");
{
  const { readFileSync, readdirSync, existsSync } = await import("node:fs");
  const readSite = (relative) => readFileSync(new URL(`../site/${relative}`, import.meta.url), "utf8");
  const home = readSite("index.html");
  const academic = readSite("academia.html");
  const archive = readSite("archive.html");
  const dayName = readdirSync(new URL("../site/day/", import.meta.url)).find((name) => name.endsWith(".html"));
  const day = readSite(`day/${dayName}`);
  const domain = readSite("domain/software.html");
  const style = readSite("assets/style.css");
  const app = readSite("assets/app.js");

  check("频道页采用已确认的编辑式页面骨架", /class="editorial-theme editorial-v2"/.test(home) && /class="edition-content"/.test(home));
  check("右栏使用已确认的说明文案", home.includes("AI 承担人类任务的进展") && home.includes("按领域整理互联网与学术界的相关事件。展开记录可查看摘要、原文证据、推进强度和证据可信度。"));
  check("折叠记录保留标题外链与固定摘要控制行", /class="v2-title-link"[^>]+target="_blank"/.test(home) && /class="v2-story-baseline"/.test(home) && /data-action="expand"/.test(home));
  check("详情默认折叠且包含摘要、关注理由和原文证据", /class="v2-details"[^>]*hidden/.test(home) && home.includes("事件摘要") && home.includes("为什么值得关注") && home.includes("原文证据"));
  check("详情提供原文入口和评分字段", home.includes("阅读原文") && home.includes("证据可信度") && home.includes("证据类型"));
  check("编辑式排序、搜索、领域筛选与稍后读控件已生成", home.includes("sort-menu") && home.includes("id=\"search\"") && home.includes("data-domain-filter") && home.includes("data-action=\"saved-list\""));
  check("互联网和学术界导航保持正式静态路由", home.includes('href="index.html"') && home.includes('href="academia.html"') && academic.includes('href="index.html"') && academic.includes('href="academia.html"'));
  check("日期归档继续链接到正式日期页", dayName && archive.includes(`href="day/${dayName.replace(".html", ".html")}"`) && existsSync(new URL(`../site/day/${dayName}`, import.meta.url)));
  check("日期页保留归档与相邻日期导航", /href="\.\.\/archive\.html"/.test(day) && /class="date-navigation"/.test(day));
  check("领域页保留正式路由且具备相同阅读布局", domain.includes('href="../index.html"') && domain.includes('href="../academia.html"') && domain.includes("editorial-v2"));
  check("暖纸色样式与交互脚本已复制到正式站点资源", /--bg:\s*#f7f4ed/i.test(style) && app.includes("data-action") && app.includes("localStorage"));
}

console.log("\n[15] 报告与复核计算");
{
  const events = [
    { id: "a", title: "A", value: 0.8, confidence: 0.7, evidence_type: "official", evidence_verified: true, domain: "software" },
    { id: "b", title: "B", value: 0.4, confidence: 0.5, evidence_type: "preprint", evidence_verified: false, domain: "math" },
  ];
  const distribution = valueDistribution(events);
  check("评分分布字段和顺序保持一致", distribution.count === 2 && distribution.medianValue === 0.4 && distribution.highValueShare === 0.5 && distribution.evidenceTypes.official === 1 && distribution.unverifiedQuotes === 1);
  check("分布告警阈值保持一致", !checkCalibration(distribution, { expectedHighValueShare: 0.2 }).ok);

  const audit = compareAudit(events, [
    { id: "a", value: 0.5, domain: "software", verdict: "over_scored", reason: "评分偏高" },
    { id: "b", value: 0.4, domain: "physics", verdict: "agree", reason: "领域不同" },
  ], { calibration: { expectedMedianValue: [0.3, 0.55] } });
  check("复核差值及领域判定保持一致", audit.rows[0].diff === -0.3 && audit.rows[1].verdict === "misclassified");
  check("复核汇总字段保持一致", audit.summary.compared === 2 && audit.summary.overScored === 1 && audit.summary.domainMismatch === 1 && audit.summary.agreeRate === 0);
}

// ---------- [16] 数据源配置不变量 ----------
console.log("\n[16] 数据源配置不变量");
// config/sources.json 于 2026-10-04 按根目录 ai.opml 全量重构过一次。这里的字段直接决定
// 采集、候选配额与互联网频道保底；写错不会抛错，只会静默少收或偏科，所以守住不变量。
{
  const { readFileSync } = await import("node:fs");
  const sourcesConfig = readJSON(new URL("../config/sources.json", import.meta.url), {});
  const domainsConfig = readJSON(new URL("../config/domains.json", import.meta.url), {});
  const collectSource = readFileSync(new URL("./lib/collect.mjs", import.meta.url), "utf8");
  const sources = sourcesConfig.sources ?? [];

  // group 必须落在 screen.mjs 的 groupBonus 词表内，否则该源拿不到任何分组权重。
  const GROUPS = new Set(["research", "ai-lab", "community", "media", "journal", "practitioner", "benchmark", "newsletter", "engineering", "policy", "company", "labor", "realtime"]);
  const DOMAINS = new Set((domainsConfig.domains ?? []).map((d) => d.key));
  const KINDS = new Set(["rss", "json"]);
  const uniq = (list) => [...new Set(list)].join(",");

  check("数据源非空", sources.length > 0, String(sources.length));
  const ids = sources.map((s) => s.id);
  check("数据源 id 唯一", new Set(ids).size === ids.length, uniq(ids.filter((x, i) => ids.indexOf(x) !== i)));
  check("数据源 id 为 kebab-case", ids.every((id) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)), uniq(ids.filter((id) => !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id))));
  const urls = sources.map((s) => s.url);
  check("数据源 URL 唯一", new Set(urls).size === urls.length, uniq(urls.filter((x, i) => urls.indexOf(x) !== i)));
  check("数据源 URL 均为 https", urls.every((u) => u.startsWith("https://")), uniq(urls.filter((u) => !u.startsWith("https://"))));
  check("数据源 name 非空", sources.every((s) => (s.name ?? "").trim().length > 0));
  check("数据源 group 在权重词表内", sources.every((s) => GROUPS.has(s.group)), uniq(sources.filter((s) => !GROUPS.has(s.group)).map((s) => s.group)));
  check("数据源 kind 合法", sources.every((s) => KINDS.has(s.kind)), uniq(sources.filter((s) => !KINDS.has(s.kind)).map((s) => s.kind)));
  check("数据源 hintDomain 落在 domains.json", sources.every((s) => DOMAINS.has(s.hintDomain)), uniq(sources.filter((s) => !DOMAINS.has(s.hintDomain)).map((s) => s.hintDomain)));
  // sector 决定互联网频道的保底名额：字段缺省会被当成 academia，所以必须显式声明。
  check("数据源 sector 显式且合法", sources.every((s) => s.sector === "academia" || s.sector === "internet"), uniq(sources.filter((s) => s.sector !== "academia" && s.sector !== "internet").map((s) => s.id)));
  check("数据源 maxItems 为正整数", sources.every((s) => Number.isInteger(s.maxItems) && s.maxItems > 0), uniq(sources.filter((s) => !(Number.isInteger(s.maxItems) && s.maxItems > 0)).map((s) => s.id)));
  // JSON 源没有通用解析器，id 必须出现在 collect.mjs 的 JSON_SOURCE_MAPPERS 里，否则解析结果恒为空。
  const jsonSources = sources.filter((s) => s.kind === "json");
  check("JSON 源都有对应的解析映射", jsonSources.every((s) => collectSource.includes(`"${s.id}"`)), uniq(jsonSources.filter((s) => !collectSource.includes(`"${s.id}"`)).map((s) => s.id)));
}

console.log("\n[17] AI 传输层只依赖 OpenAI 兼容端点");
// 移除 bl CLI 兜底后，传输层只剩「直连 OpenAI 兼容端点」。关键不变量是：
// 没有凭据时构造 AIClient 不能抛错（否则 `npm run render` 这类不调用 AI 的路径
// 在没有 .env 的机器上会连带失效），但真正发起调用必须给出可操作的错误。
{
  const providers = await import("./lib/providers.mjs");
  const CRED_KEYS = ["AI_API_KEY", "OPENAI_API_KEY", "DASHSCOPE_API_KEY", "api_key", "OPENAI_KEY", "LLM_API_KEY", "AI_BASE_URL", "OPENAI_BASE_URL", "base_url", "OPENAI_API_BASE", "LLM_BASE_URL"];
  const saved = new Map(CRED_KEYS.map((k) => [k, process.env[k]]));
  for (const k of CRED_KEYS) delete process.env[k];
  try {
    // 指向一个不存在的目录，确保不会读到仓库根真实存在的 .env
    const root = new URL("../__selftest_no_such_dir__", import.meta.url).pathname;
    const resolved = providers.resolveProvider({ root });
    check("无凭据时构造传输层不抛错", resolved.info.provider === "none", resolved.info.provider);
    const res = await resolved.provider.chat({ model: "m" });
    check("无凭据调用时给出可操作的错误", res.ok === false && res.error.includes("AI_API_KEY") && res.error.includes("AI_BASE_URL"), res.error);
    check("不再导出 bl 传输", providers.BlProvider === undefined);
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

console.log("\n[18] 模型名可由环境变量覆盖");
// 模型名决定能对接哪个厂商的端点（DeepSeek 不认 qwen-flash）。这里守住覆盖优先级：
// 阶段专属变量 > 全局变量 > config/scoring.json 的原值。
{
  const providers = await import("./lib/providers.mjs");
  const KEYS = ["AI_MODEL_NAME", "AI_MODEL", "model_name", "AI_MODEL_SCREENING", "model_screening", "AI_MODEL_MERGER", "model_merger", "AI_MODEL_ENRICHMENT", "model_enrichment", "AI_MODEL_SUMMARIZER", "model_summarizer", "AI_MODEL_AUDIT", "model_audit"];
  const saved = new Map(KEYS.map((k) => [k, process.env[k]]));
  const clearModels = () => KEYS.forEach((k) => delete process.env[k]);
  try {
    // 指向不存在的目录，确保不会读到仓库根真实存在的 .env
    const root = new URL("../__selftest_no_such_dir__", import.meta.url).pathname;
    const base = { screening: "qwen-flash", enrichment: "qwen-plus", merger: "qwen-flash", $comment: "x" };

    clearModels();
    const untouched = providers.applyModelOverrides(base, { root });
    check("无环境变量时保留 config 原值", untouched.screening === "qwen-flash" && untouched.enrichment === "qwen-plus" && untouched.merger === "qwen-flash", JSON.stringify(untouched));
    check("覆盖时不改动 $comment 之类的非阶段键", untouched.$comment === "x");

    process.env.AI_MODEL_NAME = "deepseek-flash";
    const global = providers.applyModelOverrides(base, { root });
    check("AI_MODEL_NAME 覆盖全部阶段", global.screening === "deepseek-flash" && global.merger === "deepseek-flash" && global.enrichment === "deepseek-flash", JSON.stringify(global));

    process.env.AI_MODEL_ENRICHMENT = "deepseek-v4-pro";
    const staged = providers.applyModelOverrides(base, { root });
    check("阶段专属变量优先于全局变量", staged.enrichment === "deepseek-v4-pro" && staged.screening === "deepseek-flash", JSON.stringify(staged));

    check("全局变量同样作用于 audit 阶段", providers.resolveModelName("audit", { root, fallback: "fb" }) === "deepseek-flash");
    process.env.AI_MODEL_AUDIT = "audit-only";
    check("AI_MODEL_AUDIT 可单独覆盖 audit", providers.resolveModelName("audit", { root, fallback: "fb" }) === "audit-only");
    check("未配置任何变量时回落到 fallback", (clearModels(), providers.resolveModelName("screening", { root, fallback: "fb" })) === "fb");
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
if (fail > 0) process.exitCode = 1;
