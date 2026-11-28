/**
 * 环境解析的 fail-fast 契约。
 *
 * 这些分支平时不触发，但它们是 CSRF 可信来源白名单、Cookie `Secure` 属性与
 * 「三卷不得落在静态托管根」三条安全约束的唯一入口：一旦放宽而不自知，
 * 配置错误会变成静默的安全降级，而不是启动失败。故逐条钉住。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isUnderDirectory, loadEnv, resolveOriginScheme } from '../src/env';

/** 默认来源：两种回环写法 + [::1] 展开，首项作为主来源。 */
describe('可信来源解析', () => {
  it('未配置时默认同时含 127.0.0.1 / localhost / [::1]，主来源为首项', () => {
    const env = loadEnv({ port: 8080, publicOrigins: '', publicOrigin: '' });

    expect(env.publicOrigin).toBe('http://127.0.0.1:8080');
    expect(env.publicOrigins).toEqual([
      'http://127.0.0.1:8080',
      'http://localhost:8080',
      'http://[::1]:8080',
    ]);
  });

  it('多来源逗号分隔，回环写法自动等价展开且去重', () => {
    const env = loadEnv({
      port: 8080,
      publicOrigins: ' http://127.0.0.1:8080 , http://192.168.1.5:8080 ',
    });

    expect(env.publicOrigins).toContain('http://192.168.1.5:8080');
    expect(env.publicOrigins).toContain('http://localhost:8080');
    // 展开只补缺，不重复追加。
    expect(env.publicOrigins.filter((item) => item === 'http://127.0.0.1:8080')).toHaveLength(1);
  });

  it('旧写法 PUBLIC_ORIGIN（单值）仍生效；非回环主机不自动扩展', () => {
    const env = loadEnv({ port: 8080, publicOrigins: '', publicOrigin: 'http://192.168.1.5:8080' });

    expect(env.publicOrigins).toEqual(['http://192.168.1.5:8080']);
  });

  it('https 可省略端口（隐式 443），并推导出 Secure Cookie', () => {
    const env = loadEnv({ port: 8080, originScheme: 'https', publicOrigins: 'https://a.example' });

    expect(env.publicOrigins).toEqual(['https://a.example']);
    expect(env.cookieSecure).toBe(true);
  });

  it('https 显式写 443 或 PORT 都接受（本地 wrangler dev 用后者）', () => {
    expect(
      loadEnv({ port: 8080, originScheme: 'https', publicOrigins: 'https://a.example:443' })
        .publicOrigins,
    ).toEqual(['https://a.example:443']);
    expect(
      loadEnv({ port: 8080, originScheme: 'https', publicOrigins: 'https://a.example:8080' })
        .publicOrigins,
    ).toEqual(['https://a.example:8080']);
  });

  it('https 写了其它端口直接报错，不静默忽略', () => {
    expect(() =>
      loadEnv({ port: 8080, originScheme: 'https', publicOrigins: 'https://a.example:8443' }),
    ).toThrow(/443 或 PORT/);
  });

  it('http 来源必须写端口，且必须与 PORT 一致', () => {
    expect(() => loadEnv({ port: 8080, publicOrigins: 'http://127.0.0.1' })).toThrow(
      /必须写明端口/,
    );
    expect(() => loadEnv({ port: 8080, publicOrigins: 'http://127.0.0.1:9090' })).toThrow(
      /必须与 PORT/,
    );
  });

  it('来源必须是字面量：带路径或查询串直接报错', () => {
    expect(() => loadEnv({ port: 8080, publicOrigins: 'http://127.0.0.1:8080/app' })).toThrow(
      /字面量/,
    );
  });

  it('来源 scheme 与 ORIGIN_SCHEME 不一致时报错', () => {
    expect(() =>
      loadEnv({ port: 8080, originScheme: 'http', publicOrigins: 'https://127.0.0.1:8080' }),
    ).toThrow(/不一致/);
  });
});

describe('PORT 与 ORIGIN_SCHEME 解析', () => {
  it('空值取默认端口，合法值原样保留', () => {
    expect(loadEnv({ port: '' }).port).toBe(8080);
    expect(loadEnv({ port: '3000' }).port).toBe(3000);
  });

  it('越界或非整数端口直接报错', () => {
    expect(() => loadEnv({ port: 0 })).toThrow(/1~65535/);
    expect(() => loadEnv({ port: 70_000 })).toThrow(/1~65535/);
    expect(() => loadEnv({ port: 'abc' })).toThrow(/1~65535/);
  });

  it('scheme 空串等同 http，https 原样返回，其它值报错', () => {
    expect(resolveOriginScheme('')).toBe('http');
    expect(resolveOriginScheme('https')).toBe('https');
    expect(() => resolveOriginScheme('ftp')).toThrow(/http 或 https/);
  });
});

describe('COOKIE_SECURE 与来源 scheme 的一致性', () => {
  it('https 下 true/1 合法，显式声明与推导一致', () => {
    const env = loadEnv({
      port: 8080,
      originScheme: 'https',
      publicOrigins: 'https://a.example',
      cookieSecure: 'true',
    });
    expect(env.cookieSecure).toBe(true);
  });

  it('http 下 false/0 合法；非布尔取值报错', () => {
    const env = loadEnv({ port: 8080, publicOrigins: '', cookieSecure: 'false' });
    expect(env.cookieSecure).toBe(false);
    expect(() => loadEnv({ port: 8080, publicOrigins: '', cookieSecure: 'yes' })).toThrow(
      /只能是 true \/ false/,
    );
  });

  it('与 scheme 冲突时启动失败，而不是静默纠正', () => {
    expect(() => loadEnv({ port: 8080, publicOrigins: '', cookieSecure: 'true' })).toThrow(
      /不匹配/,
    );
    expect(() =>
      loadEnv({
        port: 8080,
        originScheme: 'https',
        publicOrigins: 'https://a.example',
        cookieSecure: 'false',
      }),
    ).toThrow(/不匹配/);
  });
});

describe('目录归属与卷安全', () => {
  it('三卷落入静态托管根之下时拒绝启动', () => {
    const staticRoot: string = path.resolve('web');
    expect(() => loadEnv({ staticRoot, dataDir: path.join(staticRoot, 'data') })).toThrow(
      /不得位于静态托管根之下/,
    );
  });

  it('TZ 不能为空', () => {
    expect(() => loadEnv({ tz: '   ' })).toThrow(/TZ 不能为空/);
  });

  it('isUnderDirectory：自身算在目录内，前缀相同的兄弟目录不算', () => {
    const parent: string = path.resolve('data');
    expect(isUnderDirectory(parent, parent)).toBe(true);
    expect(isUnderDirectory(path.join(parent, 'sub'), parent)).toBe(true);
    // 仅前缀相同（data-extra）不能被误判为 data 的子目录。
    expect(isUnderDirectory(path.resolve('data-extra'), parent)).toBe(false);
  });
});
