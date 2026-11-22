/**
 * 管理员维护台（顶层独立路由，不继承店主导航布局）。
 *
 * 职责边界：只做系统维护——系统概览、备份、数据导出、审计导出、
 * 重置店主凭据。**不读写任何业务记录**，页面里没有记录增删改查入口。
 *
 * 身份：进入时探测 `GET /api/admin/me`；未登录跳 `/admin/login`，
 * 未配置（503）给出明确提示。所有写操作二次确认，结果写入安全审计日志。
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Descriptions,
  Modal,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ImeInput as Input } from '@/components/ImeInput';
import type {
  AdminBackupItem,
  AdminMeResponse,
  AdminSystemResponse,
} from '@stockin/shared';
import { useNavigate } from 'umi';
import {
  downloadAdminBackup,
  exportAdminAudit,
  exportAdminData,
  getAdminMe,
  getAdminSystem,
  listAdminBackups,
  logoutAdmin,
  resetOwnerCredentials,
  triggerAdminBackup,
} from '@/services/api/admin';
import { errorMessage } from '@/services/request';
import {
  describeBackupReason,
  formatBytes,
  formatDateTime,
} from '@/utils/format';
import { ROUTES, TOUCH_TARGET_MIN_PX } from '@/constants/routes';
import EmptyState from '@/components/EmptyState';

const { Title, Text, Paragraph } = Typography;

/** 完整性结果 → 中文；未知值回落中性文案。 */
const INTEGRITY_TEXT: Readonly<Record<string, string>> = {
  ok: '校验通过',
  failed: '校验未通过',
};
function integrityText(value: string): string {
  return INTEGRITY_TEXT[value] ?? '校验结果未知';
}

/** 备份模式 → 中文说明。 */
function modeText(mode: 'filesystem' | 'pitr'): string {
  return mode === 'filesystem' ? '本地文件（可下载）' : '平台托管（PITR，不可下载）';
}

