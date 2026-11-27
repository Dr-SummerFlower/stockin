/**
 * 管理员：备份公钥维护。
 *
 * 为什么公钥可以在管理台改：公钥不是秘密，它只用于「加密新备份」和「验恢复票据」；
 * 解密永远只需要本地私钥 + 备份 meta 里的 keyId。放进数据库后轮换不再依赖
 * 重新部署，也不需要 Cloudflare 账号权限。
 *
 * 库内 `backup_keys` 是公钥的唯一真源：首次启动时若库内为空，bootstrap 会用
 * `BACKUP_PUBLIC_KEY` 播种一条默认公钥；此后加密与验签只读库内，环境变量
 * 不再参与，增删启用全部在这个页面完成。
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Checkbox,
  Popconfirm,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ImeInput as Input } from '@/components/ImeInput';
import type { BackupKeyItem, BackupKeyListResponse } from '@stockin/shared';
import {
  activateBackupKey,
  addBackupKey,
  deleteBackupKey,
  listBackupKeys,
} from '@/services/api/admin';
import { errorMessage } from '@/services/request';
import { formatDateTime } from '@/utils/format';
import { TOUCH_TARGET_MIN_PX } from '@/constants/routes';

const { Paragraph, Text } = Typography;
const { TextArea } = Input;

const BackupKeysPanel: React.FC = () => {
  const { message } = AntdApp.useApp();
  const [data, setData] = useState<BackupKeyListResponse | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [publicKey, setPublicKey] = useState<string>('');
  const [label, setLabel] = useState<string>('');
  const [activateNow, setActivateNow] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);

  const load = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      setData(await listBackupKeys());
    } catch (cause) {
      message.error(errorMessage(cause, '备份公钥加载失败'));
    } finally {
      setBusy(false);
    }
  }, [message]);

  useEffect((): void => {
    void load();
  }, [load]);

  const submit = useCallback(async (): Promise<void> => {
    const key: string = publicKey.trim();
    if (key === '') {
      message.warning('请粘贴公钥内容');
      return;
    }
    setSubmitting(true);
    try {
      setData(
        await addBackupKey({
          publicKey: key,
          label: label.trim() === '' ? undefined : label.trim(),
          activate: activateNow,
        }),
      );
      setPublicKey('');
      setLabel('');
      setActivateNow(false);
      message.success('公钥已添加');
    } catch (cause) {
      message.error(errorMessage(cause, '公钥添加失败'));
    } finally {
      setSubmitting(false);
    }
  }, [activateNow, label, message, publicKey]);

  const run = useCallback(
    async (
      action: () => Promise<BackupKeyListResponse>,
      ok: string,
      fail: string,
    ): Promise<void> => {
      setBusy(true);
      try {
        setData(await action());
        message.success(ok);
      } catch (cause) {
        message.error(errorMessage(cause, fail));
      } finally {
        setBusy(false);
      }
    },
    [message],
  );

  const columns: ColumnsType<BackupKeyItem> = [
    {
      title: 'keyId',
      dataIndex: 'keyId',
      key: 'keyId',
      render: (keyId: string, row: BackupKeyItem): React.ReactNode => (
        <Space direction="vertical" size={0}>
          <Text code style={{ fontSize: 12 }}>
            {keyId}
          </Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {row.label || '无备注'}
          </Text>
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'active',
      key: 'active',
      width: 150,
      render: (active: boolean): React.ReactNode =>
        active ? <Tag color="green">加密中使用</Tag> : <Tag>仅验签</Tag>,
    },
    {
      title: '添加时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 180,
      render: (value: string | null): React.ReactNode =>
        value === null ? <Text type="secondary">—</Text> : formatDateTime(value),
    },
    {
      title: '操作',
      key: 'actions',
      width: 190,
      render: (_: unknown, row: BackupKeyItem): React.ReactNode => {
        return (
          <Space>
            <Button
              size="small"
              disabled={row.active || busy}
              onClick={(): void => {
                void run(
                  () => activateBackupKey(row.keyId),
                  '已切换加密公钥，新备份将使用它',
                  '切换失败',
                );
              }}
            >
              设为加密
            </Button>
            <Popconfirm
              title="删除这把公钥？"
              description="只会影响「用对应私钥签出的恢复票据」，历史备份仍可在本地解密。"
              okText="删除"
              cancelText="取消"
              disabled={row.active}
              onConfirm={(): void => {
                void run(() => deleteBackupKey(row.keyId), '公钥已删除', '删除失败');
              }}
            >
              <Button size="small" danger disabled={row.active || busy}>
                删除
              </Button>
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  return (
    <Card title="备份公钥" style={{ marginBottom: 20 }} loading={busy && data === null}>
      <Paragraph type="secondary">
        服务端只持有公钥：加密新备份用它，验恢复票据用它。
        <Text strong>解密只需要本地私钥</Text>
        ，所以旧公钥可以按需清理——删掉一把公钥不会让历史备份失去可解密性，
        只是用对应私钥签出的恢复票据不再被接受（票据有效期 30 分钟）。
      </Paragraph>
      {data?.enabled === false ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="尚未配置任何公钥"
          description="加密逻辑备份与一次性恢复目前不可用。在下方添加一把公钥即可启用。"
        />
      ) : null}

      <Table<BackupKeyItem>
        rowKey="keyId"
        size="small"
        pagination={false}
        dataSource={data?.items ?? []}
        columns={columns}
        style={{ marginBottom: 20 }}
      />

      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Text strong>添加公钥</Text>
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          用 <Text code>pnpm backup:keygen</Text> 在本地生成，粘贴
          <Text code>.keys/&lt;keyId&gt;.public.key</Text> 的整行内容（单行 base64）。
          私钥永远留在本地，不要粘贴到这里。
        </Paragraph>
        <TextArea
          value={publicKey}
          autoSize={{ minRows: 2, maxRows: 4 }}
          placeholder="MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE..."
          aria-label="公钥内容"
          onChange={(event: React.ChangeEvent<HTMLTextAreaElement>): void =>
            setPublicKey(event.target.value)
          }
        />
        <Space wrap align="center">
          <Input
            value={label}
            placeholder="备注（可选，例如 2026-11 轮换）"
            aria-label="公钥备注"
            onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
              setLabel(event.target.value)
            }
            style={{ width: 260, minHeight: TOUCH_TARGET_MIN_PX }}
          />
          <Checkbox
            checked={activateNow}
            onChange={(event): void => setActivateNow(event.target.checked)}
          >
            立即设为加密公钥
          </Checkbox>
          <Button
            type="primary"
            loading={submitting}
            onClick={(): void => void submit()}
            style={{ minHeight: TOUCH_TARGET_MIN_PX }}
          >
            添加
          </Button>
        </Space>
      </Space>
    </Card>
  );
};

export default BackupKeysPanel;
