import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { log, parseArgs, readJSON, setLogLevel, todayISO } from "./lib/util.mjs";

// 一键发布：跑流水线 → 把 site/ 产物提交 → 推到 GitHub，剩下的交给 Actions 上线。
// 设计上刻意不碰 git 凭据：push 失败就如实报错，不尝试任何认证技巧。
const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SITE = path.join(ROOT, "site");

function git(args, { allowFail = false, capture = false } = {}) {
  const r = spawnSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(" ")} 失败（退出码 ${r.status}）`);
  }
  return { code: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

function main() {
  const args = parseArgs();
  if (args["log-level"]) setLogLevel(String(args["log-level"]));
  const skipBuild = Boolean(args["no-build"]);
  const skipPush = Boolean(args["no-push"]);
  const remote = String(args.remote ?? "origin");
  const branch = String(args.branch ?? "main");

  // ---------- 0. 建仓 ----------
  const inside = git(["rev-parse", "--is-inside-work-tree"], { allowFail: true, capture: true });
  if (inside.code !== 0) {
    log("info", `初始化 git 仓库（分支 ${branch}）`);
    git(["init", "-b", branch]);
  }

  // ---------- 1. 安全闸门：绝不能把密钥提交上去 ----------
  // .gitignore 里 site/ 已被放开，所以这层校验必须显式存在：一旦有人手滑改了
  // .gitignore 让 .env 变为可跟踪，这里要拦下来，而不是等 push 之后才发现。
  if (fs.existsSync(path.join(ROOT, ".env"))) {
    const ignored = spawnSync("git", ["check-ignore", "-q", ".env"], { cwd: ROOT }).status === 0;
    if (!ignored) {
      log("error", ".env 没有被 .gitignore 忽略！中止发布——密钥可能被提交");
      process.exit(1);
    }
    log("info", ".env 已被忽略，安全");
  }

  // ---------- 2. 重新生成产物 ----------
  if (skipBuild) {
    log("info", "跳过流水线（--no-build）");
  } else {
    log("info", "运行流水线…");
    const passthrough = [];
    if (args.date) passthrough.push("--date", String(args.date));
    if (args["force-sources"]) passthrough.push("--force-sources");
    if (args.refresh) passthrough.push("--refresh");
    const r = spawnSync("node", [path.join(ROOT, "scripts", "pipeline.mjs"), ...passthrough], {
      cwd: ROOT,
      stdio: "inherit",
    });
    if (r.status !== 0) {
      log("error", `流水线失败（退出码 ${r.status}），未提交任何内容`);
      process.exit(r.status ?? 1);
    }
  }

  // ---------- 3. 产物自检 ----------
  const indexPath = path.join(SITE, "index.html");
  if (!fs.existsSync(indexPath)) {
    log("error", "site/index.html 不存在，没有可发布的内容");
    process.exit(1);
  }
  if (!fs.existsSync(path.join(SITE, ".nojekyll"))) {
    fs.writeFileSync(path.join(SITE, ".nojekyll"), "", "utf8");
    log("warn", "补写 site/.nojekyll（渲染时未生成）");
  }
  const date = String(args.date ?? todayISO());
  const dayFile = path.join(ROOT, "data", "events", `${date}.json`);
  const day = fs.existsSync(dayFile) ? readJSON(dayFile, null) : null;
  const count = Array.isArray(day?.events) ? day.events.length : null;

  // ---------- 4. 提交 ----------
  git(["add", "-A"]);
  const staged = git(["diff", "--cached", "--name-only"], { capture: true }).out;
  if (!staged) {
    log("info", "没有变化，无需提交");
    // 即使无变化也继续走 push，避免本地已提交但未推送的状态被漏掉
  } else {
    const files = staged.split("\n").filter(Boolean);
    const msg = count === null ? `site: ${date}` : `data: ${date} · ${count} 条事件`;
    log("info", `待提交 ${files.length} 个文件：${msg}`);
    git(["commit", "-m", msg]);
  }

  // ---------- 5. 推送 ----------
  const hasRemote = git(["remote", "get-url", remote], { allowFail: true, capture: true }).code === 0;
  if (skipPush) {
    log("info", "已提交，跳过推送（--no-push）");
    return;
  }
  if (!hasRemote) {
    log("warn", `没有名为 ${remote} 的远端，已提交但未推送。`);
    process.stdout.write(
      [
        "",
        "  第一次发布，先在 GitHub 建一个空仓库（不要勾选 README），然后执行：",
        "",
        `    git remote add ${remote} git@github.com:<你的用户名>/<仓库名>.git`,
        `    git push -u ${remote} ${branch}`,
        "",
        "  推上去之后，在仓库 Settings → Pages → Build and deployment",
        "  把 Source 选成 “GitHub Actions”。之后每次 npm run deploy 都会自动上线。",
        "",
      ].join("\n"),
    );
    return;
  }
  log("info", `推送到 ${remote}/${branch}…`);
  const pushed = git(["push", remote, branch], { allowFail: true });
  if (pushed.code !== 0) {
    log("error", "推送失败。常见原因：远端还没有这个分支、没有推送权限、或需要先 pull。");
    process.exit(pushed.code ?? 1);
  }
  const url = git(["remote", "get-url", remote], { capture: true })
    .out.replace(/^git@github\.com:/, "https://github.com/").replace(/\.git$/, "");
  log("info", `推送完成。Actions 上线后访问：${url ? `${url}#pages` : "仓库的 Pages 地址"}`);
}

main();