const AdminPage: React.FC = () => {
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();

  const [checking, setChecking] = useState<boolean>(true);
  const [login, setLogin] = useState<string | null>(null);
  const [configured, setConfigured] = useState<boolean>(true);
  const [system, setSystem] = useState<AdminSystemResponse | null>(null);
  const [backups, setBackups] = useState<readonly AdminBackupItem[]>([]);
  const [backupMode, setBackupMode] = useState<'filesystem' | 'pitr'>('pitr');
  const [keepCount, setKeepCount] = useState<number>(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState<boolean>(false);
  const [newPassword, setNewPassword] = useState<string>('');

  const loadSystem = useCallback(async (): Promise<void> => {
    const [sys, list] = await Promise.all([getAdminSystem(), listAdminBackups()]);
    setSystem(sys);
    setBackups(list.items);
    setBackupMode(list.mode);
    setKeepCount(list.keepCount);
  }, []);

  useEffect((): (() => void) => {
    let active = true;
    void (async (): Promise<void> => {
      try {
        const me: AdminMeResponse = await getAdminMe();
        if (!active) return;
        if (!me.authenticated) {
          navigate(ROUTES.adminLogin, { replace: true });
          return;
        }
        setLogin(me.login);
        setConfigured(me.configured);
        await loadSystem();
      } catch {
        // 未配置（503）由 me 的 configured 字段表达；这里只兜底网络异常。
        if (active) {
          setChecking(false);
        }
      } finally {
        if (active) setChecking(false);
      }
    })();
    return (): void => {
      active = false;
    };
  }, [loadSystem, navigate]);

  const doDownload = useCallback(async (task: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(task);
    try {
      await fn();
      message.success('文件已开始下载');
    } catch (cause) {
      message.error(errorMessage(cause, '操作失败'));
    } finally {
      setBusy(null);
    }
  }, [message]);

  const handleBackup = useCallback(async (): Promise<void> => {
    setBusy('backup');
    try {
      const result = await triggerAdminBackup();
      if (result.status === 'skipped') {
        message.info('当前运行时由平台托管，未生成文件快照');
      } else {
        message.success('备份快照已生成');
      }
      await loadSystem();
    } catch (cause) {
      message.error(errorMessage(cause, '生成备份失败'));
    } finally {
      setBusy(null);
    }
  }, [loadSystem, message]);

  const handleLogout = useCallback(async (): Promise<void> => {
    try {
      await logoutAdmin();
    } finally {
      navigate(ROUTES.adminLogin, { replace: true });
    }
  }, [navigate]);

  const handleReset = useCallback(async (): Promise<void> => {
    if (newPassword.trim() === '') {
      message.warning('请输入新密码');
      return;
    }
    setBusy('reset');
    try {
      await resetOwnerCredentials(newPassword);
      setResetOpen(false);
      setNewPassword('');
      message.success('店主密码已重置，原密码立即失效');
    } catch (cause) {
      message.error(errorMessage(cause, '重置失败'));
    } finally {
      setBusy(null);
    }
  }, [message, newPassword]);

  const columns: ColumnsType<AdminBackupItem> = [
    {
      title: '备份文件',
      dataIndex: 'file',
      key: 'file',
      ellipsis: true,
    },
    {
      title: '生成时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (value: string): string => formatDateTime(value),
    },
    {
      title: '大小',
      dataIndex: 'sizeBytes',
      key: 'sizeBytes',
      render: (value: number): string => formatBytes(value),
    },
    {
      title: '完整性',
      dataIndex: 'integrity',
      key: 'integrity',
      render: (value: string): React.ReactNode => (
        <Tag color={value === 'ok' ? 'success' : 'error'}>{integrityText(value)}</Tag>
      ),
    },
    {
      title: '来源',
      dataIndex: 'reason',
      key: 'reason',
      render: (value: string): string => describeBackupReason(value),
    },
    {
      title: '操作',
      key: 'action',
      width: 100,
      render: (_: unknown, record: AdminBackupItem): React.ReactNode =>
        backupMode === 'filesystem' ? (
          <Button
            type="link"
            size="small"
            loading={busy === `dl:${record.file}`}
            onClick={(): void => {
              void doDownload(`dl:${record.file}`, () => downloadAdminBackup(record.file));
            }}
          >
            下载
          </Button>
        ) : (
          <Text type="secondary">平台托管</Text>
        ),
    },
  ];

  if (checking) {
    return <EmptyState title="正在校验管理员身份…" />;
  }

  if (!configured) {
    return (
      <div className="stockin-standalone is-centered">
        <div className="stockin-standalone-card">
          <Title level={4}>管理员登录未配置</Title>
          <Paragraph>
            部署侧尚未设置 GitHub OAuth 凭据。请联系部署者按说明配置后重试。
          </Paragraph>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: '24px 16px 48px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
          marginBottom: 20,
        }}
      >
        <div>
          <Title level={3} style={{ margin: 0 }}>
            系统维护
          </Title>
          <Text type="secondary">当前管理员：{login ?? '—'}</Text>
        </div>
        <Button onClick={(): void => void handleLogout()} style={{ minHeight: TOUCH_TARGET_MIN_PX }}>
          退出登录
        </Button>
      </div>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 20 }}
        message="本页仅用于系统维护，不涉及进货记录。所有维护操作均写入安全审计日志。"
      />

      <Card title="系统概览" style={{ marginBottom: 20 }}>
        {system !== null ? (
          <Descriptions column={{ xs: 1, sm: 2 }} size="small" bordered>
            <Descriptions.Item label="应用版本">{system.version}</Descriptions.Item>
            <Descriptions.Item label="运行时">
              {system.runtime === 'workers' ? 'Cloudflare Workers' : 'Node'}
            </Descriptions.Item>
            <Descriptions.Item label="数据库结构版本">{system.schemaVersion}</Descriptions.Item>
            <Descriptions.Item label="备份模式">{modeText(system.backupMode)}</Descriptions.Item>
            <Descriptions.Item label="有效记录">{system.recordCount}</Descriptions.Item>
            <Descriptions.Item label="回收站记录">{system.trashCount}</Descriptions.Item>
            <Descriptions.Item label="审计日志条数">{system.logCount}</Descriptions.Item>
            <Descriptions.Item label="备份保留份数">{keepCount}</Descriptions.Item>
          </Descriptions>
        ) : (
          <Text type="secondary">概览加载失败，请刷新重试。</Text>
        )}
      </Card>

      <Card
        title="备份管理"
        style={{ marginBottom: 20 }}
        extra={
          <Button
            type="primary"
            loading={busy === 'backup'}
            onClick={(): void => void handleBackup()}
            style={{ minHeight: TOUCH_TARGET_MIN_PX }}
          >
            立即备份
          </Button>
        }
      >
        <Paragraph type="secondary">
          备份池保留最近 {keepCount} 份。{modeText(backupMode)}。
        </Paragraph>
        <Table
          rowKey="file"
          size="small"
          dataSource={backups}
          columns={columns}
          pagination={false}
          locale={{ emptyText: '暂无备份' }}
        />
      </Card>

      <Card title="数据导出" style={{ marginBottom: 20 }}>
        <Paragraph type="secondary">
          导出业务数据与审计日志。数据导出不包含密码哈希、盐、密保答案与会话凭据。
        </Paragraph>
        <Space wrap>
          <Button
            loading={busy === 'export-data'}
            onClick={(): void => {
              void doDownload('export-data', exportAdminData);
            }}
            style={{ minHeight: TOUCH_TARGET_MIN_PX }}
          >
            导出全部数据（JSON）
          </Button>
          <Button
            loading={busy === 'export-audit'}
            onClick={(): void => {
              void doDownload('export-audit', exportAdminAudit);
            }}
            style={{ minHeight: TOUCH_TARGET_MIN_PX }}
          >
            导出审计日志（CSV）
          </Button>
        </Space>
      </Card>

      <Card title="店主凭据">
        <Paragraph type="secondary">
          忘记店主密码时可在此重置。重置后原密码与所有店主会话立即失效。
        </Paragraph>
        <Button
          danger
          onClick={(): void => setResetOpen(true)}
          style={{ minHeight: TOUCH_TARGET_MIN_PX }}
        >
          重置店主密码
        </Button>
      </Card>

      <Modal
        title="重置店主密码"
        open={resetOpen}
        onCancel={(): void => {
          setResetOpen(false);
          setNewPassword('');
        }}
        onOk={(): void => {
          void handleReset();
        }}
        okText="确认重置"
        cancelText="取消"
        okButtonProps={{ loading: busy === 'reset', danger: true }}
      >
        <Paragraph>请输入新的店主密码。此操作立即生效并吊销全部店主会话。</Paragraph>
        <Input.Password
          value={newPassword}
          onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
            setNewPassword(event.target.value)
          }
          placeholder="请输入新密码"
          autoComplete="new-password"
          maxLength={256}
        />
      </Modal>
    </div>
  );
};

export default AdminPage;
