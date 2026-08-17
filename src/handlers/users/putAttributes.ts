/**
 * PUT /users/attributes (auth) — src: ente/user.go SetUserAttributesRequest +
 * controller SetAttributes: 403 once set; KDF strength must equal 4 GiB
 * (memLimit * opsLimit) with memLimit >= 128 MiB. Blobs are otherwise opaque.
 */

import type { Context } from 'hono';
import { z } from 'zod';
import type { Deps } from '../../deps.ts';
import { auth } from '../../middleware/auth.ts';
import { getKeyAttributes, putKeyAttributes, type KeyAttributes } from '../../domain/users.ts';
import { badRequest, errBadRequestSentinel, errPermissionDenied } from '../../lib/errors.ts';

const EXPECTED_KDF_STRENGTH = 1073741824 * 4;
const MIN_MEM_LIMIT = 128 * 1024 * 1024;

const keyAttributesSchema = z.object({
  kekSalt: z.string().min(1),
  kekHash: z.string().optional().default(''),
  encryptedKey: z.string().min(1),
  keyDecryptionNonce: z.string().min(1),
  publicKey: z.string().min(1),
  encryptedSecretKey: z.string().min(1),
  secretKeyDecryptionNonce: z.string().min(1),
  memLimit: z.number(),
  opsLimit: z.number(),
  masterKeyEncryptedWithRecoveryKey: z.string().optional().default(''),
  masterKeyDecryptionNonce: z.string().optional().default(''),
  recoveryKeyEncryptedWithMasterKey: z.string().optional().default(''),
  recoveryKeyDecryptionNonce: z.string().optional().default(''),
});

export const putUserAttributes = (deps: Deps) => async (c: Context) => {
  const body = z.object({ keyAttributes: keyAttributesSchema }).parse(await c.req.json());
  const { userId } = auth(c);
  const attrs = body.keyAttributes;

  if (attrs.memLimit * attrs.opsLimit !== EXPECTED_KDF_STRENGTH) {
    throw badRequest('Unexpected KDF strength');
  }
  if (attrs.memLimit < MIN_MEM_LIMIT) {
    throw badRequest('memory limit must be at least 128MB');
  }
  if (attrs.memLimit <= 0 || attrs.opsLimit <= 0) throw errBadRequestSentinel();

  if ((await getKeyAttributes(deps, userId)) !== null) {
    throw errPermissionDenied(); // key attributes are already set
  }

  await putKeyAttributes(deps, userId, attrs as KeyAttributes);
  return c.body(null, 200);
};
