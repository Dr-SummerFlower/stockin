/**
 * 设置页：外观主题、临期阈值、备份记录。
 *
 * 展示口径：阈值的判定口径只在分区标题旁的说明面板里交代一次（唯一真源），
 * 其余位置只显示当前值；备份区仅展示元数据与「立即备份」，不出现下载动作。
 * 工程排查信息统一收进技术信息折叠区，配中文标签、用途说明与完整值展示。
 * 服务端内部标记一律映射为中文，未知值回落中性文案。文案保持中性书面语。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, App as AntdApp, Button, Input, Table, Tag } from 'antd';
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
import TechnicalInfo, { type TechnicalField } from '@/components/TechnicalInfo';
import EmptyState from '@/components/EmptyState';
import ErrorView from '@/components/ErrorView';
import Icon, { type IconName } from '@/components/Icon';
import InfoTip from '@/components/InfoTip';
import {
  describeBackupReason,
  formatBytes,
  formatDateTime,
  formatRelativeDateTime,
} from '@/utils/format';
import { THEME_MODE_OPTIONS, type ThemeMode } from '@/utils/theme';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { TOUCH_TARGET_MIN_PX } from '@/constants/routes';

/** 三态主题对应的装饰图标。 */
const THEME_ICONS: Readonly<Record<ThemeMode, IconName>> = {
  light: 'sun',
  dark: 'moon',
  system: 'monitor',
};

/** 完整性结果：服务端标记 → 中文；未知值回落中性文案。 */
const INTEGRITY_TEXT: Readonly<Record<string, string>> = {
  ok: '校验通过',
  failed: '校验未通过',
};

function integrityText(integrity: string): string {
  return INTEGRITY_TEXT[integrity] ?? '校验结果未知';
}

/** 账号初始化状态：服务端标记 → 中文；未知值回落中性文案。 */
const INIT_STATE_TEXT: Readonly<Record<number, string>> = {
  0: '未完成',
  1: '已完成',
};

function initStateText(state: number): string {
  return INIT_STATE_TEXT[state] ?? '状态未知';
}

/** 是否为基准备份：布尔标记 → 中文；异常值回落中性文案。 */
function baselineText(baseline: unknown): string {
  if (baseline === true) return '是';
  if (baseline === false) return '否';
  return '未标注';
}

/** 展开区：元数据换中文标签 + 用途说明，完整值直接展示，不截断、不设复制入口。 */
function buildBackupFields(record: BackupMetaView): readonly TechnicalField[] {
  return [
    {
      label: '原始文件名',
      value: record.file,
      hint: '服务器上备份文件的名称',
      mono: true,
    },
    {
      label: '压缩包文件名',
      value: record.gzipFile === '' ? '—' : record.gzipFile,
      hint: '压缩后的备份文件名',
      mono: true,
    },
    {
      label: '数据校验码',
      value: record.sha256 === '' ? '—' : record.sha256,
      hint: '用于校验备份文件是否被改动',
      mono: true,
    },
    {
      label: '文件格式标识',
      value: record.magic === '' ? '—' : record.magic,
      hint: '用于标识本系统生成的备份文件',
    },
    {
      label: '数据库结构版本',
      value: String(record.userVersion),
      hint: '备份时的数据结构版本，恢复时需匹配',
      mono: true,
    },
    {
      label: '账号设置状态',
      value: initStateText(record.initState),
      hint: '备份时的账号初始化状态',
    },
    {
      label: '基准备份',
      value: baselineText(record.baseline),
      hint: '首次账号设置完成后建立的基础快照',
    },
    {
      label: '触发方式',
      value: describeBackupReason(record.reason),
      hint: '本次备份由何种操作触发',
    },
    {
      label: '校验结果',
      value: integrityText(record.integrity),
      hint: '备份文件的完整性校验结果',
    },
  ];
}

/** 展开区与手机卡片共用同一份技术信息。 */
const BackupTechnicalInfo: React.FC<{ readonly record: BackupMetaView }> = ({
  record,
}) => (
  <div className="stockin-expand-row">
    <TechnicalInfo fields={buildBackupFields(record)} />
  </div>
);

/** 完整性标签：颜色 + 文字双通道，未知值用中性色。 */
function integrityTag(value: string): React.ReactNode {
  const color = value === 'ok' ? 'success' : value === 'failed' ? 'error' : 'default';
  return <Tag color={color}>{integrityText(value)}</Tag>;
}

