/**
 * 新增进货记录页。
 *
 * `RecordForm` 负责算对 10 字段与 6 个来源位；服务端 `record.service`
 * 只校验不重算、不改写提交值，故本页直接提交表单产出的 `RecordDraft`。
 */
import React, { useState } from 'react';
import { Card, message } from 'antd';
import { useModel, useNavigate } from 'umi';
import type { RecordDraft } from '@stockin/shared';
import { createRecord } from '@/services/api/record';
import RecordForm from '@/components/RecordForm';
import { ROUTES } from '@/constants/routes';

const NewRecordPage: React.FC = () => {
  const navigate = useNavigate();
  const { bumpRefresh } = useModel('ui');
  const [submitting, setSubmitting] = useState<boolean>(false);

  const onSubmit = async (draft: RecordDraft): Promise<void> => {
    setSubmitting(true);
    try {
      await createRecord(draft);
      bumpRefresh();
      message.success('进货记录已新增');
      navigate(ROUTES.records);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="stockin-page">
      <div className="stockin-page-head">
        <div>
          <h1 className="stockin-page-title">新增进货记录</h1>
          <div className="stockin-page-subtitle">
            两组三选二联动由 @stockin/domain 计算；服务端只校验不重算
          </div>
        </div>
      </div>
      <Card>
        <RecordForm
          submitting={submitting}
          onSubmit={onSubmit}
          onCancel={(): void => navigate(ROUTES.records)}
        />
      </Card>
    </div>
  );
};

export default NewRecordPage;
