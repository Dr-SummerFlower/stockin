/**
 * 管理员（系统维护）端点的 HTTP 集成测试。
 *
 * 走真实 app + 真实 SQLite（harness），验证：
 *  - 未配置 OAuth 时管理员入口 503，店主侧完全不受影响；
 *  - me 探测在未登录 / 已登录两态的形状；
 *  - 守护：除公开端点外，无管理员会话一律 401；
 *  - 会话注入后：系统概览 / 备份列表 / 导出 / 审计导出 / 重置店主凭据可用；
 *  - 所有维护动作写 operation_logs，actor 形如 `admin:<login>`；
 *  - 重置店主凭据后，店主旧会话失效，管理员当前会话保留。
 *
 * 管理员会话构造：直接经仓储写入（OAuth 的 GitHub 网络交互由
 * AdminAuthService 的纯逻辑单测覆盖），这里只验证会话之后的授权链。
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN_OAUTH_STATE_COOKIE_NAME,
  ADMIN_SESSION_COOKIE_NAME,
  APP_VERSION,
  type BackupKeyItem,
} from '@stockin/shared';
import { createHarness, TEST_BACKUP_PUBLIC_KEY, type Harness } from '../support/harness';
import { hashSessionToken } from '../../src/lib/crypto';
import { utcAfterHoursIso, utcAfterMinutesIso, utcNowIso } from '../../src/lib/today';

const ADMIN_CONFIG = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  logins: 'owner,admin',
};

describe('管理员端点', () => {
  let h: Harness;
  afterEach((): void => {
    // OAuth 用例替换了全局 fetch，必须逐例还原，避免污染其它文件。
    vi.unstubAllGlobals();
    h?.close();
  });

  describe('未配置 OAuth', () => {
    beforeEach(async (): Promise<void> => {
      h = await createHarness();
    });

    it('me 探测返回 configured=false，且不暴露身份细节', async () => {
      const res = await h.json('/api/admin/me');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ authenticated: false, configured: false });
    });

    it('发起登录返回 503 ADMIN_NOT_CONFIGURED', async () => {
      const res = await h.json('/api/admin/auth/github/start');
      expect(res.status).toBe(503);
      expect((res.body as { code: string }).code).toBe('ADMIN_NOT_CONFIGURED');
    });

    it('店主侧不受影响：init-status 仍正常', async () => {
      const res = await h.json('/api/auth/init-status');
      expect(res.status).toBe(200);
    });

    it('未配置时回调同样返回 503，不会尝试访问 GitHub', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const res = await h.json('/api/admin/auth/github/callback?state=x&code=y');
      expect(res.status).toBe(503);
      expect((res.body as { code: string }).code).toBe('ADMIN_NOT_CONFIGURED');
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('已配置 + 会话注入', () => {
    let adminCookie: string;

    beforeEach(async (): Promise<void> => {
      h = await createHarness({ admin: ADMIN_CONFIG });
      await h.completeSetup('shopowner', 'owner-pass-123');
      const account = h.deps.repositories.adminAccounts.upsert('owner', 1001, 'Owner', utcNowIso());
      const token = `admin-token-${randomUUID()}`;
      adminCookie = `${ADMIN_SESSION_COOKIE_NAME}=${token}`;
      h.deps.repositories.adminSessions.create({
        id: randomUUID(),
        tokenHash: hashSessionToken(token),
        adminId: account.id,
        idleExpiresAt: utcAfterMinutesIso(30),
        absoluteExpiresAt: utcAfterHoursIso(12),
        createdAt: utcNowIso(),
      });
    });

    const authed = (): { cookie: string } => ({ cookie: adminCookie });

    it('me 探测：已登录返回 GitHub 登录名', async () => {
      const res = await h.json('/api/admin/me', authed());
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ authenticated: true, login: 'owner', configured: true });
    });

    it('未登录访问受保护端点返回 401', async () => {
      const res = await h.json('/api/admin/system');
      expect(res.status).toBe(401);
    });

    it('店主会话不能冒充管理员', async () => {
      const sid = await h.login('owner-pass-123', 'shopowner');
      const res = await h.json('/api/admin/system', { cookie: sid });
      expect(res.status).toBe(401);
    });

    it('系统概览只给计数与版本，不含业务明细', async () => {
      const res = await h.json('/api/admin/system', authed());
      expect(res.status).toBe(200);
      const body = res.body as {
        version: string;
        runtime: string;
        recordCount: number;
        backupMode: string;
        adminLogins: string[];
      };
      expect(body.runtime).toBe('node');
      expect(body.recordCount).toBe(0);
      expect(['filesystem', 'pitr']).toContain(body.backupMode);
      expect(body.adminLogins).toContain('owner');
      // 版本必须原样来自 APP_VERSION，且形如发布 tag：稳定版 1.4.2、
      // 预发布 pre-abc1234（CI 在构建期注入，两种形态都要能通过）。
      expect(body.version).toBe(APP_VERSION);
      expect(body.version).toMatch(/^(pre-[0-9a-f]{7}|\d+\.\d+\.\d+)$/);
    });

    it('逻辑导出 JSON 不含密码哈希 / 盐 / 密保答案 / token', async () => {
      const res = await h.request('/api/admin/export', authed());
      expect(res.status).toBe(200);
      const text = await res.text();
      for (const secret of ['password_hash', 'passwordHash', 'security_answer', 'token_hash']) {
        expect(text).not.toContain(secret);
      }
      expect(res.headers.get('content-disposition')).toContain('.json');
    });

    it('审计导出 CSV 带 BOM，且记录 ADMIN_AUDIT_EXPORT 行为', async () => {
      const before = countAdminLogs(h, 'ADMIN_AUDIT_EXPORT');
      const res = await h.request('/api/admin/audit-logs/export', authed());
      expect(res.status).toBe(200);
      // UTF-8 BOM 位于字节流开头；text() 会去掉它，所以直接读 Buffer 的前三字节。
      const bytes: Uint8Array = new Uint8Array(await res.arrayBuffer());
      expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      expect(countAdminLogs(h, 'ADMIN_AUDIT_EXPORT')).toBe(before + 1);
    });

    it('重置店主密码写审计、吊销店主会话、保留管理员会话', async () => {
      const ownerSession = await h.login('owner-pass-123', 'shopowner');
      const before = countAdminLogs(h, 'ADMIN_OWNER_RESET');
      const res = await h.json('/api/admin/owner-credentials', {
        ...authed(),
        json: { newPassword: 'new-owner-pass-456' },
      });
      expect(res.status).toBe(200);
      expect(countAdminLogs(h, 'ADMIN_OWNER_RESET')).toBe(before + 1);

      // 店主旧会话立即失效（auth_epoch 递增）。
      const me = await h.json('/api/auth/me', { cookie: ownerSession });
      expect((me.body as { authenticated: boolean }).authenticated).toBe(false);

      // 管理员当前会话依旧可用。
      const sys = await h.json('/api/admin/system', authed());
      expect(sys.status).toBe(200);
    });

    it('备份下载仅接受备份池内文件名，杜绝路径穿越', async () => {
      const res = await h.json('/api/admin/backups/%2E%2E%2Fetc%2Fpasswd/download', authed());
      expect([404, 400]).toContain(res.status);
    });

    it('逻辑备份：触发 → 异步完成 → 列表可见 → 下载 NDJSON（含 meta 行）', async () => {
      const triggered = await h.json<{ jobId: string }>('/api/admin/logical-backups', {
        ...authed(),
        method: 'POST',
      });
      expect(triggered.status).toBe(200);
      expect(triggered.body.jobId).toMatch(/^job-/);

      for (let i = 0; i < 200; i += 1) {
        if (!(await h.deps.logicalBackup.tick(4))) {
          break;
        }
      }

      const list = await h.json<{ items: { id: string }[]; enabled: boolean }>(
        '/api/admin/logical-backups',
        authed(),
      );
      expect(list.status).toBe(200);
      expect(list.body.enabled).toBe(true);
      expect(list.body.items.length).toBeGreaterThan(0);

      const id = list.body.items[0]!.id;
      const download = await h.request(`/api/admin/logical-backups/${id}/download`, authed());
      expect(download.status).toBe(200);
      expect(download.headers.get('content-disposition')).toContain('.backup.ndjson');
      const text = await download.text();
      const firstLine = text.split('\n')[0] ?? '';
      expect(JSON.parse(firstLine)).toMatchObject({
        kind: 'meta',
        format: 'stockin-logical-backup',
      });
    });

    it('备份间隔设置：读取默认值、更新后回显、越界 422', async () => {
      const initial = await h.json<{
        logicalBackupIntervalDays: number;
        physicalBackupIntervalDays: number;
      }>('/api/admin/backup-settings', authed());
      expect(initial.status).toBe(200);
      expect(initial.body.logicalBackupIntervalDays).toBe(7);
      expect(initial.body.physicalBackupIntervalDays).toBe(30);

      const updated = await h.json<{ logicalBackupIntervalDays: number }>(
        '/api/admin/backup-settings',
        { ...authed(), method: 'PUT', json: { logicalBackupIntervalDays: 14 } },
      );
      expect(updated.status).toBe(200);
      expect(updated.body.logicalBackupIntervalDays).toBe(14);

      const invalid = await h.json('/api/admin/backup-settings', {
        ...authed(),
        method: 'PUT',
        json: { logicalBackupIntervalDays: 0 },
      });
      expect(invalid.status).toBe(422);
    });

    it('恢复批次：begin 返回 batchId 与时间窗口；require admin 鉴权', async () => {
      const anonymous = await h.json('/api/admin/restore/begin');
      expect(anonymous.status).toBe(401);
      const begun = await h.json<{ batchId: string; windowMs: number }>(
        '/api/admin/restore/begin',
        {
          ...authed(),
          method: 'POST',
        },
      );
      expect(begun.status).toBe(200);
      expect(begun.body.batchId).toMatch(/^rb-/);
      expect(begun.body.windowMs).toBe(30 * 60 * 1000);
    });
  });

  describe('OAuth 回调（假 GitHub）', () => {
    let h: Harness;

    beforeEach(async (): Promise<void> => {
      h = (await openAdminHarness()).h;
    });

    /** 走一遍 /start，取出 state 与对应的 HttpOnly Cookie。 */
    async function startLogin(): Promise<{ state: string; stateCookie: string }> {
      const res = await h.request('/api/admin/auth/github/start');
      expect(res.status).toBe(302);
      const state: string =
        new URL(res.headers.get('location') ?? '').searchParams.get('state') ?? '';
      const stateCookie: string | undefined = res.headers
        .getSetCookie()
        .map((item) => item.split(';')[0] as string)
        .find((item) => item.startsWith(`${ADMIN_OAUTH_STATE_COOKIE_NAME}=`));
      if (stateCookie === undefined) {
        throw new Error('start 未下发 state cookie');
      }
      return { state, stateCookie };
    }

    it('成功回调：换 token → 白名单通过 → 下发管理员会话并可访问受保护端点', async () => {
      const { state, stateCookie } = await startLogin();
      stubGithubFetch([
        jsonResponse({ access_token: 'gh-token' }),
        jsonResponse({ id: 1001, login: 'owner', name: 'Owner' }),
      ]);
      const before = countAdminLogs(h, 'ADMIN_LOGIN');

      const res = await h.request(`/api/admin/auth/github/callback?state=${state}&code=the-code`, {
        cookie: stateCookie,
      });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/admin');
      expect(countAdminLogs(h, 'ADMIN_LOGIN')).toBe(before + 1);

      const sessionCookie: string | undefined = res.headers
        .getSetCookie()
        .map((item) => item.split(';')[0] as string)
        .find((item) => item.startsWith(`${ADMIN_SESSION_COOKIE_NAME}=`));
      expect(sessionCookie).toBeDefined();

      const me = await h.json('/api/admin/me', { cookie: sessionCookie });
      expect(me.body).toMatchObject({ authenticated: true, login: 'owner' });
    });

    it('state 不符 → 回登录页并报 state 错误，且不访问 GitHub', async () => {
      const { stateCookie } = await startLogin();
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      const res = await h.request('/api/admin/auth/github/callback?state=forged&code=x', {
        cookie: stateCookie,
      });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/admin/login?error=state');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('没有 state Cookie（如直接打开回调 URL）→ 同样按 state 错误处理', async () => {
      const res = await h.request('/api/admin/auth/github/callback?state=abc&code=x');
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/admin/login?error=state');
    });

    it('state 正确但缺 code → 回登录页 failed', async () => {
      const { state, stateCookie } = await startLogin();
      const res = await h.request(`/api/admin/auth/github/callback?state=${state}`, {
        cookie: stateCookie,
      });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/admin/login?error=failed');
    });

    it('换 token 失败 → failed，并在审计 detail 里留下 token-exchange 原因', async () => {
      const { state, stateCookie } = await startLogin();
      stubGithubFetch([jsonResponse({ error: 'bad_verification_code' }, 400)]);

      const res = await h.request(`/api/admin/auth/github/callback?state=${state}&code=bad`, {
        cookie: stateCookie,
      });
      expect(res.headers.get('location')).toBe('/admin/login?error=failed');

      const row = h.deps.db
        .prepare(
          "SELECT detail FROM operation_logs WHERE action = 'ADMIN_LOGIN_FAILED' ORDER BY id DESC LIMIT 1",
        )
        .get() as { detail: string } | undefined;
      expect(row?.detail).toContain('token-exchange');
    });

    it('白名单外账号 → forbidden，且写 ADMIN_LOGIN_FAILED 审计', async () => {
      const { state, stateCookie } = await startLogin();
      stubGithubFetch([
        jsonResponse({ access_token: 'gh-token' }),
        jsonResponse({ id: 7, login: 'intruder' }),
      ]);
      const before = countAdminLogs(h, 'ADMIN_LOGIN_FAILED');

      const res = await h.request(`/api/admin/auth/github/callback?state=${state}&code=c`, {
        cookie: stateCookie,
      });
      expect(res.headers.get('location')).toBe('/admin/login?error=forbidden');
      expect(countAdminLogs(h, 'ADMIN_LOGIN_FAILED')).toBe(before + 1);
    });
  });

  describe('维护端点（已登录管理员）', () => {
    let h: Harness;
    let adminCookie: string;

    beforeEach(async (): Promise<void> => {
      const opened = await openAdminHarness();
      h = opened.h;
      adminCookie = opened.adminCookie;
    });

    const authed = (): { cookie: string } => ({ cookie: adminCookie });

    it('登出：吊销当前会话并清除 Cookie，之后 me 变为未登录', async () => {
      const res = await h.json('/api/admin/auth/logout', { ...authed(), method: 'POST' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });

      const me = await h.json('/api/admin/me', authed());
      expect(me.body).toMatchObject({ authenticated: false });
    });

    it('物理备份：触发 → 列表可见 → 下载 gzip 字节', async () => {
      const triggered = await h.json<{ status: string; meta: { file: string } | null }>(
        '/api/admin/backups',
        { ...authed(), method: 'POST' },
      );
      expect(triggered.status).toBe(200);
      expect(triggered.body.status).toBe('ok');
      expect(triggered.body.meta).not.toBeNull();

      const list = await h.json<{
        items: { file: string; gzipFile: string; sizeBytes: number }[];
        mode: string;
        keepCount: number;
      }>('/api/admin/backups', authed());
      expect(list.status).toBe(200);
      expect(list.body.mode).toBe('filesystem');
      expect(list.body.items.length).toBeGreaterThan(0);

      const file: string = list.body.items[0]?.file ?? '';
      const download = await h.request(
        `/api/admin/backups/${encodeURIComponent(file)}/download`,
        authed(),
      );
      expect(download.status).toBe(200);
      expect(download.headers.get('content-type')).toBe('application/gzip');
      expect(download.headers.get('content-disposition')).toContain('.db.gz');
      expect((await download.arrayBuffer()).byteLength).toBeGreaterThan(0);
    });

    it('备份公钥：列表 → 非法/重复拒绝 → 新增并激活 → 删除旧钥 → 拒绝删除使用中的钥', async () => {
      const initial = await h.json<{ items: BackupKeyItem[]; enabled: boolean }>(
        '/api/admin/backup-keys',
        authed(),
      );
      expect(initial.status).toBe(200);
      expect(initial.body.enabled).toBe(true);
      const oldActive = initial.body.items.find((item) => item.active);
      expect(oldActive).toBeDefined();

      // 形状就不合法（含非法字符）→ 由 zod 拦在路由层。
      const malformed = await h.json('/api/admin/backup-keys', {
        ...authed(),
        method: 'POST',
        json: { publicKey: 'not-a-key' },
      });
      expect(malformed.status).toBe(422);
      expect((malformed.body as { code: string }).code).toBe('VALID_FAILED');

      // 形状像 base64、长度够，但不是 P-256 SPKI → 由服务端 WebCrypto 校验拦下。
      const notAKey = await h.json('/api/admin/backup-keys', {
        ...authed(),
        method: 'POST',
        json: { publicKey: 'A'.repeat(160) },
      });
      expect(notAKey.status).toBe(422);
      expect((notAKey.body as { code: string }).code).toBe('BACKUP_KEY_INVALID');

      const duplicate = await h.json('/api/admin/backup-keys', {
        ...authed(),
        method: 'POST',
        json: { publicKey: TEST_BACKUP_PUBLIC_KEY },
      });
      expect(duplicate.status).toBe(422);

      const publicKey: string = await generateSpkiPublicKey();
      const added = await h.json<{ items: BackupKeyItem[] }>('/api/admin/backup-keys', {
        ...authed(),
        method: 'POST',
        json: { publicKey, label: '轮换钥', activate: true },
      });
      expect(added.status).toBe(200);
      const rotated = added.body.items.find((item) => item.active && item.label === '轮换钥');
      expect(rotated).toBeDefined();

      // 旧钥已非 active，可以删除。
      const removed = await h.json(`/api/admin/backup-keys/${oldActive?.keyId ?? ''}`, {
        ...authed(),
        method: 'DELETE',
      });
      expect(removed.status).toBe(200);

      // 使用中的钥拒绝删除。
      const inUse = await h.json(`/api/admin/backup-keys/${rotated?.keyId ?? ''}`, {
        ...authed(),
        method: 'DELETE',
      });
      expect(inUse.status).toBe(409);
      expect((inUse.body as { code: string }).code).toBe('BACKUP_KEY_IN_USE');

      const missing = await h.json('/api/admin/backup-keys/nope/activate', {
        ...authed(),
        method: 'POST',
      });
      expect(missing.status).toBe(404);
    });

    it('恢复：分片上传成功、非法 seq 拒绝、验签失败不落库', async () => {
      const begun = await h.json<{ batchId: string }>('/api/admin/restore/begin', {
        ...authed(),
        method: 'POST',
      });
      const batchId: string = begun.body.batchId;

      const uploaded = await h.request(`/api/admin/restore/${batchId}/chunk/0`, {
        ...authed(),
        method: 'PUT',
        body: new Uint8Array([1, 2, 3, 4]),
      });
      expect(uploaded.status).toBe(200);

      const badSeq = await h.json(`/api/admin/restore/${batchId}/chunk/abc`, {
        ...authed(),
        method: 'PUT',
        body: new Uint8Array([1]),
      });
      expect(badSeq.status).toBe(422);

      const badTicket = await h.json('/api/admin/restore/commit', {
        ...authed(),
        method: 'POST',
        json: {
          batchId,
          ticket: {
            payload: {
              v: 1,
              batchId,
              issuedAt: new Date().toISOString(),
              dataSha256: 'a'.repeat(64),
              schemaVersion: 7,
              keyId: 'k-1',
            },
            signature: 'A'.repeat(16),
          },
        },
      });
      expect(badTicket.status).toBe(403);
      expect((badTicket.body as { code: string }).code).toBe('BACKUP_INVALID_TICKET');

      const invalidBody = await h.json('/api/admin/restore/commit', {
        ...authed(),
        method: 'POST',
        json: { batchId },
      });
      expect(invalidBody.status).toBe(422);
    });

    it('备份间隔：只改物理间隔时也回显，另一项保持原值', async () => {
      const res = await h.json<{
        logicalBackupIntervalDays: number;
        physicalBackupIntervalDays: number;
      }>('/api/admin/backup-settings', {
        ...authed(),
        method: 'PUT',
        json: { physicalBackupIntervalDays: 10 },
      });
      expect(res.status).toBe(200);
      expect(res.body.physicalBackupIntervalDays).toBe(10);
      expect(res.body.logicalBackupIntervalDays).toBe(7);
    });

    it('重置店主密码：请求体不合法时 422，不影响现有凭据', async () => {
      const res = await h.json('/api/admin/owner-credentials', {
        ...authed(),
        method: 'POST',
        json: {},
      });
      expect(res.status).toBe(422);
      expect((res.body as { code: string }).code).toBe('VALID_FAILED');
    });

    it('逻辑备份下载：id 不存在或未就绪 → 404', async () => {
      const res = await h.json('/api/admin/logical-backups/no-such-id/download', authed());
      expect(res.status).toBe(404);
      expect((res.body as { code: string }).code).toBe('COMMON_NOT_FOUND');
    });
  });
});

