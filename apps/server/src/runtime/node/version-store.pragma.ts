/**
 * Node 运行时：`PRAGMA user_version` 作为 schema 版本存放位置。
 *
 * 与改造前完全一致 —— 本文件只是把 `db.ts` / `schema.ts` 里原有的两条实现
 * 挂到 `VersionStore` 接口上，没有新增语义。
 */
import type { Db } from '../../repositories/db';
import { readUserVersion } from '../../repositories/db';
import {
  consumeRollbackAllowance,
  writeRollbackAllowance,
  type RollbackAllowance,
} from '../../repositories/schema';
import type { VersionStore } from '../ports';

/** 一次性放行凭据落盘目录；由 `loadEnv().dataDir` 在装配时注入。 */
export interface PragmaVersionStoreOptions {
  readonly dataDir: string;
}

export function createPragmaVersionStore(options: PragmaVersionStoreOptions): VersionStore {
  return {
    kind: 'pragma',

    read(db: Db): number {
      return readUserVersion(db);
    },

    write(db: Db, version: number): void {
      // 迁移脚本末尾自带 `PRAGMA user_version = {{SCHEMA_VERSION}}`，
      // 这里再写一次是幂等的：两条路径（脚本内写入 / 端口写入）版本值必然相同，
      // 保留端口写入是为了让 Workers 侧（表存储）与 Node 侧走同一段 runner 代码。
      db.exec(`PRAGMA user_version = ${String(version)}`);
    },

    consumeRollbackAllowance(_db: Db): RollbackAllowance | null {
      return consumeRollbackAllowance(options.dataDir);
    },

    writeRollbackAllowance(_db: Db, allowance: RollbackAllowance): void {
      writeRollbackAllowance(options.dataDir, allowance);
    },
  };
}
