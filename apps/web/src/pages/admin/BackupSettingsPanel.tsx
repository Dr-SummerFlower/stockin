/**
 * 管理员：备份间隔设置。
 *
 * 逻辑备份与物理快照的间隔各自独立，均为 1～365 天的正整数。
 * 修改后立即写入设置并在审计日志记录 actor。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { App as AntdApp, Button, Card, Space, Typography } from 'antd';
import { ImeInput as Input } from '@/components/ImeInput';
import type { BackupSettingsResponse } from '@stockin/shared';
import { getBackupSettings, updateBackupSettings } from '@/services/api/admin';
import { errorMessage } from '@/services/request';
import { TOUCH_TARGET_MIN_PX } from '@/constants/routes';

const { Paragraph } = Typography;

const BackupSettingsPanel: React.FC = () => {
  const { message } = AntdApp.useApp();
  const [logicalDays, setLogicalDays] = useState<string>('');
  const [physicalDays, setPhysicalDays] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);

  useEffect((): void => {
    setBusy(true);
    void getBackupSettings()
      .then((settings: BackupSettingsResponse): void => {
        setLogicalDays(String(settings.logicalBackupIntervalDays));
        setPhysicalDays(String(settings.physicalBackupIntervalDays));
      })
      .catch((cause: unknown): void => {
        message.error(errorMessage(cause, '备份设置加载失败'));
      })
      .finally((): void => setBusy(false));
  }, [message]);

  const save = useCallback(async (): Promise<void> => {
    const parse = (raw: string, label: string): number | null => {
      const text: string = raw.trim();
      if (!/^\d+$/.test(text)) {
        message.warning(`${label}需为 1 至 365 之间的整数`);
        return null;
      }
      const value: number = Number(text);
      if (value < 1 || value > 365) {
        message.warning(`${label}需为 1 至 365 之间的整数`);
        return null;
      }
      return value;
    };
    const logical: number | null = parse(logicalDays, '逻辑备份间隔');
    if (logical === null) return;
    const physical: number | null = parse(physicalDays, '物理快照间隔');
    if (physical === null) return;

    setSaving(true);
    try {
      const settings: BackupSettingsResponse = await updateBackupSettings({
        logicalBackupIntervalDays: logical,
        physicalBackupIntervalDays: physical,
      });
      setLogicalDays(String(settings.logicalBackupIntervalDays));
      setPhysicalDays(String(settings.physicalBackupIntervalDays));
      message.success('备份间隔已保存');
    } catch (cause) {
      message.error(errorMessage(cause, '备份间隔保存失败'));
    } finally {
      setSaving(false);
    }
  }, [logicalDays, message, physicalDays]);

  return (
    <Card title="备份间隔" style={{ marginBottom: 20 }}>
      <Paragraph type="secondary">逻辑备份与物理快照各自独立调度，修改后立即生效。</Paragraph>
      <Space wrap align="end">
        <div>
          <div className="stockin-field-label">逻辑备份间隔（天）</div>
          <Input
            value={logicalDays}
            inputMode="numeric"
            aria-label="逻辑备份间隔天数"
            placeholder="1"
            onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
              setLogicalDays(event.target.value)
            }
            style={{ width: 140, minHeight: TOUCH_TARGET_MIN_PX }}
          />
        </div>
        <div>
          <div className="stockin-field-label">物理快照间隔（天）</div>
          <Input
            value={physicalDays}
            inputMode="numeric"
            aria-label="物理快照间隔天数"
            placeholder="1"
            onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
              setPhysicalDays(event.target.value)
            }
            style={{ width: 140, minHeight: TOUCH_TARGET_MIN_PX }}
          />
        </div>
        <Button
          type="primary"
          loading={saving || busy}
          onClick={(): void => void save()}
          style={{ minHeight: TOUCH_TARGET_MIN_PX }}
        >
          保存间隔
        </Button>
      </Space>
    </Card>
  );
};

export default BackupSettingsPanel;
