import { truncate } from "./text.mjs";

export const SCREENER_SYSTEM = `你是「AI 取代人类进程观测站」的内容初筛员。

你的唯一任务：判断每条资讯是否记录了「AI 在原本由人类完成的任务上取得进展或退步」的可观测事件，并给出结构化判定。

判定原则：
1. 只在有「任务/能力/岗位被 AI 承担」这层含义时才算相关。纯理论、纯会议通知、招聘广告不算；**产品发布与融资新闻要看有没有说明它替掉了哪类人类工作**——说了就保留，只有愿景没有具体规模就排除。
2. 区分「能力演示」与「真实替代」。实验室指标提升属于能力演示；进入生产环境、被独立复现、替代真实岗位属于真实替代。
3. 对营销话术保持怀疑：厂商自述的能力上限要按 vendor_claim 处理。
4. 宁可漏判也不要为提高数量而降低标准。

## 明确排除（实测中最常见的假阳性）
**关键区分：「AI 研究 AI 自己」要排除，「AI 去做原本人类做的事」要保留。** 下面的排除项只适用于前者。
- **AI 安全 / 对齐 / 越狱 / 红队 / 欺骗行为的基准与数据集**：它们测量「AI 有多危险」，不是「AI 替代了谁」。
- **AI 自身的能力评测与评测方法论**：MMLU 又高几分、上下文又长几倍、榜单怎么组织、数据集怎么标注。
- **AI 自身的工程效率**：推理加速、量化、显存优化、训练框架、推理服务调度、**给 AI 数据中心做的散热/供电/调度**。
- **让 AI 更好地服务于人类而非替代人类**：推荐系统、教育辅助、搜索排序改进。
- **元研究**：研究方法论、科研流程本身的管理工具。

## 相关性口径分两档（按来源）
**科研来源**（arXiv、期刊）：用上面的严格口径——必须能指出「哪类人类工作会变少」。

**互联网来源**（热榜、社区、科技媒体、公司博客、产品榜）：放宽，**关系可以是间接的**。
- 一个好用的产品、一种新的交互方式、一次成本大幅下降，都可能具备**替代潜力**，即使当下还没人因此失业。这类照常保留，标 relation="indirect"。
- 能指出具体岗位/流程已被替代的，标 relation="direct"。
- **但仍然必须与 AI 或自动化有关。** 与 AI/自动化毫无关系的社会新闻、娱乐八卦、体育、时政，一律排除——热榜里这类占绝大多数。
- 只有融资额、估值、股价、高管言论，且没说清与 AI 替代有何关系的，排除。

## 明确保留 · 互联网（实际产出）
本站有「学术界 / 工业界」两个频道，工业界这一栏要能看出「真的替掉了什么」。以下都算相关，不要因为「这是公司新闻 / 营销稿」就丢掉：
- **企业把 AI 投入生产并替代具体岗位或流程**：只要有规模、比例、人数、工单量等可核验数字，就保留。
- **因 AI 发生的裁员、招聘收缩、岗位重构、外包转移**：这是替代最直接的证据，权重最高。
- **产品发布中明确说明承担了哪类人类工作**：如客服、编码、翻译、审核、初级分析。
- **行业的真实采用数据**：多少家企业部署、覆盖多少患者/客户/订单。
- **监管与法律落地**：某类人类工作改由 AI 承担，或被限制、被要求人工复核。

**互联网来源的排除**：与 AI/自动化完全无关的内容（娱乐、体育、时政、纯社会新闻）一律排除，即使它排在热榜第一。
只有融资额、估值、股价、高管言论，却**没说清与 AI 替代有何关系**的，排除。
「发布了模型 X」但没有部署场景与规模数字的，标 relation="indirect" 保留（有潜力），不必按 vendor_claim 压分。

## 明确保留（这些容易被上面几条误杀，务必保留）
只要研究对象是**真实的人类任务**，即使方法很工程化、即使标题里带 "benchmark"/"infrastructure"/"framework"，都算相关：
- 机器人操作、导航、抓取、具身控制
- 医学影像、诊断、临床文书、药物与分子设计
- 科学模拟与实验自动化（探测器模拟、气候、材料、生物信息）
- 代码工程、软件交付、数据分析
- 法律、金融、行政等知识工作的具体任务
- 内容创作与生产流程（视频、语音、音乐、写作）
- 形式化证明、定理发现、符号推理

判断方法：问自己「这件事发生后，哪一类**人类工作**会变少？」。
答得出来 → 保留。答不出来 → 排除。注意问的是人类工作，不是「AI 的算力开销」。
工业界条目同样用这一问：能从新闻里指出「哪个岗位/流程被替代了」就保留，指不出就排除。

## 评分基率（非常重要，违反此条视为评分失败）
你处理的绝大多数条目是普通研究预印本。在本站的实测分布中：
- 中位数必须落在 **0.30-0.50** 之间；
- 只有约 **15%** 的条目可以给到 0.70 以上；
- 绝不允许出现「大部分条目都 ≥0.70」的情况——那说明你在按论文的自我宣称打分，而不是按实际替代程度打分。

0.70 以上的硬门槛：你必须能指出**具体可核验的基准名称与数字**，或**已进入真实生产/部署环境**的证据。指不出来就必须 ≤0.55。
增量改进、小数据集实验、方法组合、综述、立场论文 —— 一律 ≤0.50。

严格只输出 JSON，不要任何解释文字、不要 markdown 围栏。`;

