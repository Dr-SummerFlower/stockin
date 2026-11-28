#!/usr/bin/env node
/**
 * 按 conventional commit 的 scope 计算各包语义化版本。
 *
 * 用法：
 *   node scripts/version.mjs                    # 默认 dry-run：基于最近 v* tag 的增量
 *   node scripts/version.mjs --all              # dry-run：从首个 v* tag 回溯全历史
 *   node scripts/version.mjs --all --write      # 回溯并写入 5 处 package.json + APP_VERSION
 *   node scripts/version.mjs --write            # 基于最近 tag 增量并写入
 *   node scripts/version.mjs --json             # 仅输出 JSON（供 release.mjs 消费）
 *
 * 规则（最终以 CONVENTIONS.md 为准）：
 *   - 根 = 软件版本，计入所有 commit 的 feat/fix/refactor/perf/breaking（不分 scope）。
 *   - 子包按 scope：server(auth/db→server)、web、domain、shared；其余 scope 跳过。
 *   - feat→minor，fix/refactor/perf→patch，breaking(!/BREAKING CHANGE)→major。
 *   - test/docs/build/chore/ci 及无 scope 的非包提交不计入子包。
 *
 * 版本真源 = git tag + commit 分析，package.json 只是展示快照：
 *   - 根版本基线取「最近 v* tag」的数字部分（不是 package.json，避免快照落后导致重复发版）。
 *   - 子包版本基线取各自 package.json（tag 只带根版本，无法反推子包）。
 *   - --all 时从首个 tag=1.0.0 逐区间回溯；默认增量只累加最近 tag..HEAD。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** 只替换首个 "version": "..." 字段，保留文件其余格式（避免 JSON.stringify 重排数组）。 */
function replaceVersion(src, version) {
  // 不加行首锚点，兼容单行紧凑 JSON 与多行缩进 JSON；只改首个匹配（顶层 version）。
  const re = /("version"\s*:\s*)"[^"]+"/;
  if (!re.test(src)) return null;
  return src.replace(re, `$1"${version}"`);
}

const root = resolve(import.meta.dirname, '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

const argv = process.argv.slice(2);
const all = argv.includes('--all');
const write = argv.includes('--write');
const jsonOnly = argv.includes('--json');
// --root-version <v>：强制根/软件版本为指定值（发布时以用户传入的 tag 版本为准）。
const rootVersionIdx = argv.indexOf('--root-version');
const forcedRoot = rootVersionIdx >= 0 ? argv[rootVersionIdx + 1] : null;
if (rootVersionIdx >= 0 && (!forcedRoot || !/^\d+\.\d+\.\d+$/.test(forcedRoot))) {
  process.stderr.write('[version] --root-version 需要形如 1.2.3 的版本号\n');
  process.exit(1);
}

const PKGS = ['root', 'server', 'web', 'domain', 'shared'];
const PKG_FILES = {
  root: 'package.json',
  server: 'apps/server/package.json',
  web: 'apps/web/package.json',
  domain: 'packages/domain/package.json',
  shared: 'packages/shared/package.json',
};
const CONSTANTS_FILE = 'packages/shared/src/constants.ts';

/**
 * --app-version <v>：只把发布版本写进 APP_VERSION，不改任何 package.json。
 *
 * 发布流水线用：稳定版取 tag 数字部分（v1.4.2 → 1.4.2），预发布原样
 * （pre-abc1234 → pre-abc1234）。预发布版本**不可能**随源码提交——它由
 * 提交 sha 派生，写进提交会改变 sha 自身（自指）；因此只能在构建期注入，
 * 让「管理台显示的应用版本」与发布 tag 严格一致。
 *
 * 不读 git tag：release.yml 的 verify 作业是浅克隆，可能根本没有 tag 对象。
 */
const appVersionIdx = argv.indexOf('--app-version');
if (appVersionIdx >= 0) {
  const target = argv[appVersionIdx + 1];
  if (!target || !/^(pre-[0-9a-f]{7}|\d+\.\d+\.\d+)$/.test(target)) {
    process.stderr.write('[version] --app-version 需要形如 1.2.3 或 pre-abcdef0 的版本号\n');
    process.exit(1);
  }
  const file = resolve(root, CONSTANTS_FILE);
  const src = readFileSync(file, 'utf8');
  const updated = src.replace(
    /export const APP_VERSION = '[^']+';/,
    `export const APP_VERSION = '${target}';`,
  );
  if (updated === src && !src.includes(`APP_VERSION = '${target}'`)) {
    process.stderr.write('[version] 未匹配到 APP_VERSION，常量未更新\n');
    process.exit(1);
  }
  if (updated !== src) writeFileSync(file, updated);
  process.stdout.write(`[version] APP_VERSION = ${target}\n`);
  process.exit(0);
}

// scope -> 子包。auth/db 归入 server；其余非包名 scope 不映射到子包。
const SCOPE_TO_PKGS = {
  server: ['server'],
  auth: ['server'],
  db: ['server'],
  web: ['web'],
  domain: ['domain'],
  shared: ['shared'],
};
const BUMP_RANK = { major: 3, minor: 2, patch: 1, none: 0 };

