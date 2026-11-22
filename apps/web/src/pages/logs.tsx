/**
 * 操作日志页（只读）。
 *
 * 主视图为时间线：每条展示动作中文名、中文摘要与北京时间，排查用的技术信息
 * 默认收起，展开后保留中文标签与完整值（可直接选取）。筛选、分页、加载 / 错误 /
 * 空状态、刷新逻辑与服务端请求参数保持不变。文案采用中性书面语，不出现
 * 工程黑话、问句或劝导语。后端契约不变。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Button, Select } from 'antd';
import { ImeInput as Input } from '@/components/ImeInput';
import { useModel } from 'umi';
import {
  getLogTechnicalFields,
  listOperationLogs,
  summarizeLogEntry,
  type LogTechnicalField,
  type OperationLogEntry,
} from '@/services/api/log';
import TechnicalInfo from '@/components/TechnicalInfo';
import EmptyState from '@/components/EmptyState';
import Pager from '@/components/Pager';
import { DateRangeInput } from '@/components/DateInput';
import ErrorView from '@/components/ErrorView';
import Icon from '@/components/Icon';
import {
  ACTION_LABELS,
  LOG_COMMON_ACTIONS,
  TARGET_TYPE_LABELS,
  TOUCH_TARGET_MIN_PX,
} from '@/constants/routes';
import { formatDateTime, formatRelativeDateTime, isDateString } from '@/utils/format';

const ACTION_OPTIONS: { value: string; label: string }[] = Object.entries(
  ACTION_LABELS,
).map(([value, label]) => ({ value, label }));

/** `none` 不作为筛选项：对使用者无区分意义。 */
const TARGET_TYPE_OPTIONS: { value: string; label: string }[] = Object.entries(
  TARGET_TYPE_LABELS,
)
  .filter(([value]) => value !== 'none')
  .map(([value, label]) => ({ value, label }));

/** 服务端动作标记 → 中文名称；未知值回落中性文案，不显示英文原值。 */
function actionLabel(value: string): string {
  return ACTION_LABELS[value] ?? '其他操作';
}

function idStatus(value: string): 'error' | undefined {
  const text: string = value.trim();
  return text !== '' && !/^\d+$/.test(text) ? 'error' : undefined;
}

/** 技术信息区：中文标签、完整值、用途说明；不截断、不设复制入口。 */
const LogTechnicalInfo: React.FC<{ readonly entry: OperationLogEntry }> = ({ entry }) => (
  <div className="stockin-expand-row">
    <TechnicalInfo
      fields={[
        {
          label: '发生时间',
          value: formatDateTime(entry.occurred_at),
          hint: '本次操作的北京时间',
          mono: true,
        },
        ...getLogTechnicalFields(entry).map((field: LogTechnicalField) => ({
          label: field.label,
          value: field.value,
          hint: field.hint,
          mono: field.label === '操作编号' || field.label === '记录编号',
        })),
      ]}
    />
  </div>
);

/** 单条时间线：动作、摘要、相对时间与完整时间、技术信息展开入口。 */
const LogTimelineItem: React.FC<{ readonly entry: OperationLogEntry }> = ({ entry }) => {
  const [expanded, setExpanded] = useState<boolean>(false);
  const summary: string = summarizeLogEntry(entry);
  return (
    <div className="stockin-tl-item">
      <div className="stockin-tl-time">{formatRelativeDateTime(entry.occurred_at)}</div>
      <div className="stockin-tl-dot" />
      <div className="stockin-tl-body">
        <div className="stockin-tl-head">
          <b>{actionLabel(entry.action)}</b>
          <button
            type="button"
            className="stockin-link-btn"
            aria-expanded={expanded}
            onClick={(): void => setExpanded((value: boolean): boolean => !value)}
          >
            {expanded ? '收起技术信息' : '查看技术信息'}
            <Icon name="chevron" size="sm" />
          </button>
        </div>
        {/* 摘要一律完整展示：筛选条件往往落在句尾，截断会丢掉关键信息。 */}
        <p>{summary}</p>
        {expanded ? <LogTechnicalInfo entry={entry} /> : null}
      </div>
    </div>
  );
};

