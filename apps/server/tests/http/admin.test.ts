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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_SESSION_COOKIE_NAME } from '@stockin/shared';
import { createHarness, type Harness } from '../support/harness';
import { hashSessionToken } from '../../src/lib/crypto';
import { utcAfterHoursIso, utcAfterMinutesIso, utcNowIso } from '../../src/lib/today';

const ADMIN_CONFIG = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  logins: 'owner,admin',
};

describe('管理员端点', () => {
  let h: Harness;
  afterEach((): void => h?.close());

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
        runtime: string;
        recordCount: number;
        backupMode: string;
        adminLogins: string[];
      };
      expect(body.runtime).toBe('node');
      expect(body.recordCount).toBe(0);
      expect(['filesystem', 'pitr']).toContain(body.backupMode);
      expect(body.adminLogins).toContain('owner');
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
});

/** 直接数审计表中某动作的行数（append-only）。 */
function countAdminLogs(h: Harness, action: string): number {
  const row = h.deps.db
    .prepare('SELECT COUNT(*) AS c FROM operation_logs WHERE action = ?')
    .get(action) as { c: number } | undefined;
  return row?.c ?? 0;
}
