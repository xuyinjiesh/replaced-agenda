# Repository Guidelines

## Project Structure & Module Organization

This is a Node.js 20+ ES module project. `scripts/pipeline.mjs` orchestrates collection, AI processing, scoring, and rendering; reusable modules live in `scripts/lib/`. `config/*.json` defines sources, domains, and scoring rules. Edit UI code in `theme/app.js` and `theme/style.css`; rendering copies these files into `site/assets/`. `data/events/` is the tracked source of truth for event dates; `site/` contains generated HTML and JSON for GitHub Pages. Other `data/` directories hold ignored caches, archives, and run reports. The test suite is `scripts/selftest.mjs`.

## Build, Test, and Development Commands

- `npm run selftest`: run offline invariant checks without AI calls.
- `npm run render`: regenerate the index and static pages from available data.
- `npm run serve`: preview `site/` at `http://127.0.0.1:4180/`.
- `npm run pipeline -- --date 2026-09-28`: run the collection and rendering pipeline for a date; AI access may require credentials.
- `npm run audit -- --date 2026-09-28`: independently review that day's scores.
- `npm run deploy`: run the pipeline, stage all changes, commit, and push `main`; inspect `git status` first.

## Coding Style & Naming Conventions

Follow the surrounding JavaScript style: two-space indentation, double quotes, semicolons, and `.mjs` ES modules. Use `camelCase` for functions and variables; date-based outputs use `YYYY-MM-DD` filenames. Keep page orchestration in `scripts/lib/render.mjs`, templates in `render-shell.mjs`, `render-records.mjs`, and `render-method.mjs`, and UI behavior in `theme/`. No formatter or linter is configured in `package.json`.

## Testing Guidelines

Add focused, descriptively named assertions to `scripts/selftest.mjs` when changing pipeline rules, schemas, or rendering. Run `npm run selftest` before proposing those changes. There is no separate test framework or coverage threshold. For UI changes, regenerate pages and inspect the home, academic, archive, and affected day or domain pages with `npm run serve`.

## Commit & Pull Request Guidelines

Recent commits include `feat(ui): 应用编辑式阅读界面` and date-stamped `data:`/`site:` updates. For hand-written changes, use a short Chinese Conventional Commit subject such as `fix(render): 修复页面链接`. In pull requests, describe the user-facing change and verification performed; include screenshots for visual changes and link an issue when applicable. Commit regenerated `site/` files when their source changes.

## Security & Publishing

Never commit `.env`, local caches, or `replaced-agenda-ui-handoff-2026-09-30/`. Do not commit or push unless requested. The workflow in `.github/workflows/pages.yml` publishes tracked `site/` files after relevant pushes to `main`; it does not run the data pipeline or need AI credentials.
