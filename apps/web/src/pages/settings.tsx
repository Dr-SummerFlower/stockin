/**
 * 设置页：只改临期阈值 `expiryThresholdDays`，并查看备份元数据 / 手动触发备份。
 *
 * 依据：主理人 T04 口径 ⑩「设置页只改阈值」；`GET /api/backups` **仅元数据，
 * 无下载端点**，故本页不提供任何下载动作。备份与导入共用服务端全局信号量。
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Input,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import type { TableProps } from 'antd';
import { EXPIRY_THRESHOLD_MAX, EXPIRY_THRESHOLD_MIN } from '@stockin/shared';
import { useModel } from 'umi';
import { getSettings, updateSettings } from '@/services/api/settings';
import {
  listBackups,
  triggerBackup,
  type BackupMetaView,
} from '@/services/api/backup';
import { errorMessage } from '@/services/request';
import ErrorView from '@/components/ErrorView';
import { formatDateTime } from '@/utils/format';
import { TOUCH_TARGET_MIN_PX } from '@/constants/routes';

const backupColumns: TableProps<BackupMetaView>['columns'] = [
  { title: '文件', dataIndex: 'file', key: 'file', width: 220, ellipsis: true },
  {
    title: '创建时间',
    dataIndex: 'createdAt',
    key: 'createdAt',
    width: 170,
    render: (value: string): React.ReactNode => formatDateTime(value),
  },
  { title: 'schema 版本', dataIndex: 'userVersion', key: 'userVersion', width: 120 },
  {
    title: '校验',
    dataIndex: 'integrity',
    key: 'integrity',
    width: 100,
    render: (value: BackupMetaView['integrity']): React.ReactNode => (
      <Tag color={value === 'ok' ? 'success' : 'error'}>
        {value === 'ok' ? '完整' : '异常'}
      </Tag>
    ),
  },
  {
    title: '基线',
    dataIndex: 'baseline',
    key: 'baseline',
    width: 90,
    render: (value: boolean): React.ReactNode => (value ? '是' : '否'),
  },
  { title: '原因', dataIndex: 'reason', key: 'reason', width: 130 },
  {
    title: '大小（字节）',
    dataIndex: 'sizeBytes',
    key: 'sizeBytes',
    width: 130,
    align: 'right',
  },
];

const SettingsPage: React.FC = () => {
  const { bumpRefresh } = useModel('ui');
  const [threshold, setThreshold] = useState<string>('');
  const [saving, setSaving] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<unknown>(null);
  const [backups, setBackups] = useState<readonly BackupMetaView[]>([]);
  const [keepCount, setKeepCount] = useState<number>(0);
  const [lastBackupAt, setLastBackupAt] = useState<string | null>(null);
  const [backupBusy, setBackupBusy] = useState<boolean>(false);
  const [reloadToken, setReloadToken] = useState<number>(0);

  const load = useCallback((): void => {
    setLoading(true);
    setError(null);
    void Promise.all([getSettings(), listBackups()])
      .then(([settings, list]): void => {
        setThreshold(String(settings.expiryThresholdDays));
        setBackups(list.items);
        setKeepCount(list.keepCount);
        setLastBackupAt(list.lastBackupAt);
      })
      .catch((cause: unknown): void => setError(cause))
      .finally((): void => setLoading(false));
  }, []);

  useEffect((): void => {
    load();
  }, [load, reloadToken]);

  const retry = useCallback((): void => {
    setReloadToken((value: number): number => value + 1);
  }, []);

  const save = async (): Promise<void> => {
    const value: number = Number.parseInt(threshold.trim(), 10);
    if (
      !Number.isInteger(value) ||
      value < EXPIRY_THRESHOLD_MIN ||
      value > EXPIRY_THRESHOLD_MAX
    ) {
      message.warning(
        `阈值须为 ${EXPIRY_THRESHOLD_MIN} ~ ${EXPIRY_THRESHOLD_MAX} 之间的整数`,
      );
      return;
    }
    setSaving(true);
    try {
      await updateSettings({ expiryThresholdDays: value });
      bumpRefresh();
      message.success('临期阈值已保存');
    } catch (cause) {
      message.error(errorMessage(cause, '设置保存失败'));
    } finally {
      setSaving(false);
    }
  };

  const trigger = async (): Promise<void> => {
    setBackupBusy(true);
    try {
      const result = await triggerBackup();
      if (result.status === 'ok') {
        message.success('备份已创建');
      } else {
        message.warning('空间不足或备份被跳过，启动流程未受影响');
      }
      setReloadToken((value: number): number => value + 1);
    } catch (cause) {
      message.error(errorMessage(cause, '备份触发失败'));
    } finally {
      setBackupBusy(false);
    }
  };

  return (
    <div className="stockin-page">
      <div className="stockin-page-head">
        <div>
          <h1 className="stockin-page-title">设置</h1>
          <div className="stockin-page-subtitle">
            仅可修改临期阈值；其余参数为部署期固定配置
          </div>
        </div>
      </div>

      {error !== null ? (
        <ErrorView error={error} onRetry={retry} />
      ) : (
        <>
          <div className="stockin-field-group">
            <div className="stockin-field-group-head">
              <legend className="stockin-field-group-title">临期阈值 X（天）</legend>
            </div>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
              剩余天数 d 满足 0 ≤ d ≤ X 记为临期，d &lt; 0 记为过期；含等号。
              修改后大屏与预警清单按新阈值重算。
            </Typography.Paragraph>
            <Space wrap>
              <Input
                value={threshold}
                inputMode="numeric"
                aria-label="临期阈值天数"
                placeholder={`${EXPIRY_THRESHOLD_MIN} ~ ${EXPIRY_THRESHOLD_MAX}`}
                onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
                  setThreshold(event.target.value)
                }
                style={{ width: 200, minHeight: TOUCH_TARGET_MIN_PX }}
              />
              <Button
                type="primary"
                loading={saving || loading}
                onClick={(): void => {
                  void save();
                }}
                style={{ minHeight: TOUCH_TARGET_MIN_PX }}
              >
                保存
              </Button>
            </Space>
          </div>

          <div className="stockin-field-group">
            <div className="stockin-field-group-head">
              <legend className="stockin-field-group-title">备份（仅元数据）</legend>
              <Button
                loading={backupBusy}
                onClick={(): void => {
                  void trigger();
                }}
                style={{ minHeight: TOUCH_TARGET_MIN_PX }}
              >
                立即备份
              </Button>
            </div>
            <Alert
              type="info"
              showIcon
              message={`保留最近 ${keepCount} 份 · 最近一次：${formatDateTime(lastBackupAt)}`}
              description="备份文件保存在服务端数据卷，接口只返回元数据，不提供下载；空间不足时自动跳过但不影响启动。"
              style={{ marginBottom: 12 }}
            />
            <Table<BackupMetaView>
              rowKey="file"
              size="small"
              loading={loading}
              columns={backupColumns}
              dataSource={backups as BackupMetaView[]}
              pagination={false}
              scroll={{ x: 960 }}
              locale={{ emptyText: '暂无备份' }}
            />
          </div>
        </>
      )}
    </div>
  );
};

export default SettingsPage;
