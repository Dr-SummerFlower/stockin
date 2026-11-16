#!/usr/bin/env node
/**
 * 校验 CHANGELOG.md 是否由当前 git 历史生成到最新（不修改任何文件）。
 *
 * 用法：pnpm changelog:check
 * 退场码：0 = 最新；1 = 落后，需运行 pnpm changelog。
 *
 * 实现：把 git-cliff 的输出写到临时文件，与仓库中的 CHANGELOG.md 逐字比对。
 * 用 spawnSync 直接调 git-cliff，避免依赖 shell 重定向的跨平台差异。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const changelogPath = join(root, 'CHANGELOG.md');
const configPath = join(root, 'cliff.toml');

const tmp = mkdtempSync(join(tmpdir(), 'stockin-changelog-check-'));
const outPath = join(tmp, 'CHANGELOG.md');

try {
  const result = spawnSync('pnpm', ['exec', 'git-cliff', '--config', configPath, '--output', outPath], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.error) {
    process.stderr.write(`[changelog:check] 无法运行 git-cliff：${result.error.message}\n`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.stderr.write(`[changelog:check] git-cliff 退出码 ${result.status}\n${result.stderr}\n`);
    process.exit(1);
  }

  const generated = readFileSync(outPath, 'utf8');
  let actual;
  try {
    actual = readFileSync(changelogPath, 'utf8');
  } catch {
    process.stderr.write('[changelog:check] CHANGELOG.md 不存在，请运行 pnpm changelog\n');
    process.exit(1);
  }

  // 统一换行后再比对，避免 Windows CRLF 与生成端 LF 的差异误报。
  const normalize = (s) => s.replace(/\r\n/g, '\n');
  if (normalize(generated) !== normalize(actual)) {
    process.stderr.write('[changelog:check] CHANGELOG.md 落后于当前提交，请运行 pnpm changelog 并提交\n');
    process.exit(1);
  }

  process.stdout.write('[changelog:check] CHANGELOG.md 已是最新\n');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
