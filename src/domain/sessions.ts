/** Token/session management shared by logout, sessions list, SRP update. */

import type { Deps } from '../deps.ts';
import { gsi } from './model.ts';
import { tokenHash } from './tokens.ts';
import type { TokenRowShape } from './users.ts';

export const listTokenRows = async (deps: Deps, userId: number): Promise<TokenRowShape[]> =>
  deps.db.query<TokenRowShape>(gsi.userTokens(userId), { index: 'gsi3' });

export const revokeToken = async (deps: Deps, token: string): Promise<void> => {
  await deps.db.delete(`TOKEN#${tokenHash(token)}`, 'META');
};

/** Terminate one session by its plaintext token, owner-checked. */
export const revokeUserToken = async (deps: Deps, userId: number, token: string): Promise<boolean> => {
  const row = await deps.db.get<TokenRowShape>(`TOKEN#${tokenHash(token)}`, 'META');
  if (!row || row.userId !== userId) return false;
  await deps.db.delete(row.pk, row.sk);
  return true;
};

export const revokeOtherTokens = async (deps: Deps, userId: number, keepToken: string): Promise<void> => {
  const rows = await listTokenRows(deps, userId);
  for (const row of rows) {
    if (row.token === keepToken) continue;
    await deps.db.delete(row.pk, row.sk);
  }
};
