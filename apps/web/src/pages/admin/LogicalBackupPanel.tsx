/**
 * 管理员：加密逻辑备份列表 / 手动触发 / 下载。
 *
 * 与用户端设置页的区别：这里可以下载加密备份文件（NDJSON），
 * 但解密与恢复票据仍必须在本地用私钥完成，服务端不接触私钥。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, App as AntdApp, Button, Card, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { LogicalBackupItem, LogicalBackupJobView } from '@stockin/shared';
import {
  downloadAdminLogicalBackup,
  listAdminLogicalBackups,
  triggerAdminLogicalBackup,
} from '@/services/api/admin';
import { errorMessage, type BlobResult } from '@/services/request';
import { formatBytes, formatDateTime } from '@/utils/format';
import { TOUCH_TARGET_MIN_PX } from '@/constants/routes';

const { Paragraph, Text } = Typography;

const JOB_STATUS_TEXT: Readonly<Record<string, string>> = {
  pending: '排队中',
  running: '生成中',
  done: '已完成',
  failed: '失败',
};

async function pollUntilSettled(onTick: (list: Awaited<ReturnType<typeof listAdminLogicalBackups>>) => void): Promise<void> {
  for (let i = 0; i < 15; i += 1) {
    await new Promise<void>((resolve): void => {
      window.setTimeout(resolve, 2000);
    });
    const list = await listAdminLogicalBackups();
    onTick(list);
    const job: LogicalBackupJobView | null = list.activeJob;
    if (job === null || job.status === 'done' || job.status === 'failed') {
      return;
    }
  }
}

const LogicalBackupPanel: React.FC = () => {
  const { message } = AntdApp.useApp();
  const [items, setItems] = useState<readonly LogicalBackupItem[]>([]);
  const [keepCount, setKeepCount] = useState<number>(0);
  const [activeJob, setActiveJob] = useState<LogicalBackupJobView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<boolean>(false);

  const load = useCallback(async (): Promise<void> => {
    const list = await listAdminLogicalBackups();
    setItems(list.items);
    setKeepCount(list.keepCount);
    setActiveJob(list.activeJob);
    setLoaded(true);
  }, []);

  useEffect((): void => {
    void load().catch((): void => {
      setLoaded(true);
    });
  }, [load]);

  const handleTrigger = useCallback(async (): Promise<void> => {
    setBusy('trigger');
    try {
      await triggerAdminLogicalBackup();
      message.info('备份任务已入队，正在后台分块生成');
      await pollUntilSettled((list): void => {
        setItems(list.items);
        setActiveJob(list.activeJob);
      });
      const list = await listAdminLogicalBackups();
      setItems(list.items);
      setActiveJob(list.activeJob);
      message.success('备份任务已结束');
    } catch (cause) {
      message.error(errorMessage(cause, '触发备份失败'));
    } finally {
      setBusy(null);
    }
  }, [message]);

  const handleDownload = useCallback(
    async (record: LogicalBackupItem): Promise<void> => {
      setBusy(`dl:${record.id}`);
      try {
        const result: BlobResult = await downloadAdminLogicalBackup(record.id);
        message.success(`已开始下载 ${result.filename}`);
      } catch (cause) {
        message.error(errorMessage(cause, '下载备份失败'));
      } finally {
        setBusy(null);
      }
    },
    [message],
  );

  const columns: ColumnsType<LogicalBackupItem> = [
    {
      title: '生成时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 190,
      render: (value: string): string => formatDateTime(value),
    },
    {
      title: '结构版本',
      dataIndex: 'schemaVersion',
      key: 'schemaVersion',
      width: 90,
      align: 'right',
      render: (value: number): string => String(value),
    },
    {
      title: '数据量',
      dataIndex: 'plainBytes',
      key: 'plainBytes',
      width: 100,
      align: 'right',
      render: (value: number): string => formatBytes(value),
    },
    {
      title: '分块',
      dataIndex: 'chunkCount',
      key: 'chunkCount',
      width: 80,
      align: 'right',
      render: (value: number): string => String(value),
    },
    {
      title: '状态',
      key: 'status',
      width: 100,
      render: (_: unknown, record: LogicalBackupItem): React.ReactNode => {
        const ready: boolean = record.manifestSha256 !== null;
        return <Tag color={ready ? 'success' : 'processing'}>{ready ? '可恢复' : '生成中'}</Tag>;
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 90,
      render: (_: unknown, record: LogicalBackupItem): React.ReactNode => (
        <Button
          type="link"
          size="small"
          disabled={record.manifestSha256 === null}
          loading={busy === `dl:${record.id}`}
          onClick={(): void => void handleDownload(record)}
        >
          下载
        </Button>
      ),
    },
  ];

  return (
    <Card
      title="加密逻辑备份"
      style={{ marginBottom: 20 }}
      extra={
        <Button
          type="primary"
          loading={busy === 'trigger'}
          disabled={activeJob !== null}
          onClick={(): void => void handleTrigger()}
          style={{ minHeight: TOUCH_TARGET_MIN_PX }}
        >
          立即备份
        </Button>
      }
    >
      <Paragraph type="secondary">
        加密逻辑备份保留最近 {keepCount} 份，Node 与 Workers 行为一致。下载文件为加密 NDJSON，
        需用本地私钥解密后才能生成恢复包与票据。
      </Paragraph>
      {activeJob !== null ? (
        <Alert
          type={activeJob.status === 'failed' ? 'error' : 'info'}
          showIcon
          message={
            activeJob.status === 'failed'
              ? `备份任务失败：${activeJob.error ?? '未知原因'}`
              : `备份任务${JOB_STATUS_TEXT[activeJob.status] ?? '处理中'} · ${activeJob.totalChunks === null ? '统计中' : `${activeJob.chunkSeq}/${activeJob.totalChunks} 块`}`
          }
          style={{ marginBottom: 12 }}
        />
      ) : null}
      <Table<LogicalBackupItem>
        rowKey="id"
        size="small"
        loading={!loaded}
        dataSource={items as LogicalBackupItem[]}
        columns={columns}
        pagination={false}
        locale={{ emptyText: <Text type="secondary">暂无逻辑备份</Text> }}
      />
    </Card>
  );
};

export default LogicalBackupPanel;
