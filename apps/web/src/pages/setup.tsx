/**
 * 首次初始化引导页（`.umirc.ts` 顶层独立路由，不继承主布局）。
 *
 * 自助引导：首启不再生成随机初始密码，本页用 AntD Steps 拆成 5 步，
 * 每步只处理一个设置项：账号 → 密保 → 店铺名称 → 临期阈值 → 界面主题。
 * 完成最后一步才一次性提交；服务端不签新会话，前端 `refresh()` 后跳 `/login`。
 *
 * 抢注风险的部署提醒只写在 README，不在页面内提示。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Alert, App as AntdApp, Button, Input, Select, Steps } from 'antd';
import { useModel, useNavigate } from 'umi';
import {
  EXPIRY_THRESHOLD_MAX,
  EXPIRY_THRESHOLD_MIN,
  PRESET_SECURITY_QUESTIONS,
  SHOP_NAME_MAX_LENGTH,
} from '@stockin/shared';
import { getInitStatus, setup } from '@/services/api/auth';
import { errorMessage } from '@/services/request';
import { ROUTES, TOUCH_TARGET_MIN_PX } from '@/constants/routes';
import Icon, { type IconName } from '@/components/Icon';
import { THEME_MODE_OPTIONS, type ThemeMode } from '@/utils/theme';

/** 三态主题对应的装饰图标（与设置页一致）。 */
const THEME_ICONS: Readonly<Record<ThemeMode, IconName>> = {
  light: 'sun',
  dark: 'moon',
  system: 'monitor',
};

const CUSTOM_QUESTION = 'custom';

/** 5 步，一步一个设置项。 */
const STEP_ITEMS = [
  { title: '账号' },
  { title: '密保' },
  { title: '店铺' },
  { title: '阈值' },
  { title: '主题' },
];

const STEP_HEADINGS = ['管理员账号', '密保问题', '店铺名称', '临期阈值', '界面主题'];

