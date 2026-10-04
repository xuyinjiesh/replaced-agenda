import { escapeHtml, truncate } from "./text.mjs";

export function renderMethodBody({ latest, runReports, auditLoader, scoring, domains, healthRows, sourcesConfig }) {
  // ---------- 方法页 ----------
  const latestReport = latest ? runReports[latest] : null;
  const evidenceRows = Object.entries(scoring.evidenceTypes)
    .filter(([k]) => k !== "$comment")
    .map(([k, v]) => `<tr><td><code>${k}</code></td><td>${escapeHtml(v.label)}</td><td class="score">${v.prior}</td><td>${escapeHtml(v.desc)}</td></tr>`)
    .join("\n");
  const domainRows = domains
    .map((d) => `<tr><td><code>${d.key}</code></td><td>${escapeHtml(d.emoji)} ${escapeHtml(d.label)}</td><td>${escapeHtml(d.blurb)}</td><td class="score">${d.dailyBaseline}</td><td class="score">${d.scale}</td></tr>`)
    .join("\n");

  const evidenceCapRows = Object.entries(scoring.valueCaps?.caps ?? {})
    .map(([k, v]) => `<tr><td><code>${k}</code></td><td>${escapeHtml(scoring.evidenceTypes?.[k]?.label ?? k)}</td><td class="score">≤ ${Number(v).toFixed(2)}</td></tr>`)
    .join("\n");

  const latestDist = latestReport?.distribution ?? null;
  const latestAuditReport = latest ? auditLoader?.(latest) ?? null : null;

  const calibrationBlock = latestDist
    ? `<table>
<tr><th>指标</th><th>最新一天</th><th>预期</th></tr>
<tr><td>value 中位数</td><td class="score">${latestDist.medianValue}</td><td>${(scoring.calibration?.expectedMedianValue ?? [0.3, 0.55]).join(" – ")}</td></tr>
<tr><td>value 四分位（p25 / p75）</td><td class="score">${latestDist.p25Value} / ${latestDist.p75Value}</td><td>—</td></tr>
<tr><td>高价值(≥0.7)占比</td><td class="score">${(latestDist.highValueShare * 100).toFixed(0)}%</td><td>≤ ${((scoring.calibration?.expectedHighValueShare ?? 0.15) * 100).toFixed(0)}%</td></tr>
<tr><td>confidence 中位数</td><td class="score">${latestDist.medianConfidence}</td><td>${(scoring.calibration?.expectedMedianConfidence ?? [0.4, 0.75]).join(" – ")}</td></tr>
<tr><td>因「无具体依据」被截断</td><td class="score">${latestDist.cappedByBasis}</td><td>越少越好</td></tr>
<tr><td>因「证据类型不足」被截断</td><td class="score">${latestDist.cappedByEvidenceType}</td><td>—</td></tr>
<tr><td>引文未通过核对</td><td class="score">${latestDist.unverifiedQuotes}</td><td>0 最佳</td></tr>
</table>
<p>流水线每天自动比对这张表。中位数或高价值占比越界时，运行日志会给出「评分分布告警」，说明当天 AI 打分整体偏宽或偏严——这类漂移是这类系统的头号故障模式。</p>`
    : "<p>尚未有运行记录。</p>";
  const healthTable = (healthRows ?? [])
    .map(
      (h) => `<tr>
  <td>${escapeHtml(h.name)}</td>
  <td><code>${escapeHtml(h.id)}</code></td>
  <td>${h.lastStatus === 200 ? '<span class="pos">可用</span>' : h.lastStatus ? `<span class="neg">HTTP ${h.lastStatus}</span>` : '<span class="zero">未探测</span>'}</td>
  <td class="score">${h.successes}</td>
  <td class="score">${h.failures}</td>
  <td>${escapeHtml(truncate(h.lastError || "—", 60))}</td>
</tr>`,
    )
    .join("\n");

  const methodBody = `<main class="editorial-main method-main" id="main-content"><section class="head">
  <h1>方法与口径</h1>
  <p class="sub">这个站点如何产生每日记录、分数意味着什么、以及它在哪里不可靠。</p>
</section>
<div class="prose">
<h2>1. 每日流水线</h2>
<ol>
  <li><strong>原始资讯采集</strong>：读取 <code>config/sources.json</code> 中注册的全部源（RSS/Atom 与 JSON API），带超时、重试与同源节流，原文缓存到 <code>data/raw/&lt;日期&gt;/</code>。单个源失败不影响整体。</li>
  <li><strong>规则初筛</strong>：按日期窗口剔除旧闻、按 <code>data/seen.json</code> 剔除已收录条目、按正/负词典剔除离题与征稿通知，再用优先级评分把候选收敛到可承受规模。</li>
  <li><strong>AI 初筛</strong>：批量送入 ${escapeHtml(scoring.models.screening)}，判断相关性、领域、初版价值/替代度/方向与证据类型；灰区相似对交由 AI 复核是否同一事件。</li>
  <li><strong>相似合并</strong>：标题 2-gram Jaccard + 摘要 SimHash 聚类，同一事件只保留一条主记录，其余记为「另有来源」——多来源独立报道本身是可信度信号。</li>
  <li><strong>内容填充</strong>：批量送入 ${escapeHtml(scoring.models.enrichment)}，生成中文摘要、关键词、原文证据片段与最终评分。</li>
  <li><strong>落盘与展示</strong>：写入 <code>data/events/&lt;日期&gt;.json</code>，重算指数，再渲染成静态 HTML 到 <code>site/</code>。</li>
</ol>

<h2>2. 两个频道：学术界与互联网</h2>
<p>每条记录归入一个频道，<strong>按来源划分</strong>（不是按内容临时判断）：</p>
<ul>
  <li><strong>学术界（科研成果）</strong>：arXiv、期刊、独立基准机构 —— 产出是论文与理论结果。</li>
  <li><strong>互联网（实时热点）</strong>：热榜、社区（Hacker News / Reddit / V2EX / Lobsters）、科技媒体、大公司动态、产品榜 —— 反映当下互联网在关注什么。</li>
</ul>
<p>归属只在 AI 初筛阶段判定一次，后续环节不再改写——两个阶段各判一次会互相覆盖（实测填充阶段把互联网条目几乎全改回 academia）。</p>

<h3>互联网频道的相关性口径更宽</h3>
<p>学术界要求能指出「哪类人类工作会变少」。互联网频道<strong>允许间接关系</strong>：一个好用的产品、一种新的交互方式、一次成本大幅下降，都可能具备<strong>替代潜力</strong>，即使当下还没人因此失业。</p>
<p>但仍然<strong>必须与 AI 或自动化有关</strong>：热榜里排名第一的娱乐、体育、时政新闻照样排除（实测抓取的今日头条热榜前三是「日媒惊呼中国队出了怪物级天才」这类内容）。</p>

<h3>「直接」与「潜力」分开算</h3>
<p>每条记录带 <code>relation</code> 字段：</p>
<ul>
  <li><code>direct</code>：能指出已被替代的具体岗位或流程 —— <strong>计入指数</strong>。</li>
  <li><code>indirect</code>：只是具备替代潜力，关系是间接的 —— 页面照常显示，但<strong>贡献恒为 0，不计入指数</strong>。</li>
</ul>
<p>这么做是因为「这个产品有替代潜力」是<strong>推断</strong>而不是<strong>观测</strong>。把推断计入进程指数，会让「AI 取代人类」看起来比实际快——正是这个项目一开始花大力气修掉的评分膨胀。判断不了时一律按 <code>indirect</code> 处理，宁可低估。</p>
<p>频道页头部会同时给出两个数字：直接替代 N 条（计入指数）、具备潜力 M 条（不计入指数）。</p>

<h3>为什么用滚动窗口</h3>
<p>频道页取<strong>近 7 天</strong>，而不是单日。原因是发布日 ≠ 采集日：公司博客和媒体常在发布几天后才被采到，而事件日期取发布日是对的。只看单日会让互联网频道几乎空掉。带灰色日期标签的条目不是今天发布的。</p>

<h2>3. 事件 schema</h2>
<pre>${escapeHtml(JSON.stringify(
    {
      date: "2026-09-27",
      sector: "internet",
      domain: "healthcare",
      value: 0.62,
      delta: 0.03,
      model: "xxx",
      source_url: "https://...",
      evidence_quote: "原文片段",
      evidence_type: "third_party_reproduced",
      confidence: 0.9,
    },
    null,
    2,
  ))}</pre>
<p>前九个字段是约定 schema。此外每条记录还带有用于展示与审计的字段：<code>id</code>、<code>title</code>、<code>summary_zh</code>、<code>keywords</code>、<code>why_zh</code>、<code>displacement</code>、<code>direction</code>、<code>ai_systems</code>、<code>evidence_verified</code>、<code>source_name</code>、<code>also_reported_by</code>、<code>screened_by</code>、<code>scored_by</code>、<code>index_contribution</code>。</p>
<p>其中 <code>model</code> 指<strong>事件涉及的 AI 系统</strong>（如某个模型或产品），给这条内容打分的模型记录在 <code>scored_by</code>。</p>

<h2>4. 三个分数</h2>
<table>
<tr><th>字段</th><th>含义</th><th>口径</th></tr>
<tr><td><code>value</code></td><td>推进强度 0-1</td><td>该事件在「AI 承担原本由人类完成的任务」这条轴上推进了多少</td></tr>
<tr><td><code>displacement</code></td><td>替代程度 0-1</td><td>该环节的人类角色可以被移除到什么程度（1 = 整环替代）</td></tr>
<tr><td><code>confidence</code></td><td>可信度 0-1</td><td>由证据类型基准出发，按独立性与可复现性调整；引文无法在原文中核对时会显著下调</td></tr>
</table>

<h3>value 档位</h3>
<table><tr><th>区间</th><th>档位</th><th>说明</th></tr>
${scoring.valueRubric.bands.map((b) => `<tr><td class="score">${b.min.toFixed(2)}-${(b.max ?? 1).toFixed(2)}</td><td>${escapeHtml(b.label)}</td><td>${escapeHtml(b.desc)}</td></tr>`).join("\n")}
</table>

<h2>5. 证据类型</h2>
<table><tr><th>key</th><th>名称</th><th>基准可信度</th><th>说明</th></tr>
${evidenceRows}
</table>
<p><strong>证据核对闸门</strong>：模型给出的 <code>evidence_quote</code> 会被程序逐字回查原文，核对不上的引文不会写入，同时该条 <code>confidence</code> 乘 0.6。这是防止模型编造引文的主要手段。</p>

<h2>6. 指数与 delta</h2>
<p>每个领域有一个 0-100 的进程指数，用饱和曲线把累计贡献映射成指数：</p>
<pre>贡献 c = direction × value × confidence        （advance = +1，setback = −1，neutral = 0）
指数 I = 100 × (1 − e^(−累计贡献 / K))
      K = dailyBaseline × horizonDays           （horizonDays = ${scoring.indexModel?.horizonDays ?? 90}）

单条事件的 delta = I(累计值 + c) − I(累计值)
</pre>
<p><code>dailyBaseline</code> 是该领域的日均贡献基线，<code>K</code> 由它推导。这样定义的好处是：在正常节奏下，<strong>每个领域的指数都约在 ${scoring.indexModel?.horizonDays ?? 90} 天后达到 63%</strong>，日环比变化量级统一（正常一天合计约 +1 到 +3），单日热点不会把不同领域拉出量级差异。</p>
<p>因此<strong>同一领域同一天所有事件的 delta 之和，恒等于该领域当日指数变化量</strong>——可加、可核验。流水线每次运行都会独立复算一遍并断言这个恒等式。</p>
<p>指数刻意用饱和曲线：单日热点不会把指数顶满，长期累积才会。它衡量的是「自基准日起的累计进程」，不是绝对真值，也不能跨领域直接比较。</p>
<table><tr><th>key</th><th>领域</th><th>范围</th><th>日均基线</th><th>尺度 K</th></tr>
${domainRows}
</table>

<h2>7. 硬闸门：证据不足就不许给高分</h2>
<p>光靠提示词约束不了模型。因此有两道<strong>代码强制</strong>的闸门，在 AI 打分之后套用：</p>
<ol>
  <li><strong>依据闸门</strong>：<code>value ≥ ${scoring.screening?.requireAbove ?? 0.65}</code> 时必须填写 <code>evidence_basis</code>（具体基准名与数字，或真实部署规模）。写不出具体依据的，直接压到 ≤ ${scoring.screening?.basislessValueCap ?? 0.6}。</li>
  <li><strong>证据类型闸门</strong>：证据类型决定 value 的上限——没有对应等级的证据，就不允许给出对应等级的推进强度。</li>
</ol>
<table><tr><th>证据类型</th><th>名称</th><th>value 上限</th></tr>
${evidenceCapRows}
</table>
<p>被闸门截断的记录在列表里带 <sup>*</sup> 标记，字段里带 <code>value_capped</code>。</p>

<h2>8. 评分分布自检</h2>
${calibrationBlock}

<h2>8b. <span id="audit"></span>跨模型独立复核</h2>
<p>评分通胀是这类系统最主要的失效模式，而<strong>同一个模型无法发现自己的偏差</strong>——让它自查，结果会和打分时高度相关。所以另设一个复核脚本，用<strong>不同族的模型</strong>重新给当天事件打分，专门找被高估的条目：</p>
<pre>npm run audit -- --date ${escapeHtml(latest ?? "YYYY-MM-DD")}              # 用 .env 配置的模型复核（默认 deepseek 系）
npm run audit -- --date ${escapeHtml(latest ?? "YYYY-MM-DD")} --sample 30  # 只抽查价值最高的 30 条
npm run audit -- --date ${escapeHtml(latest ?? "YYYY-MM-DD")} --engine codex  # 交给 codex agent 深度复核</pre>
<p>复核结果落在 <code>data/audits/&lt;日期&gt;.json</code>，与原评分不一致的条目会在列表里带「复核」标记。<strong>复核不会自动改写分数</strong>——单个复核模型的判断同样可能错，它的作用是产生一个可人工抽查的候选清单，而不是自动裁决。</p>
${latestAuditReport
  ? `<p>最近一次复核（<code>${escapeHtml(latestAuditReport.auditor_model)}</code>，engine=${escapeHtml(latestAuditReport.engine)}，比对 ${latestAuditReport.summary.compared} 条）：平均差 <b class="score">${latestAuditReport.summary.meanDiff}</b>，一致率 <b class="score">${(latestAuditReport.summary.agreeRate * 100).toFixed(0)}%</b>，判为高估 ${latestAuditReport.summary.overScored} 条、领域不一致 ${latestAuditReport.summary.domainMismatch} 条。</p>
<p style="color:var(--fg-faint);font-size:13px">结论：${latestAuditReport.summary.verdict.map((v) => escapeHtml(v)).join("；")}</p>`
  : "<p>还没有复核记录。首次运行的发现通常是「安全/评测类基准被误判为劳动替代」与「预印本自述被高估」这两类。</p>"}

<h2>9. 数据源健康</h2>
<p>流水线每次运行都会记录每个源的可用性；连续失败 ${sourcesConfig.settings?.healthSkipAfterFailures ?? 3} 次的源会被临时跳过（${sourcesConfig.settings?.healthCooldownDays ?? 7} 天冷却），可用 <code>--force-sources</code> 强制重试。</p>
<table><tr><th>源</th><th>id</th><th>状态</th><th>成功</th><th>失败</th><th>最近错误</th></tr>
${healthTable || '<tr><td colspan="6">尚未运行过流水线</td></tr>'}
</table>

<h2>10. 已知局限</h2>
<ul>
  <li><strong>来源覆盖取决于网络可达性</strong>。当前环境下大量媒体与期刊站点不可达，因此记录偏向预印本与官方博客，这对「真实岗位替代」类事件不敏感。</li>
  <li><strong>评分是模型判断，不是测量</strong>。同一事件换一个模型可能差 0.1-0.2。档位表与证据类型权重是为了压低这种漂移，但不能消除。</li>
  <li><strong>预印本不等于事实</strong>。大量记录的 <code>evidence_type</code> 是 <code>preprint</code>，其可信度基准仅 0.55。</li>
  <li><strong>指数不可跨领域比较</strong>。各领域的 K 与事件密度不同，只适合看单领域随时间的走向。</li>
  <li><strong>分数通胀是主要风险</strong>。模型倾向于把普通论文打成「显著跃升」。上述两道硬闸门与分布自检就是为了压制它，但仍需人工抽查。</li>
  <li><strong>候选上限</strong>：初筛候选上限 ${scoring.screening.candidatesCap} 条、填充上限 ${scoring.screening.enrichCap} 条，超出部分留待提高配置后处理。</li>
</ul>

<h2>11. 复现</h2>
<pre>npm run pipeline            # 完整跑一次当日流水线
npm run pipeline -- --date 2026-09-27 --refresh   # 指定日期并强制刷新源
npm run pipeline -- --offline                     # 只用本地缓存，不联网
npm run render              # 只重算指数并重新渲染 HTML
npm run probe               # 探测数据源可达性</pre>
<p>所有 AI 调用按 prompt 哈希缓存在 <code>data/cache/ai/</code>，同一天重跑不会重复计费，结果可复现。</p>
</div></main>`;

  return methodBody;
}
