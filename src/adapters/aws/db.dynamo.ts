/**
 * DynamoDB implementation of the Db port — LocalStack and real AWS
 * (endpoint override only). Pattern inherited from immich-serverless.
 */

import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import {
  ConditionFailedError,
  type Db,
  type Item,
  type QueryOptions,
  type TransactOp,
  type UpdatePatch,
} from '../../ports/db.ts';
import type { Config } from '../../config.ts';
import { getDocClient } from './clients.ts';

const INDEX_KEYS = {
  gsi1: { pk: 'gsi1pk', sk: 'gsi1sk', name: 'gsi1' },
  gsi2: { pk: 'gsi2pk', sk: 'gsi2sk', name: 'gsi2' },
  gsi3: { pk: 'gsi3pk', sk: 'gsi3sk', name: 'gsi3' },
} as const;

function buildUpdate(patch: UpdatePatch) {
  const sets: string[] = [];
  const removes: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  let i = 0;
  for (const [attr, value] of Object.entries(patch)) {
    const nk = `#a${i}`;
    names[nk] = attr;
    if (value === undefined) {
      removes.push(nk);
    } else {
      const vk = `:v${i}`;
      values[vk] = value;
      sets.push(`${nk} = ${vk}`);
    }
    i += 1;
  }
  const clauses = [
    sets.length ? `SET ${sets.join(', ')}` : '',
    removes.length ? `REMOVE ${removes.join(', ')}` : '',
  ].filter(Boolean);
  return { expression: clauses.join(' '), names, values };
}

function buildCounter(deltas: Record<string, number>, set?: Record<string, unknown>) {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const adds: string[] = [];
  const sets: string[] = [];
  let i = 0;
  for (const [attr, delta] of Object.entries(deltas)) {
    names[`#c${i}`] = attr;
    values[`:d${i}`] = delta;
    adds.push(`#c${i} :d${i}`);
    i += 1;
  }
  for (const [attr, value] of Object.entries(set ?? {})) {
    names[`#s${i}`] = attr;
    values[`:s${i}`] = value;
    sets.push(`#s${i} = :s${i}`);
    i += 1;
  }
  const expression = [sets.length ? `SET ${sets.join(', ')}` : '', adds.length ? `ADD ${adds.join(', ')}` : '']
    .filter(Boolean)
    .join(' ');
  return { expression, names, values };
}

export class DynamoDb implements Db {
  constructor(private config: Config) {}

  private get table() {
    return this.config.tableName;
  }

  async get<T extends Item = Item>(pk: string, sk: string): Promise<T | null> {
    const res = await getDocClient(this.config).send(
      new GetCommand({ TableName: this.table, Key: { pk, sk } }),
    );
    return (res.Item as T) ?? null;
  }

  async put(item: Item, opts?: { ifNotExists?: boolean }): Promise<void> {
    try {
      await getDocClient(this.config).send(
        new PutCommand({
          TableName: this.table,
          Item: item,
          ...(opts?.ifNotExists ? { ConditionExpression: 'attribute_not_exists(pk)' } : {}),
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) throw new ConditionFailedError();
      throw err;
    }
  }

  async update(pk: string, sk: string, patch: UpdatePatch): Promise<void> {
    const { expression, names, values } = buildUpdate(patch);
    if (!expression) return;
    try {
      await getDocClient(this.config).send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk, sk },
          UpdateExpression: expression,
          ExpressionAttributeNames: names,
          ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
          ConditionExpression: 'attribute_exists(pk)',
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        throw new ConditionFailedError(`no item at ${pk}/${sk}`);
      }
      throw err;
    }
  }

  async delete(pk: string, sk: string): Promise<void> {
    await getDocClient(this.config).send(
      new DeleteCommand({ TableName: this.table, Key: { pk, sk } }),
    );
  }

  async query<T extends Item = Item>(pk: string, opts: QueryOptions = {}): Promise<T[]> {
    const { index, skPrefix, limit, scanForward = true, skFrom, skTo } = opts;
    const keyDef = index ? INDEX_KEYS[index] : { pk: 'pk', sk: 'sk', name: undefined };

    const names: Record<string, string> = { '#pk': keyDef.pk };
    const values: Record<string, unknown> = { ':pk': pk };
    let keyExpr = '#pk = :pk';

    if (skFrom !== undefined && skTo !== undefined) {
      names['#sk'] = keyDef.sk;
      values[':from'] = skFrom;
      values[':to'] = skTo;
      keyExpr += ' AND #sk BETWEEN :from AND :to';
    } else if (skFrom !== undefined) {
      names['#sk'] = keyDef.sk;
      values[':from'] = skFrom;
      keyExpr += ' AND #sk >= :from';
    } else if (skTo !== undefined) {
      names['#sk'] = keyDef.sk;
      values[':to'] = skTo;
      keyExpr += ' AND #sk <= :to';
    } else if (skPrefix !== undefined) {
      names['#sk'] = keyDef.sk;
      values[':prefix'] = skPrefix;
      keyExpr += ' AND begins_with(#sk, :prefix)';
    }

    const out: T[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const res = await getDocClient(this.config).send(
        new QueryCommand({
          TableName: this.table,
          ...(keyDef.name ? { IndexName: keyDef.name } : {}),
          KeyConditionExpression: keyExpr,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ScanIndexForward: scanForward,
          ...(limit ? { Limit: limit } : {}),
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
        }),
      );
      out.push(...((res.Items ?? []) as T[]));
      lastKey = res.LastEvaluatedKey;
      if (limit && out.length >= limit) return out.slice(0, limit);
    } while (lastKey);

    return out;
  }

  async addToCounters(pk: string, sk: string, deltas: Record<string, number>): Promise<void> {
    const { expression, names, values } = buildCounter(deltas);
    await getDocClient(this.config).send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk, sk },
        UpdateExpression: expression,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
  }

  async transactWrite(ops: TransactOp[]): Promise<void> {
    const items = ops.map((op) => {
      if (op.kind === 'put') {
        return {
          Put: {
            TableName: this.table,
            Item: op.item!,
            ...(op.ifNotExists ? { ConditionExpression: 'attribute_not_exists(pk)' } : {}),
          },
        };
      }
      if (op.kind === 'delete') {
        return { Delete: { TableName: this.table, Key: op.key! } };
      }
      const { expression, names, values } = buildCounter(op.deltas ?? {}, op.set);
      return {
        Update: {
          TableName: this.table,
          Key: op.key!,
          UpdateExpression: expression,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        },
      };
    });
    try {
      await getDocClient(this.config).send(new TransactWriteCommand({ TransactItems: items }));
    } catch (err) {
      if (err instanceof TransactionCanceledException) {
        const conditionFailed = err.CancellationReasons?.some(
          (r) => r.Code === 'ConditionalCheckFailed',
        );
        if (conditionFailed) throw new ConditionFailedError();
      }
      throw err;
    }
  }
}
