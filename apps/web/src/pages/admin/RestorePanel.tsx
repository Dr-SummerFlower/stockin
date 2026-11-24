/**
 * 管理员：一次性全量恢复。
 *
 * 浏览器只负责上传明文恢复包与本地私钥签发的票据，不接触私钥。
 * 流程：begin → 分块上传 → commit；票据绑定本次 batchId，超时即失效。
 * commit 由服务端在验签、摘要校验通过后先做物理快照，再单事务全量重建。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, App as AntdApp, Button, Card, Modal, Space, Typography } from 'antd';
import type { RestoreBeginResponse, RestoreTicket } from '@stockin/shared';
import {
  beginRestore,
  commitRestore,
  getAdminSystem,
  putRestoreChunk,
} from '@/services/api/admin';
import { errorMessage } from '@/services/request';
import { formatDateTime } from '@/utils/format';
import { TOUCH_TARGET_MIN_PX } from '@/constants/routes';

const { Paragraph, Text } = Typography;

/** 与本地脚本一致的上传分块大小。 */
const CHUNK_BYTES = 64 * 1024;

const RestorePanel: React.FC = () => {
  const { message } = AntdApp.useApp();
  const [batch, setBatch] = useState<RestoreBeginResponse | null>(null);
  const [schemaVersion, setSchemaVersion] = useState<number | null>(null);
  const [packageFile, setPackageFile] = useState<File | null>(null);
  const [ticketFile, setTicketFile] = useState<File | null>(null);
  const [confirmOpen, setConfirmOpen] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [progress, setProgress] = useState<string>('');

  useEffect((): void => {
    void getAdminSystem()
      .then((system): void => setSchemaVersion(system.schemaVersion))
      .catch((): void => undefined);
  }, []);

  const handleBegin = useCallback(async (): Promise<void> => {
    setBusy(true);
    try {
      const begun: RestoreBeginResponse = await beginRestore();
      setBatch(begun);
      setPackageFile(null);
      setTicketFile(null);
      message.success('恢复批次已创建，请在 30 分钟内完成');
    } catch (cause) {
      message.error(errorMessage(cause, '创建恢复批次失败'));
    } finally {
      setBusy(false);
    }
  }, [message]);

  const runRestore = useCallback(async (): Promise<void> => {
    if (batch === null || packageFile === null || ticketFile === null) {
      message.warning('请先创建批次并选择恢复包与票据文件');
      return;
    }
    setBusy(true);
    try {
      let ticket: RestoreTicket;
      try {
        ticket = JSON.parse(await ticketFile.text()) as RestoreTicket;
      } catch {
        throw new Error('票据文件不是合法的 JSON，请检查是否选错了文件');
      }
      if (ticket?.payload?.batchId !== batch.batchId) {
        throw new Error('票据批次与当前批次不一致，请按页面显示的批次号重新生成票据');
      }
      const bytes: Uint8Array = new Uint8Array(await packageFile.arrayBuffer());
      if (bytes.byteLength === 0) {
        throw new Error('恢复包为空');
      }
      const total: number = Math.ceil(bytes.byteLength / CHUNK_BYTES);
      let seq = 0;
      for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
        const slice: Uint8Array = bytes.subarray(offset, offset + CHUNK_BYTES);
        await putRestoreChunk(batch.batchId, seq, slice);
        seq += 1;
        setProgress(`已上传 ${seq}/${total} 块`);
      }
      setProgress('正在验签、校验数据并恢复…');
      const result = await commitRestore({ batchId: batch.batchId, ticket });
      message.success(
        `恢复完成：${result.restoredTables} 张表 / ${result.restoredRows} 行，请重新登录`,
      );
      setBatch(null);
      setPackageFile(null);
      setTicketFile(null);
    } catch (cause) {
      message.error(errorMessage(cause, '恢复失败'));
    } finally {
      setBusy(false);
      setProgress('');
    }
  }, [batch, message, packageFile, ticketFile]);

  return (
    <Card title="数据恢复" style={{ marginBottom: 20 }}>
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        message="全量恢复会清空现有业务数据并从恢复包重建，所有会话立即失效。服务端会在恢复前自动创建物理快照。"
      />
      <Paragraph type="secondary">
        解密、生成票据必须在本地用私钥完成。私钥只留在本地，页面只上传恢复包与签名票据。
      </Paragraph>
      <Space wrap>
        <Button
          type="primary"
          loading={busy && batch === null}
          disabled={busy || batch !== null}
          onClick={(): void => void handleBegin()}
          style={{ minHeight: TOUCH_TARGET_MIN_PX }}
        >
          发起恢复批次
        </Button>
      </Space>
      {batch !== null ? (
        <div style={{ marginTop: 16 }}>
          <Paragraph>
            <Text strong>批次号：</Text>
            <Text code copyable>{batch.batchId}</Text>
          </Paragraph>
          <Paragraph>
            <Text strong>签发时间：</Text>
            {formatDateTime(batch.issuedAt)} · 有效期 {Math.round(batch.windowMs / 60000)} 分钟
          </Paragraph>
          <Paragraph type="secondary">
            本地执行（schema 填当前结构版本 {schemaVersion ?? '—'}）：
          </Paragraph>
          <Paragraph>
            <Text code>
              {`pnpm backup:ticket --package <恢复包路径> --batch ${batch.batchId} --issued-at ${batch.issuedAt} --schema ${schemaVersion ?? '<当前结构版本>'} --key <私钥路径>`}
            </Text>
          </Paragraph>
          <Space direction="vertical" style={{ width: '100%' }}>
            <div>
              <div className="stockin-field-label">恢复包（restore-package.ndjson）</div>
              <input
                type="file"
                accept=".ndjson,application/x-ndjson"
                aria-label="选择恢复包"
                onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
                  setPackageFile(event.target.files?.[0] ?? null)
                }
              />
            </div>
            <div>
              <div className="stockin-field-label">票据（restore-ticket.json）</div>
              <input
                type="file"
                accept=".json,application/json"
                aria-label="选择恢复票据"
                onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
                  setTicketFile(event.target.files?.[0] ?? null)
                }
              />
            </div>
          </Space>
          {progress !== '' ? <Paragraph type="secondary">{progress}</Paragraph> : null}
          <Button
            danger
            loading={busy}
            disabled={packageFile === null || ticketFile === null}
            onClick={(): void => setConfirmOpen(true)}
            style={{ minHeight: TOUCH_TARGET_MIN_PX, marginTop: 16 }}
          >
            提交恢复
          </Button>
        </div>
      ) : null}
      <Modal
        title="确认全量恢复"
        open={confirmOpen}
        onCancel={(): void => setConfirmOpen(false)}
        onOk={(): void => {
          setConfirmOpen(false);
          void runRestore();
        }}
        okText="确认恢复"
        cancelText="取消"
        okButtonProps={{ danger: true, loading: busy }}
      >
        <Paragraph>将用所选恢复包覆盖全部业务数据，恢复完成后所有会话失效，需要重新登录。</Paragraph>
        <Paragraph type="secondary">服务端会先生成物理快照，再执行单事务恢复。</Paragraph>
      </Modal>
    </Card>
  );
};

export default RestorePanel;
