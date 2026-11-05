/**
 * pino JSON → stdout，按文档 §7.6 / §5.2 做脱敏。
 * 容器不写日志文件；redact 覆盖 Cookie、密码类字段与备注全文。
 */
import pino, { type Logger, type LoggerOptions } from 'pino';

/** 需要脱敏的字段路径（pino redact paths 语法）。 */
export const REDACT_PATHS: readonly string[] = [
  'req.headers.cookie',
  'headers.cookie',
  'res.headers.set-cookie',
  'cookie',
  'password',
  'currentPassword',
  'newPassword',
  'passwordHash',
  'salt',
  'token',
  'tokenHash',
  'remark',
  '*.remark',
  'detail.remark',
  '*.password',
  '*.currentPassword',
  '*.newPassword',
  '*.token',
  '*.cookie',
];

export const REDACT_CENSOR = '[REDACTED]';

/** 创建 logger；level 缺省 production=info / development=debug。 */
export function createLogger(level?: string): Logger {
  const resolvedLevel: string =
    level ?? process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'development' ? 'debug' : 'info');
  const options: LoggerOptions = {
    level: resolvedLevel,
    base: { service: 'stockin-server' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [...REDACT_PATHS],
      censor: REDACT_CENSOR,
    },
  };
  return pino(options, process.stdout);
}

/** 进程级单例，供 lib / repositories / CLI 共用。 */
export const logger: Logger = createLogger();