/** 加载态：列表型区块统一用行骨架，不误显示为空列表。 */
const LoadingView: React.FC = () => (
  <div className="stockin-skeleton-list" aria-busy="true">
    {[0, 1, 2, 3].map((key: number) => (
      <div key={key} className="stockin-skeleton-row" />
    ))}
  </div>
);

const LogsPage: React.FC = () => {
  const { refreshKey } = useModel('ui');
  const [items, setItems] = useState<readonly OperationLogEntry[]>([]);
  const [total, setTotal] = useState<number>(0);
  // 服务端回显（B1）：total 是同筛选条件计数，limit / offset 为实际生效值。
  const [resultOffset, setResultOffset] = useState<number>(0);
  const [resultLimit, setResultLimit] = useState<number>(20);
  const [offset, setOffset] = useState<number>(0);
  const [limit] = useState<number>(20);
  const [actionFilter, setActionFilter] = useState<string | undefined>(undefined);
  const [targetTypeFilter, setTargetTypeFilter] = useState<string | undefined>(
    undefined,
  );
  const [fromText, setFromText] = useState<string>('');
  const [toText, setToText] = useState<string>('');
  const [targetIdText, setTargetIdText] = useState<string>('');
  const [moreOpen, setMoreOpen] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<unknown>(null);
  const [reloadToken, setReloadToken] = useState<number>(0);

  // 文本筛选仅在值合法时生效，避免半输入进入查询触发后端 422。
  const appliedFrom: string | undefined = isDateString(fromText.trim())
    ? fromText.trim()
    : undefined;
  const appliedTo: string | undefined = isDateString(toText.trim())
    ? toText.trim()
    : undefined;
  const appliedTargetId: number | undefined = /^\d+$/.test(targetIdText.trim())
    ? Number(targetIdText.trim())
    : undefined;

  useEffect((): (() => void) => {
    let active = true;
    setLoading(true);
    setError(null);
    void listOperationLogs({
      action: actionFilter,
      targetType: targetTypeFilter,
      targetId: appliedTargetId,
      from: appliedFrom,
      to: appliedTo,
      limit,
      offset,
    })
      .then((result): void => {
        if (active) {
          setItems(result.items);
          setTotal(result.total);
          setResultOffset(result.offset);
          setResultLimit(result.limit);
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
  }, [
    actionFilter,
    targetTypeFilter,
    appliedTargetId,
    appliedFrom,
    appliedTo,
    limit,
    offset,
    refreshKey,
    reloadToken,
  ]);

  // 唯一的重试入口：ErrorView 与「刷新」按钮共用。
  const retry = useCallback((): void => {
    setReloadToken((value: number): number => value + 1);
  }, []);

  // 任一筛选变化都把 offset 复位为 0，避免停留在越界页。
  const changeAction = (value: string | undefined): void => {
    setActionFilter(value);
    setOffset(0);
  };
  const changeTargetType = (value: string | undefined): void => {
    setTargetTypeFilter(value);
    setOffset(0);
  };
  const changeFrom = (value: string): void => {
    setFromText(value);
    setOffset(0);
  };
  const changeTo = (value: string): void => {
    setToText(value);
    setOffset(0);
  };
  const changeTargetId = (value: string): void => {
    setTargetIdText(value);
    setOffset(0);
  };
  const resetFilters = (): void => {
    setActionFilter(undefined);
    setTargetTypeFilter(undefined);
    setFromText('');
    setToText('');
    setTargetIdText('');
    setOffset(0);
  };

  // 分页口径完全基于服务端回显；界面只翻页码，每页条数固定。
  const currentPage: number = Math.floor(resultOffset / resultLimit) + 1;
  const changePage = (next: number): void => {
    setOffset(Math.max(0, (next - 1) * resultLimit));
  };

  return (
    <div className="stockin-page">
      <div className="stockin-page-head">
        <h1 className="stockin-page-title">操作日志</h1>
        <div className="stockin-page-actions">
          <Button onClick={retry} style={{ minHeight: TOUCH_TARGET_MIN_PX }}>
            刷新
          </Button>
        </div>
      </div>

      <div className="stockin-filter-bar">
        <div className="stockin-filter-toolbar">
          <div className="stockin-quick-filters">
            <span className="stockin-quick-label">常用操作</span>
            {LOG_COMMON_ACTIONS.map((value: string) => {
              const active: boolean = actionFilter === value;
              return (
                <button
                  key={value}
                  type="button"
                  className={`stockin-quick-btn${active ? ' is-active' : ''}`}
                  aria-pressed={active}
                  onClick={(): void => changeAction(active ? undefined : value)}
                >
                  {actionLabel(value)}
                </button>
              );
            })}
          </div>
          <div className="stockin-filter-actions">
            <Button
              onClick={(): void => setMoreOpen((value: boolean): boolean => !value)}
              style={{ minHeight: TOUCH_TARGET_MIN_PX }}
            >
              {moreOpen ? '收起筛选' : '更多筛选'}
            </Button>
            <Button
              onClick={resetFilters}
              style={{ minHeight: TOUCH_TARGET_MIN_PX }}
            >
              重置
            </Button>
          </div>
        </div>
        {moreOpen ? (
          <div className="stockin-advanced-panel">
            <div className="stockin-filter-row">
              <div className="stockin-filter-item">
                <span className="stockin-filter-label">操作类型</span>
                <Select
                  value={actionFilter}
                  placeholder="全部操作"
                  aria-label="按操作类型筛选"
                  options={ACTION_OPTIONS}
                  allowClear
                  getPopupContainer={(): HTMLElement => document.body}
                  style={{ width: '100%', minHeight: TOUCH_TARGET_MIN_PX }}
                  onChange={(value: string | undefined): void =>
                    changeAction(value)
                  }
                />
              </div>
              <div className="stockin-filter-item is-range">
                <span className="stockin-filter-label">操作日期</span>
                <DateRangeInput
                  from={fromText}
                  to={toText}
                  ariaLabel="按操作日期区间筛选"
                  onChange={(from: string, to: string): void => {
                    changeFrom(from);
                    changeTo(to);
                  }}
                />
              </div>
              <div className="stockin-filter-item">
                <span className="stockin-filter-label">涉及内容</span>
                <Select
                  value={targetTypeFilter}
                  placeholder="全部内容"
                  aria-label="按涉及内容筛选"
                  options={TARGET_TYPE_OPTIONS}
                  allowClear
                  getPopupContainer={(): HTMLElement => document.body}
                  style={{ width: '100%', minHeight: TOUCH_TARGET_MIN_PX }}
                  onChange={(value: string | undefined): void =>
                    changeTargetType(value)
                  }
                />
              </div>
              <div className="stockin-filter-item">
                <span className="stockin-filter-label">记录编号</span>
                <Input
                  value={targetIdText}
                  inputMode="numeric"
                  placeholder="输入编号"
                  aria-label="记录编号"
                  status={idStatus(targetIdText)}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
                    changeTargetId(event.target.value)
                  }
                />
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {error !== null ? (
        <ErrorView error={error} onRetry={retry} />
      ) : (
        <div className="stockin-panel">
          {loading ? (
            <LoadingView />
          ) : items.length === 0 ? (
            <EmptyState icon="log" title="暂无操作日志" />
          ) : (
            <div className="stockin-timeline">
              {items.map((entry: OperationLogEntry) => (
                <LogTimelineItem key={entry.id} entry={entry} />
              ))}
            </div>
          )}
          <div className="stockin-panel-foot">
            <Pager
              page={currentPage}
              pageSize={resultLimit}
              total={total}
              disabled={loading}
              onChange={changePage}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default LogsPage;