function levelOf(subject) {
  const m = subject.match(/^(\w+)(\([^)]+\))?(!)?:\s/);
  if (!m) return { type: '?', scope: null, level: 'none' };
  const [, type, scopeRaw, bang] = m;
  const scope = scopeRaw ? scopeRaw.slice(1, -1) : null;
  const breaking = Boolean(bang) || /BREAKING CHANGE/.test(subject);
  let level = 'none';
  if (breaking) level = 'major';
  else if (type === 'feat') level = 'minor';
  else if (['fix', 'refactor', 'perf'].includes(type)) level = 'patch';
  return { type, scope, level };
}

function bump([ma, mi, pa], level) {
  if (level === 'major') return [ma + 1, 0, 0];
  if (level === 'minor') return [ma, mi + 1, 0];
  if (level === 'patch') return [ma, mi, pa + 1];
  return [ma, mi, pa];
}

const tags = git('tag', '--list', 'v*', '--sort=version:refname').split('\n').filter(Boolean);
if (tags.length === 0) {
  process.stderr.write('[version] 仓库尚无 v* tag，无法确定版本基线\n');
  process.exit(1);
}
// 读取当前各包版本，作为增量模式的基线。
function readPkgVersion(pkg) {
  const data = JSON.parse(readFileSync(resolve(root, PKG_FILES[pkg]), 'utf8'));
  return data.version.split('.').map(Number);
}

/** 累加一个区间内的 commits，返回该区间各包升级到的版本。 */
function accumulate(baseVersions, from, to) {
  const version = Object.fromEntries(PKGS.map((p) => [p, [...baseVersions[p]]]));
  const subjects = git('log', '--format=%s', `${from}..${to}`).split('\n').filter(Boolean);
  let rootLevel = 'none';
  for (const s of subjects) {
    const { scope, level } = levelOf(s);
    // 根 = 软件版本，计入所有 feat/fix/refactor/perf/breaking（不分 scope）。
    // 一个版本区间内取最高级别进位一次，与 tag 语义一致（多 fix 只 +1 patch）。
    if (BUMP_RANK[level] > BUMP_RANK[rootLevel]) rootLevel = level;
    const targets = scope ? SCOPE_TO_PKGS[scope] : null;
    if (targets) for (const p of targets) version[p] = bump(version[p], level);
  }
  version.root = bump(version.root, rootLevel);
  return version;
}

let result;
if (all) {
  // 全历史回溯：起点首个 tag=1.0.0，逐区间累加。
  let cur = Object.fromEntries(PKGS.map((p) => [p, [1, 0, 0]]));
  for (let i = 0; i < tags.length - 1; i++) {
    cur = accumulate(cur, tags[i], tags[i + 1]);
  }
  result = accumulate(cur, tags[tags.length - 1], 'HEAD');
} else {
  // 增量：根版本以最近 tag 为基线（版本真源，避免 package.json 快照滞后造成重复发版），
  // 子包以各自 package.json 当前版本为基线，只累加最近 tag..HEAD 的变更。
  const base = Object.fromEntries(PKGS.map((p) => [p, readPkgVersion(p)]));
  const lastTag = tags[tags.length - 1];
  base.root = lastTag.replace(/^v/, '').split('.').map(Number);
  result = accumulate(base, lastTag, 'HEAD');
}

const out = Object.fromEntries(PKGS.map((p) => [p, result[p].join('.')]));
// 强制根版本（软件版本）以用户指定的发布版本为准，子包仍按 scope 自动计算。
if (forcedRoot) out.root = forcedRoot;

if (jsonOnly) {
  process.stdout.write(JSON.stringify(out) + '\n');
} else {
  const mode = all ? '全历史回溯' : `增量（${tags[tags.length - 1]}..HEAD）`;
  process.stdout.write(`[version] ${mode}\n`);
  for (const p of PKGS) process.stdout.write(`  ${p.padEnd(8)} ${out[p]}\n`);
}

if (write) {
  // 写入 5 处 package.json：只改 version 行，保持原有缩进/数组格式不变。
  for (const p of PKGS) {
    const file = resolve(root, PKG_FILES[p]);
    const src = readFileSync(file, 'utf8');
    const updated = replaceVersion(src, out[p]);
    // updated === src 表示已经是目标版本（幂等），不算错误；只有无法匹配才报警。
    if (updated === null) {
      process.stderr.write(`[version] 警告：${PKG_FILES[p]} 未找到 version 字段\n`);
    } else if (updated !== src) {
      writeFileSync(file, updated);
    }
  }
  // 写入 APP_VERSION（根版本 = 软件版本）。
  const cFile = resolve(root, CONSTANTS_FILE);
  const cSrc = readFileSync(cFile, 'utf8');
  const updated = cSrc.replace(
    /export const APP_VERSION = '[^']+';/,
    `export const APP_VERSION = '${out.root}';`,
  );
  if (updated === cSrc && !cSrc.includes(`APP_VERSION = '${out.root}'`)) {
    process.stderr.write('[version] 警告：未匹配到 APP_VERSION，常量未更新\n');
  } else if (updated !== cSrc) {
    writeFileSync(cFile, updated);
  }
  if (!jsonOnly) process.stdout.write('[version] 已写入 package.json（5 处）与 APP_VERSION\n');
}