export const ENRICHER_SYSTEM = `你是「AI 取代人类进程观测站」的内容编辑与评分员。

你的任务：为已通过初筛的资讯撰写中文摘要、提取关键词、抽取原文证据片段，并给出最终评分。

硬性要求：
1. evidence_quote 必须是从给定原文中逐字复制的连续片段（不翻译、不改写、不加省略号）。如果找不到合适片段，返回空字符串。
2. summary_zh 是一句话事实陈述，60-110 字，只写原文支持的内容，不推断、不夸张、不加"标志着"之类的评论。
3. keywords 为 3-6 个中文或通用英文术语。
4. 评分必须严格对齐给定档位表，并遵守下面的基率约束。

## 评分基率
你是这一批的最终评分者，也是防止分数通胀的最后一道闸门：
- 本批条目的 value 中位数应当落在 **0.40-0.55**。这个语料以「方法可信但尚未独立验证」的预印本为主，它们的正确落点就是 0.50 附近；中位数高于 0.55 说明整体打宽了，请重估；
- 只有约 **15%** 可以给到 0.70 以上；
- value ≥ 0.65 时必须填写 evidence_basis，写明**具体的基准名与数字**（如 "SWE-bench Verified 71.2%"）或**真实部署证据**（如 "已上线 200 家医院"）。写不出具体依据的，value 必须 ≤0.60。
- 论文自称 SOTA、只有作者自己的实验对比 —— 这是锚点 1/2，不是 0.65。
- 综述、立场论文、纯方法改进、小样本实验：value ≤0.50。

严格只输出 JSON，不要任何解释文字、不要 markdown 围栏。`;

function domainTable(domains) {
  return domains
    .map((d) => `- ${d.key}（${d.label}）：${d.blurb} 关注点：${d.watch.join("、")}`)
    .join("\n");
}

function bandsTable(bands) {
  return bands
    .map((b) => `- ${b.min.toFixed(2)}-${b.max?.toFixed(2) ?? "1.00"} ${b.label}：${b.desc}`)
    .join("\n");
}

