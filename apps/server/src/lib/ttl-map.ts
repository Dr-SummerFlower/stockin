/**
 * 带过期时间的键值表（单进程内存）。
 *
 * 用途：登录失败计数桶、记录保存的幂等键快照 —— 两者都是「写过一次、
 * 过期后没有别的入口再来访问」的短生命周期数据。
 *
 * 为什么不用裸 `Map`：裸 `Map` 只有写入路径，过期条目永远不会被删除，
 * 长跑进程（容器常驻、Worker DO 常驻）里就是慢性内存泄漏。这里把
 * 「写入顺带清理」固化成唯一入口 —— 任何 `set()` 都会先扫一遍过期项，
 * 因此表大小上界 ≈ 一个 TTL 窗口内的活跃键数，而不是历史键数。
 *
 * 单商家自用场景下活跃键数是个位数，全量扫描的代价可以忽略；
 * 若将来键数上万，把 `sweep()` 改成按时间轮分批清理即可，调用方不用动。
 */
export interface TtlEntry<V> {
  readonly value: V;
  /** Unix 秒（或毫秒，只要与调用方同一口径）；`<= now` 即视为过期。 */
  readonly expiresAt: number;
}

/** 构造内存 TTL 表。 */
export class TtlMap<V> {
  private readonly entries: Map<string, TtlEntry<V>> = new Map<string, TtlEntry<V>>();

  /** 当前条目数（含尚未清理的过期项，仅供测试与观测）。 */
  get size(): number {
    return this.entries.size;
  }

  /** 读取未过期的值；已过期返回 `undefined`（不删除，交给 `sweep()`）。 */
  get(key: string, now: number): V | undefined {
    const entry: TtlEntry<V> | undefined = this.entries.get(key);
    if (entry === undefined || entry.expiresAt <= now) {
      return undefined;
    }
    return entry.value;
  }

  /**
   * 写入并顺带清理过期项。
   *
   * 清理放在写入路径上，是为了让「只写不读」的键（例如攻击者不停换 IP
   * 打登录接口）也受 TTL 约束：不写入就不会增长，写入就会清理。
   */
  set(key: string, value: V, expiresAt: number, now: number): void {
    this.sweep(now);
    this.entries.set(key, { value, expiresAt });
  }

  /** 删除单个键。 */
  delete(key: string): void {
    this.entries.delete(key);
  }

  /** 清空（仅测试与重置场景使用）。 */
  clear(): void {
    this.entries.clear();
  }

  /** 删除所有 `expiresAt <= now` 的条目，返回删除条数。 */
  sweep(now: number): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}
