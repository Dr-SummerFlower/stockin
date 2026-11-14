/**
 * 编辑进货记录页（`/records/:id/edit`）。
 *
 * 用 `useParams()` 取 id；`version` 由 `RecordForm` 从 `RecordView` 带入
 * `RecordDraft`，服务端做 CAS 乐观锁。保留加载 / 错误 / 重试三态。
 * 填写规则收进表单右侧栏，页头不再重复说明。
 */
import React, { useEffect, useState } from 'react';
import { App as AntdApp, Button, Spin } from 'antd';
import { useModel, useNavigate, useParams } from 'umi';
import type { RecordDraft, RecordView } from '@stockin/shared';
import { getRecord, updateRecord } from '@/services/api/record';
import RecordForm from '@/components/RecordForm';
import Icon from '@/components/Icon';
import ErrorView from '@/components/ErrorView';
import { ROUTES, TOUCH_TARGET_MIN_PX } from '@/constants/routes';

const EditRecordPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const recordId: number = Number.parseInt(id ?? '', 10);
  const navigate = useNavigate();
  const { message: holderMessage } = AntdApp.useApp();
  const { bumpRefresh } = useModel('ui');
  const [record, setRecord] = useState<RecordView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState<boolean>(false);
  // 错误态「重试」通过递增 reloadKey 重新触发下方加载逻辑。
  const [reloadKey, setReloadKey] = useState<number>(0);

  useEffect((): (() => void) => {
    let active = true;
    setLoading(true);
    setError(null);
    if (!Number.isSafeInteger(recordId) || recordId <= 0) {
      setError(new Error('编号不合法'));
      setLoading(false);
      return (): void => {
        active = false;
      };
    }
    void getRecord(recordId)
      .then((view: RecordView): void => {
        if (active) {
          setRecord(view);
        }
      })
      .catch((cause: unknown): void => {
        if (active) {
          setError(cause);
        }
      })
      .finally((): void => {
        if (active) {
          setLoading(false);
        }
      });
    return (): void => {
      active = false;
    };
  }, [recordId, reloadKey]);

  const onSubmit = async (draft: RecordDraft): Promise<void> => {
    if (record === null) {
      return;
    }
    setSubmitting(true);
    try {
      await updateRecord(record.id, draft);
      bumpRefresh();
      holderMessage.success('记录已保存');
      navigate(ROUTES.records);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="stockin-page" style={{ textAlign: 'center', padding: 48 }}>
        <Spin size="large" />
        <div className="stockin-hint" style={{ marginTop: 12 }}>
          加载记录中…
        </div>
      </div>
    );
  }
  if (error !== null) {
    return (
      <div className="stockin-page">
        <ErrorView
          error={error}
          title="记录加载失败"
          onRetry={(): void => setReloadKey((key: number): number => key + 1)}
        />
        <Button
          style={{ marginTop: 12, minHeight: TOUCH_TARGET_MIN_PX }}
          onClick={(): void => navigate(ROUTES.records)}
        >
          返回列表
        </Button>
      </div>
    );
  }
  if (record === null) {
    return (
      <div className="stockin-page">
        <ErrorView error={new Error('记录不存在或已被删除')} title="记录不存在" />
      </div>
    );
  }

  return (
    <div className="stockin-page">
      <div className="stockin-page-head">
        <h1 className="stockin-page-title">编辑进货记录</h1>
        <div className="stockin-page-actions">
          <Button
            icon={<Icon name="arrowLeft" size="sm" />}
            onClick={(): void => navigate(ROUTES.records)}
          >
            返回列表
          </Button>
        </div>
      </div>
      <RecordForm
        initial={record}
        submitting={submitting}
        onSubmit={onSubmit}
        onCancel={(): void => navigate(ROUTES.records)}
      />
    </div>
  );
};

export default EditRecordPage;
