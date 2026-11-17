/**
 * `@stockin/shared` 统一导出面。
 *
 * 承载 DTO、枚举、错误码、常量、Zod schema 与 EXCEL_HEADERS。
 * 本包不得反向依赖 `@stockin/domain`，也不得引入任何框架或 IO 依赖。
 */
export * from './enums';
export * from './errors';
export * from './constants';
export * from './excel-headers';
export * from './security';

export * from './dto/common.dto';
export * from './dto/record.dto';
export * from './dto/auth.dto';
export * from './dto/dashboard.dto';
export * from './dto/excel.dto';

export * from './schema/record.schema';
export * from './schema/auth.schema';
export * from './schema/excel.schema';
export * from './schema/settings.schema';
