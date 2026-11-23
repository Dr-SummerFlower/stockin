#!/usr/bin/env node
/**
 * 预发布：用 git 创建并推送 `pre-<sha7>` tag，由 release.yml 的 tag 触发。
 *
 * 不在本地调用 gh CLI，也不在本地 build / package / deploy：
 * Actions 负责 pre Release、pre 镜像与 Worker Preview。
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const REMOTE = 'origin';
const BRANCH = 'main';

function fail(message) {
  process.stderr.write(`\n[pre] ✗ ${message}\n`);
  process.exit(1);
}

function git(args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' });
}

function gitRun(args, hint) {
  const result = spawnSync('git', args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) fail(hint || `git ${args.join(' ')} 失败`);
  return result;
}

const status = git(['status', '--porcelain']);
if (status.status !== 0) fail('无法读取工作区状态');
if (status.stdout.trim()) {
  process.stderr.write(status.stdout);
  fail('工作区有未提交改动，请先提交');
}

const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
if (branch === 'HEAD') fail('当前处于 detached HEAD，无法确定预发布分支');
if (branch !== BRANCH) fail(`当前在 ${branch} 分支，预发布必须在 ${BRANCH} 分支进行`);

const sha = git(['rev-parse', 'HEAD']).stdout.trim();
const sha7 = sha.slice(0, 7);
const tag = `pre-${sha7}`;

if (git(['rev-parse', '-q', '--verify', `refs/tags/${tag}`]).status === 0) {
  fail(`本地 tag ${tag} 已存在；同一个提交不重复预发布，或先删除本地 tag`);
}
const remoteTag = git(['ls-remote', '--exit-code', '--tags', REMOTE, `refs/tags/${tag}`]);
if (remoteTag.status === 0) fail(`远端 tag ${tag} 已存在；同一个提交不重复预发布`);
if (remoteTag.status !== 2) {
  fail(`无法检查远端 tag（git ls-remote 退出码 ${remoteTag.status}），请检查网络与远端权限`);
}

process.stdout.write(`[pre] 推送 ${branch} @ ${sha7}\n`);
gitRun(
  ['push', '-u', REMOTE, branch],
  `git push ${REMOTE} ${branch} 失败，请先处理远端冲突或网络/SSH 认证`,
);

process.stdout.write(`[pre] 创建并推送 ${tag}\n`);
gitRun(['tag', '-a', tag, '-m', `预发布 ${tag}`], `创建 tag ${tag} 失败`);
gitRun(
  ['push', REMOTE, tag],
  `${branch} 已推送，但 tag ${tag} 推送失败；可单独补推 git push ${REMOTE} ${tag}`,
);

process.stdout.write(`[pre] ✓ ${tag} 已推送，Actions 将构建 pre Release 与 Worker Preview。\n`);
