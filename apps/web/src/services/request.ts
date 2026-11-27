/**
 * 前端统一请求拦截层。
 *
 * 依据：设计文档 v1.1 §3.5「前端统一动作」+ 主理人 T04 口径 ①。
 *
 * - `credentials: 'same-origin'`（同源写入 HttpOnly Cookie）；
 * - 业务请求 `cache: 'no-store'`；
 * - 401 跳登录 / 403 `AUTH_INIT_REQUIRED` 跳引导 / 429 读 `Retry-After` /
 *   422 把 `details`（字段错误或 Excel 物理行号报告）交给调用方渲染 / 5xx 展示 `requestId`；
 * - **任何请求都不自动重试**（尤其写操作）；
 * - **不新增任何自定义 CSRF 头**：服务端按 `Origin` / `Host` 字面量精确比对。
 *
 * 导航与全局提示通过注册器注入（由 `src/app.tsx` 绑定 `history` / antd `message`），
 * 使本模块不反向依赖运行时配置，彻底避免循环导入。
 */
import type { ErrorEnvelope } from '@stockin/shared';

/** 全局提示级别。 */
export type NoticeLevel = 'error' | 'warning' | 'info' | 'success';

type Navigator = (path: string) => void;
type Notifier = (level: NoticeLevel, content: string) => void;

let navigate: Navigator = (path: string): void => {
  if (typeof window !== 'undefined') {
    window.location.assign(path);
  }
};
let notify: Notifier = (_level: NoticeLevel, content: string): void => {
  // 未注入时的降级：仅写控制台，不弹 UI（app.tsx 加载后会被替换）。
  if (typeof console !== 'undefined') {
    console.warn('[request]', content);
  }
};

/** 绑定 SPA 导航器（app.tsx 注入 `history.push`）。 */
export function setRequestNavigator(fn: Navigator): void {
  navigate = fn;
}

/** 绑定全局提示器（app.tsx 注入 antd `message`）。 */
export function setRequestNotifier(fn: Notifier): void {
  notify = fn;
}

/** 结构化 API 错误：所有非 2xx 统一抛出，调用方据此渲染。 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string;
  readonly details: unknown;
  readonly retryAfterSeconds: number | null;

  constructor(
    status: number,
    code: string,
    message: string,
    requestId: string,
    details?: unknown,
    retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.details = details ?? null;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** 请求方法白名单（不开放其它方法，避免意外写操作）。 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface RequestOptions {
  readonly method?: HttpMethod;
  /** JSON 请求体（自动设置 Content-Type: application/json）。 */
  readonly json?: unknown;
  /** multipart/form-data 请求体（不手动设置 Content-Type，交给浏览器补 boundary）。 */
  readonly form?: FormData;
  /** 原始二进制请求体（用于恢复分块上传，固定 application/octet-stream）。 */
  readonly bytes?: Uint8Array;
  /** 查询参数（undefined / 空串自动省略）。 */
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly signal?: AbortSignal;
  /**
   * 抑制 4xx 的全局提示（用于调用方自行内联渲染的 422 / 401 场景）。
   * 注意：5xx 的 requestId 提示永不抑制；写操作永不重试，与此处无关。
   */
  readonly silent?: boolean;
}

/**
 * 管理员端点独立判定：其 401 由管理台页面自行处理（跳 /admin/login），
 * 不能触发店主侧的「跳 /login」动作，否则两套身份会被串到一起。
 */
function isAdminPath(path: string): boolean {
  return path === '/api/admin' || path.startsWith('/api/admin/');
}

const AUTH_PATH_PREFIXES: readonly string[] = [
  '/api/auth/login',
  '/api/auth/setup',
  '/api/auth/init-status',
  '/api/auth/me',
  '/api/auth/logout',
  '/api/auth/change-password',
  '/api/auth/security',
  '/api/auth/security-question',
  '/api/auth/forgot-password',
  '/api/health',
];

