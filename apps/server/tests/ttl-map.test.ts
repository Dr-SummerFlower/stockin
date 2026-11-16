/**
 * 内存 TTL 表的纯逻辑测试（发布审查 P2-1）。
 *
 * 这张表存在的唯一理由就是「不让裸 Map 无限增长」，所以测试重点不是取存，
 * 而是**写入顺带清理过期项**这条不变量：只要写入就会 sweep，
 * 表大小就以一个 TTL 窗口内的活跃键数为上界。
 */
import { describe, expect, it } from 'vitest';
import { TtlMap } from '../src/lib/ttl-map';

describe('TtlMap', () => {
  it('未过期可读、过期视为不存在（但不主动删除）', () => {
    const map = new TtlMap<number>();
    map.set('a', 1, 100, 10);
    expect(map.get('a', 50)).toBe(1);
    expect(map.get('a', 100)).toBeUndefined();
    // 过期项仍在，等 sweep 收走 —— 读路径不写，避免「读」变成隐式写。
    expect(map.size).toBe(1);
    expect(map.get('missing', 50)).toBeUndefined();
  });

  it('写入时清理过期项，键数上界≈一个窗口内的活跃键数', () => {
    const map = new TtlMap<number>();
    for (let i = 0; i < 100; i += 1) {
      map.set(`k${i}`, i, 100, 0);
    }
    expect(map.size).toBe(100);
    // 窗口过后再写一个键：旧的 100 个过期项应全部被扫掉。
    map.set('fresh', 1, 1_000, 100);
    expect(map.size).toBe(1);
    expect(map.get('fresh', 100)).toBe(1);
  });

  it('sweep 返回删除条数，且只删已过期的', () => {
    const map = new TtlMap<string>();
    map.set('a', 'A', 10, 0);
    map.set('b', 'B', 100, 0);
    expect(map.sweep(10)).toBe(1);
    expect(map.size).toBe(1);
    expect(map.get('b', 10)).toBe('B');
    expect(map.sweep(10)).toBe(0);
  });

  it('delete / clear 生效', () => {
    const map = new TtlMap<number>();
    map.set('a', 1, 100, 0);
    map.set('b', 2, 100, 0);
    map.delete('a');
    expect(map.size).toBe(1);
    map.clear();
    expect(map.size).toBe(0);
  });

  it('覆盖同一键后取到新值（幂等键复用场景）', () => {
    const map = new TtlMap<number>();
    map.set('k', 1, 100, 0);
    map.set('k', 2, 200, 0);
    expect(map.get('k', 0)).toBe(2);
    expect(map.size).toBe(1);
  });
});
