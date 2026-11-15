#!/usr/bin/env node
/**
 * 本地质量闸门：按固定顺序依次执行，任一阶段失败即停止并明确打印失败阶段。
 *
 * 之所以不用 `pnpm run a && pnpm run b` 串起来：
 * 1. 串联脚本失败时只会留下子进程自己的输出，看不出是哪个阶段挂的；
 * 2. pnpm 12 内置了 `pnpm ci`（clean + frozen-lockfile install），
 *    会遮蔽 package.json 里同名的 `ci` 脚本，所以本闸门脚本命名为 `verify`。
 *
 * 用法：pnpm verify
 */
import { spawnSync } from 'node:child_process';

/** 阶段顺序即依赖顺序：先静态检查，再跑用例，最后才打包。 */
const STAGES = [
  { label: 'lint', command: 'pnpm run lint' },
  { label: 'typecheck', command: 'pnpm run typecheck' },
  { label: 'test:coverage', command: 'pnpm run test:coverage' },
  { label: 'build', command: 'pnpm run build' },
];

const total = STAGES.length;

for (let index = 0; index < total; index += 1) {
  const stage = STAGES[index];
  const position = `${index + 1}/${total}`;
  const startedAt = Date.now();

  process.stdout.write(`\n[verify] 阶段 ${position}：${stage.label} 开始\n`);

  const result = spawnSync(stage.command, {
    stdio: 'inherit',
    shell: true,
    env: process.env,
  });

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const exitCode = result.status ?? 1;

  if (exitCode !== 0 || result.error) {
    process.stdout.write(
      `\n[verify] 失败阶段：${stage.label}（${position}，耗时 ${seconds}s，退出码 ${exitCode}）\n`,
    );
    if (result.error) {
      process.stdout.write(`[verify] 无法启动该阶段：${result.error.message}\n`);
    }
    const skipped = STAGES.slice(index + 1).map((item) => item.label);
    process.stdout.write(
      skipped.length > 0
        ? `[verify] 已跳过后续阶段：${skipped.join('、')}\n`
        : '[verify] 无后续阶段\n',
    );
    process.exit(exitCode === 0 ? 1 : exitCode);
  }

  process.stdout.write(`[verify] 阶段 ${position}：${stage.label} 通过（${seconds}s）\n`);
}

process.stdout.write(`\n[verify] 全部 ${total} 个阶段通过\n`);