/** 备份主表 4 列：备份时间 / 触发方式 / 大小 / 状态。 */
const backupColumns: TableProps<BackupMetaView>['columns'] = [
  {
    title: '备份时间（北京时间）',
    dataIndex: 'createdAt',
    key: 'createdAt',
    width: 200,
    render: (value: string): React.ReactNode => (
      <div>
        <div>{formatRelativeDateTime(value)}</div>
        <div style={{ fontSize: 12, color: 'var(--stockin-color-muted)' }}>
          {formatDateTime(value)}
        </div>
      </div>
    ),
  },
  {
    title: '触发方式',
    dataIndex: 'reason',
    key: 'reason',
    width: 180,
    render: (value: string): React.ReactNode => describeBackupReason(value),
  },
  {
    title: '大小',
    dataIndex: 'sizeBytes',
    key: 'sizeBytes',
    width: 120,
    align: 'right',
    render: (value: number): React.ReactNode => formatBytes(value),
  },
  {
    title: '状态',
    dataIndex: 'integrity',
    key: 'integrity',
    width: 120,
    render: (value: string): React.ReactNode => integrityTag(value),
  },
];

/** 手机档单张备份卡片：时间 / 触发方式 / 大小 / 状态，展开看技术信息。 */
const BackupCard: React.FC<{ readonly record: BackupMetaView }> = ({ record }) => {
  const [expanded, setExpanded] = useState<boolean>(false);
  return (
    <div className="stockin-simple-card">
      <div className="stockin-simple-card-head">
        <span>{formatRelativeDateTime(record.createdAt)}</span>
        {integrityTag(record.integrity)}
      </div>
      <div className="stockin-simple-card-value">{formatBytes(record.sizeBytes)}</div>
      <div className="stockin-simple-card-meta">
        {describeBackupReason(record.reason)} · {formatDateTime(record.createdAt)}
      </div>
      <Button
        type="link"
        onClick={(): void => setExpanded((value: boolean): boolean => !value)}
        style={{ minHeight: TOUCH_TARGET_MIN_PX, paddingLeft: 0 }}
      >
        {expanded ? '收起技术信息' : '查看技术信息'}
      </Button>
      {expanded ? <BackupTechnicalInfo record={record} /> : null}
    </div>
  );
};

/** 手机首屏骨架：避免加载中的空 items 被误显示成空态。 */
const SkeletonCards: React.FC = () => (
  <div className="stockin-card-list">
    {[0, 1, 2].map((key: number) => (
      <div key={key} className="stockin-skeleton-card" />
    ))}
  </div>
);

