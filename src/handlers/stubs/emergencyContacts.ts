/**
 * [EMERGENCY-CONTACTS-STUB] GET /emergency-contacts/info (auth) — the app's
 * account/security page calls this on open. Legacy/emergency contacts are
 * outside core scope, and the honest answer for a server that has never
 * stored one is "none of the four lists has anything in it".
 *
 * Oracle capture 2026-08-17 (fresh, fully set-up account):
 *   {"contacts":[],"recoverSessions":[],"othersEmergencyContact":[],
 *    "othersRecoverySession":[]}
 * Key order and all four list names are museum's. D35.
 */

import type { Context } from 'hono';
import type { Deps } from '../../deps.ts';

export const emergencyContactsInfo = (_deps: Deps) => async (c: Context) =>
  c.json({
    contacts: [],
    recoverSessions: [],
    othersEmergencyContact: [],
    othersRecoverySession: [],
  });
