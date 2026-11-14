/**
 * Excel 导出面板（由 WorkbenchModal 统一承载，自身不含容器）。
 *
 * - 顶部展示「已应用条件」chips（与筛选条共用 describeRecordFilter 同一份描述）；
 * - 用 `GET /api/records?pageSize=1` 的 `total` 给「约 N 条」，无需新增接口；
 * - 此处进货日期覆盖列表页已设置的进货起止条件；
 * - 与导入共用服务端全局信号量，前端互斥避免并发冲突。
 * 提示器走 antd App 的 holder 实例，随主题切换；文案为中性书面语。
 */
import React, { useEffect, useState } from 'react';
import { App as AntdApp, Button, Typography } from 'antd';
import { useModel } from 'umi';
import type { RecordFilter } from '@stockin/shared';
import { DateRangeInput } from '@/components/DateInput';
import { exportExcel } from '@/services/api/excel';
import { listRecords } from '@/services/api/record';
import { errorMessage } from '@/services/request';
import { describeRecordFilter, formatCount, isDateString } from '@/utils/format';

export interface ExportPanelProps {
  /** 当前筛选（已去掉分页，来自 recordFilters model 的 exportFilter()）。 */
  readonly baseFilter: RecordFilter;
  readonly onClose: () => void;
}

const ExportPanel: React.FC<ExportPanelProps> = ({ baseFilter, onClose }) => {
  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);
  const [estimate, setEstimate] = useState<number | null>(null);
  const [estimating, setEstimating] = useState<boolean>(false);
  const { message: holderMessage } = AntdApp.useApp();
  const { acquireHeavy, releaseHeavy, heavyBusy } = useModel('ui');

  const invalid: boolean =
    (from.trim() !== '' && !isDateString(from.trim())) ||
    (to.trim() !== '' && !isDateString(to.trim()));
  const validFrom: string | undefined =
    from.trim() !== '' && isDateString(from.trim()) ? from.trim() : undefined;
  const validTo: string | undefined =
    to.trim() !== '' && isDateString(to.trim()) ? to.trim() : undefined;
  const chips = describeRecordFilter(baseFilter);
  // baseFilter 每次渲染都是新对象，用序列化 key 稳定 effect 依赖。
  const filterKey: string = JSON.stringify(baseFilter);

  const buildFilter = (): RecordFilter => {
    const filter: RecordFilter = { ...(JSON.parse(filterKey) as RecordFilter) };
    if (validFrom !== undefined) {
      filter.purchaseDateFrom = validFrom;
    }
    if (validTo !== undefined) {
      filter.purchaseDateTo = validTo;
    }
    return filter;
  };

  useEffect((): () => void => {
    let active = true;
    const timer: ReturnType<typeof setTimeout> = setTimeout((): void => {
      setEstimating(true);
      void listRecords({ ...buildFilter(), page: 1, pageSize: 1 })
        .then((page): void => {
          if (active) {
            setEstimate(page.total);
          }
        })
        .catch((): void => {
          if (active) {
            setEstimate(null);
          }
        })
        .finally((): void => {
          if (active) {
            setEstimating(false);
          }
        });
    }, 300);
    return (): void => {
      active = false;
      clearTimeout(timer);
    };
    // buildFilter 只依赖 filterKey / validFrom / validTo。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, validFrom, validTo]);

  const doExport = async (): Promise<void> => {
    if (invalid) {
      holderMessage.warning('日期须填写为年-月-日，如 2026-11-10');
      return;
    }
    if (!acquireHeavy()) {
      holderMessage.warning('已有导入 / 导出任务进行中，稍后重试');
      return;
    }
    setBusy(true);
    try {
      const result = await exportExcel(buildFilter());
      holderMessage.success(`导出完成：${result.filename}`);
      onClose();
    } catch (cause) {
      holderMessage.error(errorMessage(cause, '导出失败'));
    } finally {
      setBusy(false);
      releaseHeavy();
    }
  };

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <Typography.Text type="secondary">已应用条件：</Typography.Text>
        {chips.length === 0 ? (
          <Typography.Text>全部记录</Typography.Text>
        ) : (
          <div className="stockin-chips" style={{ marginTop: 6, marginBottom: 0 }}>
            {chips.map((chip) => (
              <span key={chip.key} className="stockin-chip">
                {chip.label}
              </span>
            ))}
          </div>
        )}
        <div style={{ marginTop: 8, fontWeight: 600 }}>
          {estimating
            ? '正在统计条数…'
            : estimate === null
              ? '条数统计失败'
              : `预计导出 ${formatCount(estimate)} 条`}
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 12 }}>
        <div className="stockin-filter-item" style={{ flex: '1 1 260px' }}>
          <span className="stockin-filter-label">进货日期范围</span>
          <DateRangeInput
            from={from}
            to={to}
            ariaLabel="按进货日期范围导出"
            placeholder={['起始日期', '截止日期']}
            onChange={(nextFrom: string, nextTo: string): void => {
              setFrom(nextFrom);
              setTo(nextTo);
            }}
          />
        </div>
      </div>

      <div className="stockin-workbench-actions">
        <Button
          type="primary"
          loading={busy}
          disabled={invalid || heavyBusy}
          onClick={(): void => {
            void doExport();
          }}
        >
          开始导出
        </Button>
        <Button disabled={busy} onClick={onClose}>
          取消
        </Button>
      </div>
    </div>
  );
};

export default ExportPanel;
