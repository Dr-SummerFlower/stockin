#!/usr/bin/env node
/**
 * 全自动发版：不需要人工指定版本号，脚本按 commit 自动算版本并完成后续所有操作。
 *
 * 用法：
 *   pnpm release            # 本地手动发版（全自动，零参数）
 *   node scripts/release.mjs --ci   # CI 调用（跳过 verify，因前面 job 已跑过）
 *
 * 版本怎么来：
 *   调 scripts/version.mjs 按 conventional commit 分析「最近 tag..HEAD」：
 *     feat→minor，fix/refactor/perf→patch，breaking→major；根版本计入所有 commit，
 *     子包按 scope 映射。若算出的根版本与最近 tag 相同（无实质变更），跳过发版。
 *
 * 固定流程（顺序不可调换）：
 *   前置检查 → fetch → rebase origin/main → [verify] → 算版本 → 写版本并提交
 *   → tag → push main → push tag
 *
 * 为什么 push main 必须早于 push tag：
 *   tag 指向的 commit 若不在默认分支历史里，GITHUB_TOKEN 无法用它创建 Release，
 *   CI 会报 HTTP 403 Resource not accessible by integration（v1.2.2 踩过）。
 *   先推 main 可保证 tag commit 一定在 main 历史中；即便最后推 tag 失败，
 *   main 已就位，手动补推 tag 也不会再触发该 403。
 *
 * CI 自动发版触发方式：push main → release.yml 的 decide job 调本脚本 --ci。
 *   bump commit 带 `[skip ci]`，push 回 main 不会再触发 workflow（切断循环）；
 *   push tag 触发已有的 stable 发布流程与 CHANGELOG 归档。
 *
 * 退出码：0 = 成功或「无需发版」；非 0 = 任一步失败，脚本明确指出停在哪一步与恢复办法。
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const REMOTE = 'origin';
const BRANCH = 'main';
const ciMode = process.argv.includes('--ci');

function fail(msg) {
  process.stderr.write(`\n[release] ✗ ${msg}\n`);
  process.exit(1);
}

function step(msg) {
  process.stdout.write(`\n[release] ${msg}\n`);
}

/** 捕获输出的 git 命令（用于判断），输出不展示给用户。 */
function gitCapture(args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' });
}

/** 输出实时展示给用户的 git 命令。 */
function gitRun(args, hint) {
  const r = spawnSync('git', args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) fail(hint || `git ${args.join(' ')} 失败（退出码 ${r.status}）`);
  return r;
}

// ---------------------------------------------------------------- 前置检查
step('前置检查：分支 / 工作区');

const status = gitCapture(['status', '--porcelain']);
if (status.status !== 0) fail('无法读取工作区状态');
if (status.stdout.trim()) {
  process.stderr.write(status.stdout);
  fail('工作区有未提交改动，请先提交后再发版（rebase 要求干净工作区）');
}

