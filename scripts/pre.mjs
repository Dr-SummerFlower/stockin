#!/usr/bin/env node
/**
 * 预发布：推送当前分支，再交给 release.yml 的 workflow_dispatch。
 *
 * 不在本地重复 build / package / deploy：预发布资产、GHCR pre 镜像和
 * Worker Preview 都由 Actions 使用仓库 secrets 完成，避免本地 wrangler 登录态
 * 与 CI 环境不一致。脚本负责前置检查、push 与触发。
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

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
  fail('工作区有未提交改动，请先提交并推送');
}

const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
if (branch === 'HEAD') fail('当前处于 detached HEAD，无法确定预发布分支');

process.stdout.write(`[pre] 推送 ${branch} 到 origin\n`);
gitRun(
  ['push', '-u', 'origin', branch],
  `git push origin ${branch} 失败，请先处理远端冲突或网络/SSH 认证`,
);

const head = git(['rev-parse', 'HEAD']).stdout.trim();
process.stdout.write(`[pre] 触发 ${branch} 的预发布：${head.slice(0, 7)}\n`);
const dispatch = spawnSync('gh', ['workflow', 'run', 'release.yml', '--ref', branch], {
  cwd: root,
  stdio: 'inherit',
});
if (dispatch.status !== 0) fail('gh workflow run 失败，请先确认 gh auth status');

const latest = spawnSync(
  'gh',
  [
    'run',
    'list',
    '--workflow',
    'release.yml',
    '--limit',
    '1',
    '--json',
    'databaseId,url,status,conclusion,headBranch',
  ],
  { cwd: root, encoding: 'utf8' },
);
if (latest.status === 0) {
  try {
    const run = JSON.parse(latest.stdout)[0];
    if (run) {
      process.stdout.write(`[pre] ${run.url}\n`);
    }
  } catch {
    // 列表输出仅用于提示，不阻塞触发结果。
  }
}