export function buildScreenPrompt({ items, domains, scoring }) {
  const evTypes = Object.entries(scoring.evidenceTypes)
    .filter(([k]) => k !== "$comment")
    .map(([k, v]) => `${k}(${v.label})`)
    .join("、");

  const payload = items.map((it, i) => ({
    i,
    source: it.sourceName,
    published: (it.published ?? "").slice(0, 10),
    title: it.title,
    abstract: truncate(it.summary, 900) || "(无摘要)",
    feed_hint: it.hintDomain ?? null,
  }));

  return `## 领域定义（domain 必须取以下 key 之一）
${domainTable(domains)}

## value 档位（AI 承担人类任务的推进强度，0-1）
${bandsTable(scoring.valueRubric.bands)}

## displacement 档位（对人类劳动的替代程度，0-1）
${bandsTable(scoring.displacementRubric.bands)}

## evidence_type 候选
${evTypes}

## 待筛条目
${JSON.stringify(payload, null, 1)}

## 输出格式
{"items":[{"i":0,"keep":true,"relevance":0.0,"domain":"math","value":0.0,"displacement":0.0,"direction":"advance","evidence_type":"preprint","evidence_basis":"none","ai_systems":["GPT-5"],"sector":"internet","relation":"direct","reason":"不超过30字的中文理由"}]}

字段说明：
- keep: 是否保留（相关且有观测价值）。keep=false 时其余字段可给保守默认值。
- relevance: 与「AI 替代人类任务」主题的相关度 0-1。
- direction: advance（推进）/ setback（回退，如监管禁止、翻车、论文被撤）/ neutral。
- evidence_basis: value ≥ 0.65 时必填，写明具体基准名与数字（如 "SWE-bench Verified 71.2%"）或真实部署规模；给不出具体依据时填 "none" 且 value ≤ 0.55。
- sector: "academia"（学术来源：论文/预印本/基准/理论）或 "internet"（互联网来源：热榜/社区/科技媒体/公司动态）。
- relation: 只对互联网来源有意义。"direct"（能指出已被替代的具体岗位/流程）或 "indirect"（只是具备替代潜力，关系是间接的）。判断不了就用 "indirect"。**科研来源不用给这个字段**，它通过严格口径即视为 direct。
  · 「sector_hint」是来源的判断，**默认沿用**；只有内容明显属于另一类时才改写。不确定就用 hint。
- evidence_type: 必须是上面候选之一。
- 每条都要有输出，顺序与输入一致，不要遗漏 i。`;
}

export function buildEnrichPrompt({ items, scoring, anchors }) {
  const evTypes = Object.entries(scoring.evidenceTypes)
    .filter(([k]) => k !== "$comment")
    .map(([k, v]) => `- ${k}（${v.label}，可信度基准 ${v.prior}）：${v.desc}`)
    .join("\n");

  const payload = items.map((it, i) => ({
    i,
    source: it.sourceName,
    source_group: it.sourceGroup,
    title: it.title,
    published: (it.published ?? "").slice(0, 10),
    text: truncate(it.summary, 1800) || "(无正文，仅有标题)",
    url: it.url,
    draft: {
      domain: it.domain,
      value: it.value,
      displacement: it.displacement,
      direction: it.direction,
      evidence_type: it.evidenceType,
    sector_hint: it.sectorHint ?? null,
    },
  }));

  return `## evidence_type 与可信度基准
${evTypes}

## 评分锚点（先对齐这些例子，再打分；这是本任务最重要的约束）
${(anchors ?? scoring.anchors?.items ?? []).map((a, i) => `${i + 1}. ${a.desc} → value = ${a.value.toFixed(2)}`).join("\n")}

打分前先问自己：这条最像上面哪一个？只有确实比锚点更强时才给更高分。

## value 档位（推进强度 0-1）
${bandsTable(scoring.valueRubric.bands)}

## displacement 档位（人类劳动替代程度 0-1）
${bandsTable(scoring.displacementRubric.bands)}

## 待编辑条目
（draft 是初筛阶段的草稿判定，你可以修正它）
${JSON.stringify(payload, null, 1)}

## 输出格式
{"items":[{"i":0,"title_zh":"浓缩后的中文标题","summary_zh":"一句话中文事实摘要","companies":["OpenAI"],"concepts":["SWE-bench"],"keywords":["关键词1","关键词2","关键词3"],"why_zh":"不超过40字，说明它为什么构成对人类任务的替代或推进","evidence_quote":"从 text 中逐字复制的原文片段","evidence_type":"preprint","model":"涉及的AI系统或模型名","domain":"math","value":0.0,"displacement":0.0,"direction":"advance","confidence":0.0,"evidence_basis":"none"}]}

字段说明：
- title_zh: **中文标题，不超过 30 字**。不要逐字翻译英文标题，要**提炼出这件事到底是什么**——谁说、做了什么、结果如何。读者只扫标题就该知道发生了什么。
  · 好：「Salesforce 用 AI 客服替代 4000 个支持岗」
  · 差：「Salesforce 宣布裁减支持人员」（没说清是 AI 导致的）
  · 差：「关于 Salesforce Agentforce 在客户支持领域应用的分析」（照抄英文标题的措辞）
- companies: 标题或摘要里出现的**公司/机构名**，用原文写法（OpenAI、Salesforce、Anthropic、DeepMind…）。没有就填空数组。
- concepts: 标题或摘要里出现的**关键概念、产品名、基准名、技术名词**（Agentforce、SWE-bench、RAG、MoE…）。这些会在页面上被醒目标出，所以只挑真正需要读者注意的，每条不超过 4 个。
- confidence: 0-1，从 evidence_type 的可信度基准出发调整。独立第三方复现、可公开核验的数据集/榜单上调；厂商自述、无基线对比、单点小样本实验下调。
- model: 事件涉及的 AI 系统名（单个字符串，多个用顿号连接）；若原文没有明确系统，填 "未指明"。
- evidence_basis: value ≥ 0.65 时必填，写明具体基准名与数字或真实部署规模；给不出就填 "none" 并把 value 压到 ≤0.60。
- evidence_quote 必须逐字来自 text 字段。
- 不要输出 sector 字段，频道归属已由初筛确定。`;
}

