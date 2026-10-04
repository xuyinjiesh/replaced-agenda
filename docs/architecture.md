# 架构与数据边界

本文是维护者和 AI 的按需参考；日常入口与命令见 [README](../README.md) 和 [AGENTS.md](../AGENTS.md)。

## 从输入到站点

`scripts/pipeline.mjs` 按顺序执行：采集来源 → 规则筛选与去重 → AI 初筛与内容填充 → 转成事件 → 全量重算并校验指数 → 保存正式数据 → 渲染和发布静态文件。

| 改动目标 | 主要位置 |
| --- | --- |
| 来源和采集 | `config/sources.json`、`scripts/lib/collect.mjs`、`scripts/lib/http.mjs` |
| 筛选、AI 和评分 | `scripts/lib/screen.mjs`、`scripts/lib/dedupe.mjs`、`scripts/lib/enrich.mjs`、`scripts/lib/score.mjs` |
| 日期存储与指数 | `scripts/lib/store.mjs`、`scripts/lib/pipeline-index.mjs` |
| 页面内容与交互 | `scripts/lib/render*.mjs`、`theme/` |
| 独立评分复核 | `scripts/audit.mjs`、`scripts/lib/audit-*.mjs` |

## 哪些文件是正式数据

- `data/events/YYYY-MM-DD.json` 是唯一的正式事件来源；事件按记录中的 `date` 归档。跨日期重处理按全局 `id` 合并，本次结果覆盖旧版本；没有记录的旧日期文件会被移除。
- `scripts/lib/pipeline-index.mjs` 先重算并验证指数，再写每日文件和 `data/index.json`。采集阶段的 `data/raw/` 和 `data/source-health.json` 可能更早写入。
- `site/` 是受版本控制的生成结果。渲染会更新页面和 `site/data/`，并清理不再属于正式数据的日期产物；改界面应编辑 `theme/` 或渲染模块。
- `data/legacy-events/` 存放本机旧数据，已被忽略，不参与读取或发布。2026 年 9 月 25–29 日的旧数据不应重新公开。

## 运行边界

`npm run selftest` 是离线自检。`npm run render` 不采集、不调用在线 AI，但会写生成文件和本机运行报告。`npm run pipeline` 可能访问外部来源与 AI 服务；`npm run audit` 另写被忽略的复核结果。`npm run deploy` 还会暂存全部改动、在当前分支提交，并默认推送本地 `main`；只在明确准备发布时使用。GitHub Pages 工作流只发布已提交的 `site/`，不会运行数据流水线。