const branch = gitCapture(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
if (branch !== BRANCH) fail(`当前在 ${branch} 分支，发版必须在 ${BRANCH} 分支进行`);

// ---------------------------------------------------------------- 固定流程
const totalSteps = 8;
let seq = 0;
const next = () => `${++seq}/${totalSteps}`;

step(`${next()} 拉取远端更新`);
gitRun(['fetch', REMOTE], 'git fetch 失败，请检查网络与远端权限');

step(`${next()} rebase 到 ${REMOTE}/${BRANCH}`);
const rebase = spawnSync('git', ['rebase', `${REMOTE}/${BRANCH}`], { cwd: root, stdio: 'inherit' });
if (rebase.status !== 0) {
  fail(
    'rebase 失败（多为冲突），已停在此处，未打 tag、未 push。\n' +
      '       · 解决冲突后执行 git rebase --continue，再重新运行本脚本\n' +
      '       · 或执行 git rebase --abort 放弃本次 rebase',
  );
}

if (!ciMode) {
  step(`${next()} 质量门禁 pnpm verify`);
  const verify = spawnSync('pnpm', ['verify'], { cwd: root, stdio: 'inherit' });
  if (verify.status !== 0) fail('pnpm verify 失败，未打 tag、未 push，可修复后重跑');
} else {
  step(`${next()} 跳过 verify（CI 前置 job 已完成）`);
}

// ---------------------------------------------------------------- 自动算版本
step(`${next()} 根据 commit 自动计算版本`);
const verDry = spawnSync(process.execPath, [resolve(root, 'scripts/version.mjs'), '--json'], {
  cwd: root,
  encoding: 'utf8',
});
if (verDry.status !== 0) fail(`版本计算失败：${(verDry.stderr || '').trim()}`);
let versions;
try {
  versions = JSON.parse(verDry.stdout.trim());
} catch {
  fail(`无法解析版本计算结果：${verDry.stdout}`);
}
const version = versions.root;
const tag = `v${version}`;
const message = `release: ${version}`;

// 与最近 tag 比较：无实质变更则跳过（CI 循环切断点）。
const lastTag = gitCapture(['tag', '--list', 'v*', '--sort=version:refname'])
  .stdout.trim()
  .split('\n')
  .filter(Boolean)
  .pop();
if (lastTag && lastTag.replace(/^v/, '') === version) {
  step(`${lastTag} 已是当前版本，最近无实质变更（feat/fix/perf/refactor/breaking），跳过发版`);
  process.stdout.write('[release] ✓ 无需发版，正常退出。\n');
  process.exit(0);
}

// tag 冲突检查（算完版本才知道 tag 名）。
if (gitCapture(['rev-parse', '-q', '--verify', `refs/tags/${tag}`]).status === 0) {
  fail(`本地 tag ${tag} 已存在，请检查版本计算或先删除本地 tag`);
}
// git ls-remote --exit-code: 0 = 找到；2 = 无匹配（正常）；其它 = 真错误。
const remoteTag = gitCapture(['ls-remote', '--exit-code', '--tags', REMOTE, `refs/tags/${tag}`]);
if (remoteTag.status === 0) fail(`远端 tag ${tag} 已存在，请检查版本计算`);
if (remoteTag.status !== 2) {
  fail(`无法检查远端 tag（git ls-remote 退出码 ${remoteTag.status}），请检查网络与远端权限`);
}
process.stdout.write(`[release] 目标：${tag} / 消息：${message}\n`);

// ---------------------------------------------------------------- 写入版本并提交
step(`${next()} 写入各包版本并提交`);
const verWrite = spawnSync(
  process.execPath,
  [resolve(root, 'scripts/version.mjs'), '--write', '--json'],
  { cwd: root, stdio: 'inherit' },
);
if (verWrite.status !== 0) fail('版本写入失败，未打 tag、未 push');

const verChanged = gitCapture(['status', '--porcelain', '--', 'package.json', 'apps', 'packages']);
if (verChanged.stdout.trim()) {
  gitRun(['add', '-A', 'package.json', 'apps', 'packages']);
  // `[skip ci]` 让 bump commit push 回 main 时不再触发 workflow——切断 CI 自动发版的循环。
  gitRun(
    ['commit', '-m', `chore(release): 版本号统一为 ${version} [skip ci]`],
    '版本 bump 提交失败，未打 tag、未 push',
  );
} else {
  process.stdout.write('[release] 版本文件无变化，跳过 bump 提交\n');
}

// ---------------------------------------------------------------- tag + push
step(`${next()} 打 annotated tag ${tag}`);
gitRun(['tag', '-a', tag, '-m', message]);

step(`${next()} push ${BRANCH}（必须先于 tag，保证 tag commit 落在默认分支历史内）`);
gitRun(['push', REMOTE, BRANCH], `git push ${BRANCH} 失败，tag 尚未推送，可修复后重跑`);

step(`${next()} push tag ${tag}`);
const pushTag = spawnSync('git', ['push', REMOTE, tag], { cwd: root, stdio: 'inherit' });
if (pushTag.status !== 0) {
  fail(`${BRANCH} 已推送成功，但 tag 推送失败。可单独补推：git push ${REMOTE} ${tag}`);
}

step('发版命令执行完毕');
process.stdout.write(
  `[release] ✓ ${tag} 已推送，CI 将自动执行正式发布（Release / 镜像 / Worker）。\n` +
    `[release]   进度见仓库 Actions 页面；本次 tag commit 已在 ${BRANCH} 历史内，不会再触发 403。\n`,
);