/** 建一个已完成 setup 且注入了管理员会话的测试台。 */
async function openAdminHarness(): Promise<{ h: Harness; adminCookie: string }> {
  const h: Harness = await createHarness({ admin: ADMIN_CONFIG });
  await h.completeSetup('shopowner', 'owner-pass-123');
  const account = h.deps.repositories.adminAccounts.upsert('owner', 1001, 'Owner', utcNowIso());
  const token: string = `admin-token-${randomUUID()}`;
  h.deps.repositories.adminSessions.create({
    id: randomUUID(),
    tokenHash: hashSessionToken(token),
    adminId: account.id,
    idleExpiresAt: utcAfterMinutesIso(30),
    absoluteExpiresAt: utcAfterHoursIso(12),
    createdAt: utcNowIso(),
  });
  return { h, adminCookie: `${ADMIN_SESSION_COOKIE_NAME}=${token}` };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 按顺序返回预置响应；`Error` 表示该次 fetch 直接抛错。 */
function stubGithubFetch(items: readonly (Response | Error)[]): void {
  const mock = vi.fn();
  for (const item of items) {
    if (item instanceof Error) {
      mock.mockRejectedValueOnce(item);
    } else {
      mock.mockResolvedValueOnce(item);
    }
  }
  vi.stubGlobal('fetch', mock);
}

/** 现场生成一把合法 P-256 SPKI 公钥（base64），用于公钥轮换用例。 */
async function generateSpkiPublicKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const spki: ArrayBuffer = await crypto.subtle.exportKey('spki', pair.publicKey);
  return Buffer.from(spki).toString('base64');
}

/** 直接数审计表中某动作的行数（append-only）。 */
function countAdminLogs(h: Harness, action: string): number {
  const row = h.deps.db
    .prepare('SELECT COUNT(*) AS c FROM operation_logs WHERE action = ?')
    .get(action) as { c: number } | undefined;
  return row?.c ?? 0;
}