function isAuthPath(path: string): boolean {
  return AUTH_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}?`));
}

function isOnPath(pathname: string): boolean {
  return typeof window !== 'undefined' && window.location.pathname === pathname;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  if (query === undefined) {
    return path;
  }
  const params: URLSearchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '') {
      continue;
    }
    params.set(key, String(value));
  }
  const search: string = params.toString();
  return search === '' ? path : `${path}?${search}`;
}

function parseRetryAfter(raw: string | null): number | null {
  if (raw === null) {
    return null;
  }
  const seconds: number = Number.parseInt(raw, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/** 解析错误信封；非 JSON / 结构异常时给出兜底。 */
async function parseEnvelope(response: Response): Promise<{
  code: string;
  message: string;
  requestId: string;
  details: unknown;
}> {
  let payload: Partial<ErrorEnvelope> | null = null;
  try {
    payload = (await response.json()) as Partial<ErrorEnvelope>;
  } catch {
    payload = null;
  }
  const headerRequestId: string = response.headers.get('x-request-id') ?? '';
  return {
    code: typeof payload?.code === 'string' ? payload.code : 'COMMON_INTERNAL',
    message:
      typeof payload?.message === 'string' && payload.message !== ''
        ? payload.message
        : '请求未完成，稍后重试',
    requestId:
      typeof payload?.requestId === 'string' && payload.requestId !== ''
        ? payload.requestId
        : headerRequestId,
    details: payload?.details ?? null,
  };
}

/** 非 2xx 的统一动作矩阵；返回待抛出的 ApiError。 */
async function toApiError(response: Response, options: RequestOptions, path: string): Promise<ApiError> {
  const envelope = await parseEnvelope(response);
  const retryAfterSeconds: number | null = parseRetryAfter(response.headers.get('retry-after'));
  const error: ApiError = new ApiError(
    response.status,
    envelope.code,
    envelope.message,
    envelope.requestId,
    envelope.details,
    retryAfterSeconds,
  );

  switch (response.status) {
    case 401: {
      // 认证端点自身的 401（账密错误 / 未登录探测）不跳转，交调用方内联渲染。
      // 管理员端点同理，由管理台页面处理，绝不跳到店主 /login。
      if (!isAuthPath(path) && !isAdminPath(path) && !isOnPath('/login')) {
        navigate('/login');
      }
      if (!options.silent && !isAuthPath(path) && !isAdminPath(path)) {
        notify('warning', '登录状态已失效，重新登录');
      }
      break;
    }
    case 403: {
      if (envelope.code === 'AUTH_INIT_REQUIRED' && !isOnPath('/setup')) {
        navigate('/setup');
      }
      if (!options.silent && envelope.code !== 'AUTH_INIT_REQUIRED') {
        notify('warning', envelope.message);
      }
      break;
    }
    case 413: {
      if (!options.silent) {
        notify('warning', envelope.message);
      }
      break;
    }
    case 422: {
      // 字段错误 / Excel 错误行报告由调用方内联渲染，此处不弹全局提示。
      break;
    }
    case 429: {
      const hint: string =
        retryAfterSeconds !== null ? `${retryAfterSeconds} 秒后重试` : '稍后重试';
      notify('warning', `${envelope.message}（${hint}）`);
      break;
    }
    default: {
      if (response.status >= 500) {
        // 操作编号保留在 ApiError 与 ErrorView 的「技术信息」展开区，不放进全局提示。
        notify('error', envelope.message);
      } else if (!options.silent) {
        notify('warning', envelope.message);
      }
      break;
    }
  }
  return error;
}

/** 发起一次请求并返回原始 Response（不自动重试）。 */
async function rawFetch(path: string, options: RequestOptions): Promise<Response> {
  const method: HttpMethod = options.method ?? 'GET';
  const headers: Record<string, string> = {};
  let body: BodyInit | undefined;
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.json);
  } else if (options.form !== undefined) {
    body = options.form;
  } else if (options.bytes !== undefined) {
    headers['Content-Type'] = 'application/octet-stream';
    // 显式复制一份，避免 subarray 上传时把底层大缓冲整体交给 fetch。
    body = options.bytes.slice().buffer as ArrayBuffer;
  }
  return fetch(buildUrl(path, options.query), {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers,
    body,
    signal: options.signal,
  });
}

/** 网络异常（fetch 抛错）包装为 ApiError，保留统一错误面。 */
async function networkError(_cause: unknown): Promise<ApiError> {
  // 浏览器异常文本是英文（如 Failed to fetch），不上屏；技术细节留在控制台。
  if (typeof console !== 'undefined') {
    console.warn('[request] network error', _cause);
  }
  const text = '无法连接到服务器';
  notify('error', text);
  return new ApiError(0, 'COMMON_INTERNAL', text, '', null, null);
}

/**
 * JSON 请求：2xx 解析为 `T`；非 2xx 执行动作矩阵后抛出 `ApiError`。
 * 204 / 空响应体返回 `undefined as T`。
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let response: Response;
  try {
    response = await rawFetch(path, options);
  } catch (cause) {
    throw await networkError(cause);
  }
  if (!response.ok) {
    throw await toApiError(response, options, path);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  const text: string = await response.text();
  if (text === '') {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}

/** 二进制响应（含解析出的下载文件名）。 */
export interface BlobResult {
  readonly blob: Blob;
  readonly filename: string;
}

const DEFAULT_DOWNLOAD_NAME = 'stockin.xlsx';

/** 从 `content-disposition` 解析 `filename` / `filename*`（兼容引号与 UTF-8）。 */
export function parseDownloadFilename(disposition: string | null): string {
  if (disposition === null) {
    return DEFAULT_DOWNLOAD_NAME;
  }
  const utf8: RegExpExecArray | null = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition);
  if (utf8 !== null && utf8[1] !== undefined) {
    try {
      return decodeURIComponent(utf8[1].trim().replace(/^"|"$/g, ''));
    } catch {
      return DEFAULT_DOWNLOAD_NAME;
    }
  }
  const plain: RegExpExecArray | null = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition);
  if (plain !== null && plain[1] !== undefined) {
    return plain[1].trim();
  }
  return DEFAULT_DOWNLOAD_NAME;
}

/**
 * 下载请求：`fetch → blob → createObjectURL → <a download> → revokeObjectURL`。
 * POST 导出不能用裸 `<a href>`，故统一走此函数。
 */
export async function download(path: string, options: RequestOptions = {}): Promise<BlobResult> {
  let response: Response;
  try {
    response = await rawFetch(path, options);
  } catch (cause) {
    throw await networkError(cause);
  }
  if (!response.ok) {
    throw await toApiError(response, options, path);
  }
  const blob: Blob = await response.blob();
  const filename: string = parseDownloadFilename(response.headers.get('content-disposition'));
  const url: string = URL.createObjectURL(blob);
  const anchor: HTMLAnchorElement = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
  return { blob, filename };
}

/** 从任意异常提取 requestId（供 ErrorView 展示 5xx 链路号）。 */
export function errorRequestId(error: unknown): string {
  return error instanceof ApiError ? error.requestId : '';
}

/**
 * 从 `details` 里取可执行的原因文案。
 *
 * 服务端对语义校验失败（金额与单价×数量不一致、日期不合法……）会在
 * `details.reason` 给出具体原因，比信封上的「请求数据校验失败」有用得多；
 * 单据明细还有 `details.index`（那一行会单独高亮）。
 */
function detailsReason(details: unknown): string | null {
  if (typeof details !== 'object' || details === null) {
    return null;
  }
  const reason: unknown = (details as { reason?: unknown }).reason;
  return typeof reason === 'string' && reason.trim() !== '' ? reason : null;
}

/** 从任意异常提取用户可读文案。 */
export function errorMessage(error: unknown, fallback: string = '操作失败'): string {
  if (error instanceof ApiError) {
    // `details.reason` 优先：422 的信封文案是通用的，原因才指导用户怎么改。
    return detailsReason(error.details) ?? error.message;
  }
  // 非 ApiError 的 Error 多为浏览器英文异常，只有中文文案才直接上屏。
  if (error instanceof Error && error.message !== '' && /[\u4e00-\u9fa5]/.test(error.message)) {
    return error.message;
  }
  return fallback;
}
