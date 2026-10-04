# Repository Guidelines

## Project Map

This is a Node.js 20+ ES module project. `scripts/pipeline.mjs` coordinates collection, AI processing, scoring, and rendering; supporting code is in `scripts/lib/`. `config/*.json` defines sources, domains, and scoring. `theme/` holds UI source files, while tracked `site/` holds generated pages and published event JSON for GitHub Pages. `data/events/` is an ignored local working copy. Read [docs/architecture.md](docs/architecture.md) before changing the pipeline or data flow.

## Commands

- `npm run selftest`: offline invariant checks; no online AI calls.
- `npm run render`: rebuild from local events or published `site/data/` without collection or AI calls; may rewrite generated files and local reports.
- `npm run serve`: preview `site/` at `http://127.0.0.1:4180/`.
- `npm run pipeline`: collect and process today's data; `-- --date YYYY-MM-DD` selects another date intended for publication. May access external sources and AI services.
- `npm run audit`: independently review today's scores; `-- --date YYYY-MM-DD` selects another formal event date.

## Data and Code Boundaries

Event IDs are unique across dates. A reprocessed record replaces its older version, and its `date` determines the output file. Event reads prefer local `data/events/` and fall back to tracked `site/data/`; both directories contribute dates. Index verification must pass before event and index files are saved; collection can write raw caches and source health earlier. The local September 25–29, 2026 archive in ignored `data/legacy-events/` is deliberately excluded; do not republish it without an explicit request. When removing a published date manually, remove its local copy too. Edit `theme/` or `scripts/lib/render*.mjs`, then regenerate `site/` rather than editing generated pages.

Follow nearby JavaScript style: two spaces, double quotes, semicolons, `.mjs` ES modules, and `camelCase`. Date files use `YYYY-MM-DD`. No formatter, linter, or coverage threshold is configured. Add focused assertions to `scripts/selftest.mjs` for pipeline, schema, or rendering changes. For UI changes, inspect the affected pages with `npm run serve`.

## Git and Publishing

Use short Chinese Conventional Commit subjects, for example `fix(render): 修复页面链接`. PRs should explain the change and checks performed; add screenshots for UI changes. Include regenerated `site/` files only when their content changes. Never commit `.env`, caches, or `replaced-agenda-ui-handoff-2026-09-30/`. Do not commit or push unless requested.

`npm run deploy` runs the pipeline, stages **all** changes, commits on the current branch, then pushes local `main` by default; it does not switch branches. Use it only on `main` when publication is explicitly requested, after checking `git status`. `.github/workflows/pages.yml` publishes tracked `site/` changes on `main`; CI does not run the pipeline or need AI credentials.