const SetupPage: React.FC = () => {
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();
  const { refresh } = useModel('session');
  const { mode, setMode } = useModel('theme');

  const [step, setStep] = useState<number>(0);
  const [username, setUsername] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [confirmPassword, setConfirmPassword] = useState<string>('');
  /** 预设问题索引或 `custom`。 */
  const [questionChoice, setQuestionChoice] = useState<string>('0');
  const [customQuestion, setCustomQuestion] = useState<string>('');
  const [securityAnswer, setSecurityAnswer] = useState<string>('');
  const [shopName, setShopName] = useState<string>('');
  const [threshold, setThreshold] = useState<string>('30');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);

  const questionOptions = useMemo(
    () => [
      ...PRESET_SECURITY_QUESTIONS.map((text, index) => ({
        value: String(index),
        label: text,
      })),
      { value: CUSTOM_QUESTION, label: '自定义问题' },
    ],
    [],
  );

  // 已完成初始化（init_state 单向 0→1）则不再允许引导。
  useEffect((): (() => void) => {
    let active = true;
    void getInitStatus()
      .then((status): void => {
        if (active && status.initState === 1) {
          navigate(ROUTES.login, { replace: true });
        }
      })
      .catch((): void => undefined);
    return (): void => {
      active = false;
    };
  }, [navigate]);

  const currentQuestion = (): string =>
    questionChoice === CUSTOM_QUESTION
      ? customQuestion.trim()
      : (PRESET_SECURITY_QUESTIONS[Number(questionChoice)] ?? '').trim();

  /** 单步校验：返回错误文案，通过返回 null。最后一步提交前会逐步跑一遍。 */
  const validateStep = (index: number): string | null => {
    if (index === 0) {
      if (username.trim() === '' || password === '') {
        return '用户名和密码不能为空';
      }
      if (password !== confirmPassword) {
        return '两次输入的密码不一致';
      }
    }
    if (index === 1) {
      if (currentQuestion() === '' || securityAnswer.trim() === '') {
        return '密保问题与答案不能为空';
      }
    }
    if (index === 3) {
      const raw: string = threshold.trim();
      if (!/^\d+$/.test(raw)) {
        return `临期阈值需为 ${EXPIRY_THRESHOLD_MIN} 至 ${EXPIRY_THRESHOLD_MAX} 之间的整数`;
      }
      const days: number = Number(raw);
      if (days < EXPIRY_THRESHOLD_MIN || days > EXPIRY_THRESHOLD_MAX) {
        return `临期阈值需为 ${EXPIRY_THRESHOLD_MIN} 至 ${EXPIRY_THRESHOLD_MAX} 之间的整数`;
      }
    }
    return null;
  };

  const goNext = (): void => {
    const error: string | null = validateStep(step);
    if (error !== null) {
      setErrorText(error);
      return;
    }
    setErrorText(null);
    setStep((value: number): number => Math.min(value + 1, STEP_ITEMS.length - 1));
  };

  const goBack = (): void => {
    setErrorText(null);
    setStep((value: number): number => Math.max(value - 1, 0));
  };

  const submit = async (): Promise<void> => {
    // 逐步复核，避免用户跳步后漏项。
    for (let index = 0; index < STEP_ITEMS.length; index += 1) {
      const error: string | null = validateStep(index);
      if (error !== null) {
        setStep(index);
        setErrorText(error);
        return;
      }
    }
    setErrorText(null);
    setSubmitting(true);
    try {
      await setup({
        username: username.trim(),
        password,
        securityQuestion: currentQuestion(),
        securityAnswer: securityAnswer.trim(),
        shopName: shopName.trim(),
        expiryThresholdDays: Number(threshold.trim()),
      });
      await refresh().catch((): void => undefined);
      message.success('初始化完成，请使用新账号登录');
      navigate(ROUTES.login, { replace: true });
    } catch (cause) {
      setErrorText(errorMessage(cause, '初始化失败，请稍后重试'));
    } finally {
      setSubmitting(false);
    }
  };

  const onFormSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (step < STEP_ITEMS.length - 1) {
      goNext();
      return;
    }
    void submit();
  };

  return (
    <div className="stockin-standalone is-centered">
      <div className="stockin-standalone-card" style={{ width: '100%', maxWidth: 520 }}>
        <h2
          style={{
            margin: '0 0 8px',
            fontSize: 'var(--stockin-fs-h1)',
            fontWeight: 600,
            letterSpacing: '-0.025em',
          }}
        >
          初始化设置
        </h2>
        <p
          style={{
            margin: '0 0 16px',
            fontSize: 'var(--stockin-fs-caption)',
            color: 'var(--stockin-color-muted)',
          }}
        >
          按步骤完成管理员账号、密保与店铺设置，之后即可开始使用。
        </p>

        <Steps
          className="stockin-setup-steps"
          current={step}
          size="small"
          labelPlacement="vertical"
          responsive={false}
          items={STEP_ITEMS}
          style={{ marginBottom: 20 }}
        />

        {errorText !== null ? (
          <Alert type="error" showIcon message={errorText} style={{ marginBottom: 16 }} />
        ) : null}

        <form onSubmit={onFormSubmit} noValidate>
          <div className="stockin-section-label">{STEP_HEADINGS[step]}</div>

          {step === 0 ? (
            <>
              <div style={{ marginBottom: 12 }}>
                <label className="stockin-field-label" htmlFor="setup-username">
                  用户名
                </label>
                <Input
                  id="setup-username"
                  value={username}
                  autoComplete="username"
                  aria-label="用户名"
                  placeholder="请输入用户名"
                  onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
                    setUsername(event.target.value)
                  }
                  style={{ minHeight: TOUCH_TARGET_MIN_PX }}
                />
              </div>
              <div style={{ marginBottom: 12 }}>
                <label className="stockin-field-label" htmlFor="setup-password">
                  密码
                </label>
                <Input.Password
                  id="setup-password"
                  value={password}
                  autoComplete="new-password"
                  aria-label="密码"
                  placeholder="请输入密码"
                  onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
                    setPassword(event.target.value)
                  }
                  style={{ minHeight: TOUCH_TARGET_MIN_PX }}
                />
              </div>
              <div style={{ marginBottom: 4 }}>
                <label className="stockin-field-label" htmlFor="setup-confirm-password">
                  确认密码
                </label>
                <Input.Password
                  id="setup-confirm-password"
                  value={confirmPassword}
                  autoComplete="new-password"
                  aria-label="确认密码"
                  placeholder="请再次输入密码"
                  onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
                    setConfirmPassword(event.target.value)
                  }
                  style={{ minHeight: TOUCH_TARGET_MIN_PX }}
                />
              </div>
            </>
          ) : null}

          {step === 1 ? (
            <>
              <div style={{ marginBottom: 12 }}>
                <label className="stockin-field-label" htmlFor="setup-question">
                  问题
                </label>
                <Select
                  id="setup-question"
                  value={questionChoice}
                  options={questionOptions}
                  aria-label="密保问题"
                  onChange={(value: string): void => setQuestionChoice(value)}
                  style={{ width: '100%', minHeight: TOUCH_TARGET_MIN_PX }}
                />
                {questionChoice === CUSTOM_QUESTION ? (
                  <Input
                    value={customQuestion}
                    aria-label="自定义密保问题"
                    placeholder="请输入自定义问题"
                    maxLength={120}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
                      setCustomQuestion(event.target.value)
                    }
                    style={{ marginTop: 8, minHeight: TOUCH_TARGET_MIN_PX }}
                  />
                ) : null}
              </div>
              <div style={{ marginBottom: 4 }}>
                <label className="stockin-field-label" htmlFor="setup-answer">
                  答案
                </label>
                <Input
                  id="setup-answer"
                  value={securityAnswer}
                  autoComplete="off"
                  aria-label="密保答案"
                  placeholder="请输入密保答案"
                  maxLength={256}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
                    setSecurityAnswer(event.target.value)
                  }
                  style={{ minHeight: TOUCH_TARGET_MIN_PX }}
                />
                <div className="stockin-field-hint">
                  忘记密码时需要原样回答，不区分大小写；请牢记，避免使用易被猜到的答案。
                </div>
              </div>
            </>
          ) : null}

          {step === 2 ? (
            <div style={{ marginBottom: 4 }}>
              <label className="stockin-field-label" htmlFor="setup-shop-name">
                店铺名称
              </label>
              <Input
                id="setup-shop-name"
                value={shopName}
                aria-label="店铺名称"
                placeholder="请输入店铺名称"
                maxLength={SHOP_NAME_MAX_LENGTH}
                onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
                  setShopName(event.target.value)
                }
                style={{ minHeight: TOUCH_TARGET_MIN_PX }}
              />
              <div className="stockin-field-hint">显示在左侧品牌位，可留空。</div>
            </div>
          ) : null}

          {step === 3 ? (
            <div style={{ marginBottom: 4 }}>
              <label className="stockin-field-label" htmlFor="setup-threshold">
                天数
              </label>
              <Input
                id="setup-threshold"
                value={threshold}
                inputMode="numeric"
                aria-label="临期阈值天数"
                placeholder="30"
                onChange={(event: React.ChangeEvent<HTMLInputElement>): void =>
                  setThreshold(event.target.value)
                }
                style={{ minHeight: TOUCH_TARGET_MIN_PX }}
              />
              <div className="stockin-field-hint">
                距到期日不超过该天数的记录计入临期，默认 30 天。
              </div>
            </div>
          ) : null}

          {step === 4 ? (
            <div style={{ marginBottom: 4 }}>
              <div className="stockin-field-label">选择界面主题</div>
              <div className="stockin-btn-row" role="group" aria-label="界面主题">
                {THEME_MODE_OPTIONS.map((option) => {
                  const active: boolean = mode === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={active}
                      onClick={(): void => setMode(option.value)}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        minHeight: TOUCH_TARGET_MIN_PX,
                        padding: '0 14px',
                        borderRadius: 'var(--stockin-radius)',
                        border: `1px solid ${active ? 'var(--stockin-color-primary)' : 'var(--stockin-color-control-border)'}`,
                        background: active
                          ? 'var(--stockin-color-primary-bg)'
                          : 'var(--stockin-color-surface)',
                        color: active
                          ? 'var(--stockin-color-primary-text)'
                          : 'var(--stockin-color-text)',
                        fontFamily: 'var(--stockin-font-sans)',
                        fontSize: 'var(--stockin-fs-body)',
                        cursor: 'pointer',
                      }}
                    >
                      <Icon name={THEME_ICONS[option.value]} size="sm" />
                      {option.label}
                    </button>
                  );
                })}
              </div>
              <div className="stockin-field-hint">之后可在「设置 → 外观」随时切换。</div>
            </div>
          ) : null}

          <div className="stockin-btn-row" style={{ marginTop: 20 }}>
            {step > 0 ? (
              <Button onClick={goBack} style={{ minHeight: TOUCH_TARGET_MIN_PX, flex: 1 }}>
                上一步
              </Button>
            ) : null}
            <Button
              type="primary"
              htmlType="submit"
              loading={submitting}
              style={{ minHeight: TOUCH_TARGET_MIN_PX, flex: 2 }}
            >
              {step < STEP_ITEMS.length - 1 ? '下一步' : '完成初始化'}
            </Button>
          </div>
        </form>

        <div style={{ marginTop: 12, textAlign: 'center' }}>
          <button
            type="button"
            className="stockin-link-btn"
            onClick={(): void => navigate(ROUTES.login)}
          >
            返回登录
          </button>
        </div>
      </div>
    </div>
  );
};

export default SetupPage;
