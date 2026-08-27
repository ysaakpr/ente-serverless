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

/** DynamoDB's TransactWriteItems ceiling; both adapters refuse larger batches. */
export const MAX_TRANSACT_OPS = 100;

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
  /**
   * Atomic ADD that returns the post-increment values, so a caller can enforce
   * a cap on a number nobody else can have observed (increment first, judge
   * second). `set` lands alongside the ADD, the way TransactOp counters do.
   * Creates the item when missing — rows reached this way must carry a `ttl`
   * (via `set` or on creation) or an attacker can conjure unexpiring rows.
   */
  addToCountersReturning(
    pk: string,
    sk: string,
    deltas: Record<string, number>,
    set?: Record<string, unknown>,
  ): Promise<Record<string, number>>;
  /** Atomic all-or-nothing batch, at most MAX_TRANSACT_OPS ops (the DynamoDB
   * TransactWriteItems limit — larger batches throw before touching the table). */
  transactWrite(ops: TransactOp[]): Promise<void>;
}

export class ConditionFailedError extends Error {
  constructor(message = 'condition failed') {
    super(message);
    this.name = 'ConditionFailedError';
  }
}