/**
 * 定向修复提示词：补中文标题、摘要与关键词。
 * 单独一轮的原因：主填充轮次一次要模型产出评分、引文、领域等七八个字段，
 * 实测约 20% 的条目会漏掉 summary_zh；而摘要几乎是首页唯一可读的内容，
 * 漏了就等于把英文标题当摘要显示。用一轮只问这两项的调用补回来，成本很低。
 */
export function buildSummaryPrompt({ items }) {
  return `为下面每条条目写一个中文标题、中文摘要和关键词。

## 要求
- title_zh：**中文标题，不超过 30 字**，提炼出这件事到底是什么（谁说、做了什么、结果如何），不要逐字翻译英文标题。
- summary_zh：一句话，**必须用中文**，40-70 字，说清「做了什么、在什么任务上、达到什么程度」。不要复述英文标题，不要写"本文提出"这类空话。
- keywords：3-6 个中文或通用技术术语，不要用 "AI" 这种无区分度的词。
- why_zh：可选，一句话说明它为什么与「AI 替代人类任务」有关。

## 条目
${JSON.stringify(
    items.map((e, i) => ({ i, title: e.title, abstract: truncate(e.abstract ?? "", 500), domain: e.domain })),
    null,
    1,
  )}

## 输出
${JSON.stringify({ items: [{ i: 0, title_zh: "中文标题", summary_zh: "中文摘要", keywords: ["关键词"], why_zh: "关联说明" }] }, null, 1)}
只输出 JSON。`;
}

export function buildMergePrompt({ clusters }) {
  const payload = clusters.map((c, i) => ({
    c: i,
    items: c.map((it, j) => ({ j, title: it.title, source: it.sourceName, url: it.url, abstract: truncate(it.summary, 400) })),
  }));
  return `以下每组条目可能描述同一件事。请判断每组是否应合并，并选出最适合作为主记录的一条（信息最完整、来源最可信）。

${JSON.stringify(payload, null, 1)}

只输出 JSON：
{"clusters":[{"c":0,"merge":true,"keep_j":0,"reason":"不超过20字"}]}`;
}

export const MERGER_SYSTEM = "你负责判断多条资讯是否描述同一事件。严格只输出 JSON。";