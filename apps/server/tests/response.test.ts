/**
 * 统一错误信封单测。
 *
 * 路由层全部经 `errorResponse` 出口，这里错了就是所有错误响应一起错：
 * 状态码是否落在白名单、`no-store` 是否下发、`x-request-id` 是否回带给前端。
 * 此前这些只被 HTTP 集成用例顺带覆盖，**抛错守卫与 jsonResponse 的状态校验
 * 完全没有用例**。
 */
import type { Context } from 'hono';
import { describe, expect, it } from 'vitest';
import { ErrorCode, SECURITY_HEADERS } from '@stockin/shared';
import {
  errorEnvelope,
  errorResponse,
  jsonResponse,
  resolveErrorStatus,
  sendError,
} from '../src/lib/response';

describe('resolveErrorStatus', () => {
  it('按 shared 的映射表返回状态码', () => {
    expect(resolveErrorStatus(ErrorCode.ADMIN_FORBIDDEN)).toBe(403);
    expect(resolveErrorStatus(ErrorCode.ADMIN_OAUTH_FAILED)).toBe(401);
    expect(resolveErrorStatus(ErrorCode.COMMON_NOT_READY)).toBe(503);
    expect(resolveErrorStatus(ErrorCode.COMMON_NOT_FOUND)).toBe(404);
  });

  it('映射到白名单外的状态时抛 RangeError（防止新增错误码漏配）', () => {
    // 未登记的错误码在映射表里是 undefined，属于白名单外。
    expect(() => resolveErrorStatus('NOT_A_REAL_CODE' as ErrorCode)).toThrow(RangeError);
  });
});

describe('errorEnvelope / errorResponse', () => {
  it('信封含 code / message / requestId，details 原样透传', () => {
    const payload = errorEnvelope(ErrorCode.VALID_FAILED, 'req-1', { issues: [{ path: ['x'] }] });
    expect(payload).toMatchObject({ code: ErrorCode.VALID_FAILED, requestId: 'req-1' });
    expect(payload.details).toEqual({ issues: [{ path: ['x'] }] });
    expect(typeof payload.message).toBe('string');
  });

  it('错误响应带 no-store、JSON 类型、回传 x-request-id', async () => {
    const response = errorResponse(ErrorCode.RECORD_NOT_FOUND, 'req-2');
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe(SECURITY_HEADERS.CACHE_CONTROL_API);
    expect(response.headers.get('x-request-id')).toBe('req-2');

    const body = (await response.json()) as { code: string; requestId: string };
    expect(body.code).toBe(ErrorCode.RECORD_NOT_FOUND);
    expect(body.requestId).toBe('req-2');
  });

  it('sendError 与 errorResponse 等价（Context 目前不参与构造）', async () => {
    const response = sendError({} as Context, ErrorCode.COMMON_FORBIDDEN, 'req-3');
    expect(response.status).toBe(403);
    expect(response.headers.get('x-request-id')).toBe('req-3');
  });
});

describe('jsonResponse', () => {
  it('默认 200，显式 201 也允许', async () => {
    const ok = jsonResponse({ a: 1 });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ a: 1 });

    const created = jsonResponse({ id: 1 }, 201);
    expect(created.status).toBe(201);
  });

  it('白名单外状态（如 418）直接抛错，而不是悄悄发出去', () => {
    expect(() => jsonResponse({}, 418)).toThrow(RangeError);
  });
});
