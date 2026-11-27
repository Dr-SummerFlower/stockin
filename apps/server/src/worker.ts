/**
 * Cloudflare Workers 组合根。
 *
 * 结构：
 *   Worker.default.fetch     → 转给**唯一的** Durable Object（单租户，固定名 `main`）
 *   Worker.default.scheduled → 打 DO 的内部路径，执行"每日备份"动作
 *   StockinDurableObject     → 首次请求时 `bootstrap()` + `assemble()`，之后复用
 *
 * 为什么把应用整个塞进 DO 而不是直接在 Worker fetch 里跑：
 *  ① DO 的 SQLite 存储是**同步** API，与 `DbPort` 的同步契约天然对齐；
 *     Worker 本身没有数据库，D1 那个异步且无交互事务的后端与 28 条 Must 冲突。
 *  ② DO 单实例串行执行，天然满足"单进程单写者"这一前提 —— 事务窗口内不会
 *     被别的请求切走（这正是 `db.port.ts` 坚持同步的原因）。
 *
 * 两条 workerd 的硬约束（踩过才知道）：
 *  - DO 类必须 `extends DurableObject`（来自 `cloudflare:workers`），
 *    否则 bindings 里的 `class_name` 绑不上，运行期调用必失败；
 *  - 入口模块的**具名导出只能是类或 ExportedHandler**。内部路径常量因此
 *    放在 `runtime/workers/internal.ts`，不从这里导出。
 *
 * 与 Node 侧唯一的功能差异是备份：DO 无文件系统，`BackupPort` 走 PITR，
 * `create()` 明确返回 skipped 而不是假成功。
 */
import { DurableObject } from 'cloudflare:workers';
import { bootstrap } from './bootstrap';
import { assemble, type AssembledRuntime } from './assembly';
import { logger } from './lib/logger';
import { workerEnvOverrides } from './runtime/workers/env';
import { INTERNAL_PATH_PREFIX, INTERNAL_SCHEDULED_PATH } from './runtime/workers/internal';
import { workersRuntime, type AssetsBinding } from './runtime/workers';

/** 单租户实例名：个体商家自用，全库只有一个 DO。 */
const DO_INSTANCE_NAME = 'main';

/** DO 命名空间的最小结构（官方 `DurableObjectNamespace` 子集）。 */
interface DurableObjectIdLike {
  toString(): string;
}

interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): DurableObjectIdLike;
  get(id: DurableObjectIdLike): DurableObjectStubLike;
}

/** 执行上下文（`scheduled` 的第三参）。 */
export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

/** Worker 的 `env`：平台变量 + 两个绑定。 */
export interface WorkerEnv {
  readonly STOCKIN_DO: DurableObjectNamespaceLike;
  readonly ASSETS: AssetsBinding;
  readonly [key: string]: unknown;
}

/** 取单例 stub。 */
function singleStub(env: WorkerEnv): DurableObjectStubLike {
  return env.STOCKIN_DO.get(env.STOCKIN_DO.idFromName(DO_INSTANCE_NAME));
}

/**
 * 应用所在的 Durable Object。
 *
 * 初始化采用 Promise 记忆化：同一实例上的并发请求共享同一次
 * `bootstrap()`，不会重复跑迁移或重复打印首启凭据。
 */
export class StockinDurableObject extends DurableObject<WorkerEnv> {
  private runtime: Promise<AssembledRuntime> | null = null;

  /** DO alarm 回调：驱动逻辑备份 / 恢复的异步状态机。 */
  async alarm(): Promise<void> {
    const runtime: AssembledRuntime = await this.ensureRuntime();
    await runtime.deps.backupKeys.ensureSeeded();
    // 必须走 alarm 专用入口：它会清空调度器的合并守卫，多 chunk 备份才能续调度。
    await runtime.runAlarmTick();
  }

  async fetch(request: Request): Promise<Response> {
    const runtime: AssembledRuntime = await this.ensureRuntime();
    // AUDIT-12：bootstrap 的播种只在 DO 首次构造时跑一次；CI 的 `secret put` 晚于
    // deploy，Secret 到达时实例可能已初始化，导致管理台一直显示「无公钥」。
    // 每个请求幂等补一次：库内已有公钥时只是一次极快的 COUNT 查询，不覆盖面板改动。
    await runtime.deps.backupKeys.ensureSeeded();
    const path: string = new URL(request.url).pathname;
    if (path === INTERNAL_SCHEDULED_PATH) {
      await runtime.runScheduledBackup();
      return new Response(null, { status: 204 });
    }
    // 第二个参数给空对象：Worker 上没有 `incoming.socket`，
    // 中间件会回落到 `cf-connecting-ip`（见 `clientIpOf`）。
    return runtime.app.fetch(request, {});
  }

  private ensureRuntime(): Promise<AssembledRuntime> {
    if (this.runtime !== null) {
      return this.runtime;
    }
    const created: Promise<AssembledRuntime> = this.build();
    this.runtime = created.catch((error: unknown) => {
      // 初始化失败不缓存：让下一次请求重试，而不是把实例永久钉在失败态。
      this.runtime = null;
      throw error;
    });
    return this.runtime;
  }

  private async build(): Promise<AssembledRuntime> {
    const vars: Record<string, unknown> = this.env;
    const bundle = workersRuntime({
      storage: this.ctx.storage,
      assets: this.env.ASSETS,
      vars,
      // 恢复批次的一次性消费必须原子：get→put 之间不能被并发请求插入。
      // 直接用 DO 输入门（blockConcurrencyWhile）串行化这段关键区。
      runExclusive: <T>(fn: () => Promise<T>): Promise<T> => this.ctx.blockConcurrencyWhile(fn),
    });
    const boot = await bootstrap({ bundle, overrides: workerEnvOverrides(vars) });
    const runtime: AssembledRuntime = assemble({
      db: boot.db,
      env: boot.env,
      repositories: boot.repositories,
      ports: boot.ports,
      platform: bundle.platform,
    });
    runtime.start();
    logger.info(
      {
        runtime: bundle.platform.target,
        userVersion: boot.migration.toVersion,
        applied: boot.migration.applied,
      },
      '[worker] Durable Object 初始化完成',
    );
    return runtime;
  }
}

/** Worker 入口。 */
export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    // 内部路径不对外暴露：否则任何人都能触发备份（写操作 + 信号量占用）。
    if (new URL(request.url).pathname.startsWith(INTERNAL_PATH_PREFIX)) {
      return new Response('Not Found', { status: 404 });
    }
    return singleStub(env).fetch(request);
  },

  async scheduled(_event: unknown, env: WorkerEnv, ctx: ExecutionContextLike): Promise<void> {
    const stub: DurableObjectStubLike = singleStub(env);
    const run = async (): Promise<void> => {
      const response: Response = await stub.fetch(
        new Request(`https://do.internal${INTERNAL_SCHEDULED_PATH}`, { method: 'POST' }),
      );
      if (!response.ok) {
        logger.warn({ status: response.status }, '[worker] 定时备份未成功');
      }
    };
    const running: Promise<void> = run();
    ctx.waitUntil(running);
    await running;
  },
};
