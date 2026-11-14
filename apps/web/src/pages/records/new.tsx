/**
 * 新增进货记录页。
 *
 * `RecordForm` 负责算对 10 字段与 6 个来源位；服务端只校验不重算，
 * 故本页直接提交表单产出的 `RecordDraft`。
 * 填写规则收进表单右侧栏，页头不再重复说明（避免常驻小字冗余）。
 */
import React, { useState } from 'react';
import { App as AntdApp, Button } from 'antd';
import { useModel, useNavigate } from 'umi';
import type { RecordDraft } from '@stockin/shared';
import { createRecord } from '@/services/api/record';
import RecordForm from '@/components/RecordForm';
import Icon from '@/components/Icon';
import { ROUTES } from '@/constants/routes';

const NewRecordPage: React.FC = () => {
  const navigate = useNavigate();
  const { message: holderMessage } = AntdApp.useApp();
  const { bumpRefresh } = useModel('ui');
  const [submitting, setSubmitting] = useState<boolean>(false);

  const onSubmit = async (draft: RecordDraft): Promise<void> => {
    setSubmitting(true);
    try {
      await createRecord(draft);
      bumpRefresh();
      holderMessage.success('进货记录已新增');
      navigate(ROUTES.records);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="stockin-page">
      <div className="stockin-page-head">
        <h1 className="stockin-page-title">新增进货记录</h1>
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
        submitting={submitting}
        onSubmit={onSubmit}
        onCancel={(): void => navigate(ROUTES.records)}
      />
    </div>
  );
};

export default NewRecordPage;
