/**
 * 编辑进货记录页（`/records/:id/edit`）。
 *
 * 用 `useParams()` 取 id（Umi 4 配置式路由 `$` / `:` 参数，不是 `[id].tsx` 文件约定）。
 * `version` 由 `RecordForm` 从 `RecordView` 带入 `RecordDraft`，服务端做 CAS 乐观锁。
 */
import React, { useEffect, useState } from 'react';
import { Button, Card, Spin, message } from 'antd';
import { useModel, useNavigate, useParams } from 'umi';
import type { RecordDraft, RecordView } from '@stockin/shared';
import { getRecord, updateRecord } from '@/services/api/record';
import RecordForm from '@/components/RecordForm';
import ErrorView from '@/components/ErrorView';
import { ROUTES, TOUCH_TARGET_MIN_PX } from '@/constants/routes';

const EditRecordPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const recordId: number = Number.parseInt(id ?? '', 10);
  const navigate = useNavigate();
  const { bumpRefresh } = useModel('ui');
  const [record, setRecord] = useState<RecordView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState<boolean>(false);

  useEffect((): (() => void) => {
    let active = true;
    setLoading(true);
    setError(null);
    if (!Number.isSafeInteger(recordId) || recordId <= 0) {
      setError(new Error('无效的记录 ID'));
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
  }, [recordId]);

  const onSubmit = async (draft: RecordDraft): Promise<void> => {
    if (record === null) {
      return;
    }
    setSubmitting(true);
    try {
      await updateRecord(record.id, draft);
      bumpRefresh();
      message.success('记录已保存');
      navigate(ROUTES.records);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="stockin-page" style={{ textAlign: 'center', padding: 48 }}>
        <Spin size="large" tip="加载记录中…" />
      </div>
    );
  }
  if (error !== null) {
    return (
      <div className="stockin-page">
        <ErrorView error={error} title="记录加载失败" />
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
        <div>
          <h1 className="stockin-page-title">编辑进货记录 #{record.id}</h1>
          <div className="stockin-page-subtitle">
            版本 v{record.version} · 保存时按乐观锁校验
          </div>
        </div>
      </div>
      <Card>
        <RecordForm
          initial={record}
          submitting={submitting}
          onSubmit={onSubmit}
          onCancel={(): void => navigate(ROUTES.records)}
        />
      </Card>
    </div>
  );
};

export default EditRecordPage;
