/**
 * 统一错误信封与 HTTP 状态白名单。
 *
 * 依据：设计文档 v1.1 §3.5「错误信封 { code, message, details?, requestId }；
 * HTTP 严格限定 400/401/403/404/409/413/422/429/500/503」。
 * 复用 shared 的 makeErrorPayload / httpStatusFor / isAllowedHttpStatus，
 * 不在此处重写错误码表或消息模板。
 */
import type { Context } from 'hono';
import {
  httpStatusFor,
  isAllowedHttpStatus,
  makeErrorPayload,
  SECURITY_HEADERS,
  type ErrorCode,
  type ErrorPayload,
} from '@stockin/shared';

/** 取错误码对应状态，并用白名单做运行时守卫。 */
export function resolveErrorStatus(code: ErrorCode): number {
  const status: number = httpStatusFor(code);
  if (!isAllowedHttpStatus(status)) {
    throw new RangeError(`[response] 错误码 ${code} 映射到白名单外状态: ${status}`);
  }
  return status;
}

/** 构造错误信封对象（供日志与测试直接消费）。 */
export function errorEnvelope(code: ErrorCode, requestId: string, details?: unknown): ErrorPayload {
  return makeErrorPayload(code, requestId, details);
}

/**
 * 构造错误响应。使用原生 Response，避免与 T03b 的 Hono 泛型 Context 绑死；
 * 同时下发 no-store 与 requestId，便于前端 5xx 展示。
 */
export function errorResponse(code: ErrorCode, requestId: string, details?: unknown): Response {
  const payload: ErrorPayload = errorEnvelope(code, requestId, details);
  return new Response(JSON.stringify(payload), {
    status: resolveErrorStatus(code),
    headers: {
      'content-type': 'application/json; charset=UTF-8',
      'cache-control': SECURITY_HEADERS.CACHE_CONTROL_API,
      'x-request-id': requestId,
    },
  });
}

/** T03b handler 便捷入口：参数 c 保留用于未来附加响应头。 */
export function sendError(
  c: Context,
  code: ErrorCode,
  requestId: string,
  details?: unknown,
): Response {
  void c;
  return errorResponse(code, requestId, details);
}

/** 通用 JSON 成功响应（统一 no-store 语义由各路由决定，此处不强制）。 */
export function jsonResponse(data: unknown, status: number = 200): Response {
  if (!isAllowedHttpStatus(status) && status !== 200 && status !== 201) {
    throw new RangeError(`[response] 非白名单状态: ${status}`);
  }
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=UTF-8' },
  });
}
