/**
 * Db port — single-table design (build plan §1):
 *   pk / sk           primary key
 *   gsi1pk / gsi1sk   collection-file diff feed (COL#<id>#DIFF / <updationTime padded>#<fileID>)
 *   gsi2pk / gsi2sk   collection change feed per owner (USER#<id>#COLS / <updationTime>)
 *   gsi3pk / gsi3sk   token list per user (USER#<id>#TOKENS / <createdAt>)
 * Pattern inherited from immich-serverless (it earned its keep).
 */

export interface Item {
  pk: string;
  sk: string;
  [attr: string]: unknown;
}

export interface QueryOptions {
  skPrefix?: string;
  index?: 'gsi1' | 'gsi2' | 'gsi3';
  limit?: number;
  /** false = descending. Default true. */
  scanForward?: boolean;
  /** Sort-key range bounds (inclusive). */
  skFrom?: string;
  skTo?: string;
}

export type UpdatePatch = Record<string, unknown>;

export interface TransactOp {
  kind: 'put' | 'delete' | 'counter';
  item?: Item;
  key?: { pk: string; sk: string };
  /** Fail the whole transaction if this key already exists. */
  ifNotExists?: boolean;
  /** `counter` only: attribute -> delta; `set` lands alongside. */
  deltas?: Record<string, number>;
  set?: Record<string, unknown>;
}

export interface Db {
  get<T extends Item = Item>(pk: string, sk: string): Promise<T | null>;
  put(item: Item, opts?: { ifNotExists?: boolean }): Promise<void>;
  update(pk: string, sk: string, patch: UpdatePatch): Promise<void>;
  delete(pk: string, sk: string): Promise<void>;
  query<T extends Item = Item>(pk: string, opts?: QueryOptions): Promise<T[]>;
  /** Atomic numeric ADD; creates the item when missing. */
  addToCounters(pk: string, sk: string, deltas: Record<string, number>): Promise<void>;
  transactWrite(ops: TransactOp[]): Promise<void>;
}

export class ConditionFailedError extends Error {
  constructor(message = 'condition failed') {
    super(message);
    this.name = 'ConditionFailedError';
  }
}
