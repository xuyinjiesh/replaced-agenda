<p align="center"><img src="assets/readme-mark.svg" alt="AI 降临观测站标识" width="76"></p>

<h1 align="center">AI 降临观测站</h1>

<p align="center"><sub>REPLACED AGENDA</sub></p>

<p align="center"><strong>观察智能，如何改变人的工作。</strong></p>

<p align="center">
  <a href="https://xuyinjiesh.github.io/replaced-agenda/"><img src="https://img.shields.io/badge/%E7%AB%99%E7%82%B9-%E5%9C%A8%E7%BA%BF%E9%98%85%E8%AF%BB-a34c35" alt="站点：在线阅读"></a>
  <a href="https://xuyinjiesh.github.io/replaced-agenda/method.html"><img src="https://img.shields.io/badge/%E6%96%B9%E6%B3%95-%E8%AF%84%E5%88%86%E4%B8%8E%E5%B1%80%E9%99%90-6d746e" alt="方法：评分与局限"></a>
  <a href="https://github.com/xuyinjiesh/replaced-agenda/blob/main/package.json"><img src="https://img.shields.io/badge/Node.js-20%2B-50734c" alt="Node.js 20+"></a>
</p>

记录 AI 承担具体人类任务的进展，并保留来源与不确定性。站点将事件分为「互联网」和「学术界」，提供摘要、来源链接、推进强度与证据可信度。

## 本地预览

需要 Node.js 20 或更高版本。项目没有 npm 运行时依赖，克隆后即可预览仓库中已生成的页面：

```bash
git clone https://github.com/xuyinjiesh/replaced-agenda.git
cd replaced-agenda
npm run serve
```

打开 `http://127.0.0.1:4180/`。`npm run selftest` 运行离线自检；`npm run render` 使用已有数据重新生成静态页面，不采集资讯或调用 AI。

## 生成新记录

完整流水线依次执行：**采集与缓存 → 规则筛选和去重 → AI 初筛与内容填充 → 引文及评分检查 → JSON 和静态页面**。

若使用 OpenAI 兼容接口，在仓库根目录创建不提交的 `.env`：

```dotenv
AI_API_KEY=your-key
AI_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
```

然后运行 `npm run pipeline`。它默认处理当天数据，需要访问外部来源和 AI 服务；模型名称与评分规则见 `config/scoring.json`。指定日期可用 `npm run pipeline -- --date 2026-09-29`。

## 代码地图

| 路径 | 用途 |
| --- | --- |
| `config/` | 数据源、领域和评分规则 |
| `scripts/pipeline.mjs`、`scripts/lib/pipeline-*.mjs` | 流水线编排、指数重算与运行报告 |
| `scripts/lib/render*.mjs`、`scripts/audit.mjs`、`scripts/lib/audit-*.mjs` | 页面生成与独立复核 |
| `scripts/lib/` 其余模块 | 采集、筛选、去重、评分和存储 |
| `theme/` | 前端样式与交互的源文件 |
| `data/events/` | 已提交的正式事件数据；增删日期以这里为准 |
| `data/` 其余目录 | 本地缓存、运行报告与旧数据归档；多数文件不提交 |
| `site/` | 从正式数据生成并提交的 HTML 与 JSON，供 GitHub Pages 发布 |

## 如何理解结果

每条记录区分推进强度 `value` 与证据可信度 `confidence`。仅标为 `direct` 的具体任务进展计入领域指数；`indirect` 事件仍可阅读，但贡献为零。引文核对针对**采集到的标题和摘要**，不等于核验来源网页全文。领域指数是基于模型判断的趋势指标，不是岗位减少人数，也不适合跨领域直接比较。

## 发布与协作

`main` 分支中的 `site/` 变化会触发 `.github/workflows/pages.yml`，将静态文件发布到 GitHub Pages；CI 不运行采集或 AI 流水线。首次部署须在仓库 **Settings → Pages** 将发布来源设为 **GitHub Actions**。

`npm run deploy` 会运行流水线，并执行 `git add -A`、提交和推送；使用前先检查 `git status`。修改代码或页面后运行 `npm run selftest`，并在 PR 中说明验证情况；界面变化附截图。