const SettingsPage: React.FC = () => {
  const { bumpRefresh } = useModel('ui');
  const { message } = AntdApp.useApp();
  const { mode, setMode } = useModel('theme');
  const { useCardList } = useBreakpoint();
  const [threshold, setThreshold] = useState<string>('');
  const [thresholdError, setThresholdError] = useState<string | null>(null);
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

  // 唯一的重试入口：ErrorView 与手动刷新共用，避免多处各自维护刷新逻辑。
  const retry = useCallback((): void => {
    setReloadToken((value: number): number => value + 1);
  }, []);

  const save = async (): Promise<void> => {
    // 严格整数校验：`parseInt('12abc')` 会被当成 12，后端要求 z.number().int()。
    // 两个分支合并为同一句：它是取值范围在界面上唯一的出口。
    const raw: string = threshold.trim();
    const rangeError = `临期阈值需为 ${EXPIRY_THRESHOLD_MIN} 至 ${EXPIRY_THRESHOLD_MAX} 之间的整数`;
    if (!/^\d+$/.test(raw)) {
      setThresholdError(rangeError);
      return;
    }
    const value: number = Number(raw);
    if (value < EXPIRY_THRESHOLD_MIN || value > EXPIRY_THRESHOLD_MAX) {
      setThresholdError(rangeError);
      return;
    }
    setThresholdError(null);
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
        message.warning('磁盘空间不足，本次备份已跳过');
      }
      setReloadToken((value: number): number => value + 1);
    } catch (cause) {
      message.error(errorMessage(cause, '备份失败'));
    } finally {
      setBackupBusy(false);
    }
  };

  const failedCount: number = backups.filter(
    (record: BackupMetaView): boolean => record.integrity !== 'ok',
  ).length;

  return (
    <div className="stockin-page">
      <div className="stockin-page-head">
        <h1 className="stockin-page-title">设置</h1>
      </div>

      {error !== null ? (
        <ErrorView error={error} onRetry={retry} />
      ) : (
        <div className="stockin-stack">
          <section className="stockin-panel">
            <div className="stockin-panel-head">
              <h2 className="stockin-panel-title">
                <Icon name="palette" size="sm" />
                外观
              </h2>
            </div>
            <div className="stockin-setting-row">
              <div>
                <div className="stockin-field-label">界面主题</div>
                <div className="stockin-btn-row" role="group" aria-label="界面主题">
                  {THEME_MODE_OPTIONS.map((option) => {
                    const active: boolean = mode === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        aria-pressed={active}
                        onClick={(): void => setMode(option.value)}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          minHeight: TOUCH_TARGET_MIN_PX,
                          padding: '0 14px',
                          borderRadius: 'var(--stockin-radius)',
                          border: `1px solid ${active ? 'var(--stockin-color-primary)' : 'var(--stockin-color-control-border)'}`,
                          background: active
                            ? 'var(--stockin-color-primary-bg)'
                            : 'var(--stockin-color-surface)',
                          color: active
                            ? 'var(--stockin-color-primary-text)'
                            : 'var(--stockin-color-text)',
                          fontFamily: 'var(--stockin-font-sans)',
                          fontSize: 'var(--stockin-fs-body)',
                          cursor: 'pointer',
                        }}
                      >
                        <Icon name={THEME_ICONS[option.value]} size="sm" />
                        {option.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </section>

          <section className="stockin-panel">
            <div className="stockin-panel-head">
              <div className="stockin-title-row">
                <h2 className="stockin-panel-title">
                  <Icon name="clock" size="sm" />
                  临期阈值
                </h2>
                <InfoTip
                  label="查看临期阈值说明"
                  title="临期阈值"
                  content="距到期日不超过阈值的记录计入临期（含到期当天）；已过到期日的记录计入过期；未填到期日的记录不计入临期与过期。"
                />
              </div>
            </div>
            <div className="stockin-setting-row">
              <div className="stockin-setting-field">
                <label className="stockin-field-label" htmlFor="threshold-days">
                  天数
                </label>
                <div className="stockin-setting-actions">
                  <Input
                    id="threshold-days"
                    value={threshold}
                    inputMode="numeric"
                    aria-label="临期阈值天数"
                    placeholder="30"
                    status={thresholdError !== null ? 'error' : undefined}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>): void => {
                      setThreshold(event.target.value);
                      if (thresholdError !== null) {
                        setThresholdError(null);
                      }
                    }}
                    style={{ width: 140, minHeight: TOUCH_TARGET_MIN_PX }}
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
                </div>
                {thresholdError !== null ? (
                  <div
                    role="alert"
                    className="stockin-hint"
                    style={{ color: 'var(--stockin-color-expired)' }}
                  >
                    {thresholdError}
                  </div>
                ) : null}
              </div>
            </div>
          </section>

          <section className="stockin-panel">
            <div className="stockin-panel-head">
              <h2 className="stockin-panel-title">
                <Icon name="log" size="sm" />
                备份记录
              </h2>
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
            <div style={{ padding: 'var(--stockin-s4) var(--stockin-s6)' }}>
              <div className="stockin-kv">
                <span>保留策略</span>
                <b>最近 {keepCount} 份</b>
              </div>
              <div className="stockin-kv">
                <span>最近一次备份</span>
                <b className="stockin-mono">
                  {lastBackupAt === null ? '暂无' : formatDateTime(lastBackupAt)}
                </b>
              </div>
            </div>
            <div style={{ padding: '0 var(--stockin-s6) var(--stockin-s6)' }}>
              {failedCount > 0 ? (
                <Alert
                  type="warning"
                  showIcon
                  message={`${failedCount} 份备份校验未通过`}
                  style={{ marginBottom: 12 }}
                />
              ) : null}
              {useCardList ? (
                loading ? (
                  <SkeletonCards />
                ) : backups.length === 0 ? (
                  <EmptyState icon="log" title="暂无备份记录" />
                ) : (
                  <div className="stockin-card-list">
                    {backups.map((record: BackupMetaView) => (
                      <BackupCard key={record.file} record={record} />
                    ))}
                  </div>
                )
              ) : (
                <Table<BackupMetaView>
                  rowKey="file"
                  size="small"
                  loading={loading}
                  columns={backupColumns}
                  dataSource={backups as BackupMetaView[]}
                  pagination={false}
                  expandable={{
                    expandedRowRender: (record: BackupMetaView): React.ReactNode => (
                      <BackupTechnicalInfo record={record} />
                    ),
                  }}
                  locale={{ emptyText: <EmptyState icon="log" title="暂无备份记录" /> }}
                />
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
};

export default SettingsPage;
