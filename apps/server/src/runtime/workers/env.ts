/**
 * Workers 运行时：把平台 `env` 映射成 `loadEnv()` 的覆盖项。
 *
 * 为什么不直接依赖 `process.env`：Worker 里 `process.env` 的填充时机与内容
 * 取决于 compat 版本，而 `env` 对象是平台保证的。这里只挑**字符串型**变量
 * （Durable Object 命名空间、`ASSETS` 绑定等非字符串绑定要排除），
 * 显式传给 `loadEnv()`，避免"某个变量在本地有、上线没有"这类静默差异。
 */
import type { EnvOverrides, OriginScheme } from '../../env';

/** 从平台 `env` 中抽取字符串变量。 */
export function stringVars(env: Record<string, unknown>): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      vars[key] = value;
    }
  }
  return vars;
}

function pick(vars: Record<string, string>, key: string): string | undefined {
  const value: string | undefined = vars[key];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

/**
 * 构造 `loadEnv()` 覆盖项。
 *
 * 目录类变量（DATA_DIR / BACKUP_DIR / TMP_DIR / WEB_DIST_DIR）刻意不映射：
 * Workers 侧既没有持久盘也不从盘上读静态文件，传进来只会让 `loadEnv` 拿
 * 平台路径去做目录校验，制造假配置。
 */
export function workerEnvOverrides(env: Record<string, unknown>): EnvOverrides {
  const vars: Record<string, string> = stringVars(env);
  const scheme: string | undefined = pick(vars, 'ORIGIN_SCHEME');
  return {
    port: pick(vars, 'PORT'),
    publicOrigins: pick(vars, 'PUBLIC_ORIGINS'),
    publicOrigin: pick(vars, 'PUBLIC_ORIGIN'),
    // 前端站点源：Workers 上 SPA 与 API 同源，通常留空；显式映射只是为了
    // 「同一份后端代码」在两种运行时上对同一套变量名有相同语义。
    webOrigin: pick(vars, 'WEB_ORIGIN'),
    tz: pick(vars, 'TZ'),
    originScheme: scheme === undefined ? undefined : (scheme as OriginScheme),
    cookieSecure: pick(vars, 'COOKIE_SECURE'),
    nodeEnv: pick(vars, 'NODE_ENV'),
    // 首次启动播种用的默认公钥（Secret 绑定），仅当库内 backup_keys 为空时使用。
    backupPublicKey: pick(vars, 'BACKUP_PUBLIC_KEY'),
    // 管理员 GitHub OAuth：三项都是 Worker 的 Secret 绑定，必须显式从平台 env
    // 取出并注入；Worker 上 `process.env` 不可靠，漏映射会让管理员登录恒返回「未配置」。
    admin: {
      clientId: pick(vars, 'GITHUB_CLIENT_ID'),
      clientSecret: pick(vars, 'GITHUB_CLIENT_SECRET'),
      logins: pick(vars, 'ADMIN_GITHUB_LOGINS'),
    },
  };
}
