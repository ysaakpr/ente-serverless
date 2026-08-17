/** Route table — every endpoint wired here, one handler file each. */

import { Hono } from 'hono';
import type { Deps } from './deps.ts';
import { handler } from './lib/http.ts';
import { requireAuth } from './middleware/auth.ts';

import { ping } from './handlers/health/ping.ts';
import { sendOtt } from './handlers/users/sendOtt.ts';
import { verifyEmail } from './handlers/users/verifyEmail.ts';
import { getSrpAttributes } from './handlers/srp/getAttributes.ts';
import { setupSrp } from './handlers/srp/setup.ts';
import { completeSrpSetup } from './handlers/srp/complete.ts';
import { createSrpSession } from './handlers/srp/createSession.ts';
import { verifySrpSessionHandler } from './handlers/srp/verifySession.ts';
import { updateSrp } from './handlers/srp/update.ts';
import { putUserAttributes } from './handlers/users/putAttributes.ts';
import { sessionValidity } from './handlers/users/sessionValidity.ts';
import { logout } from './handlers/users/logout.ts';
import { getSessions, terminateSession } from './handlers/users/sessions.ts';
import { detailsV2 } from './handlers/users/detailsV2.ts';
import { changeEmail } from './handlers/users/changeEmail.ts';
import {
  getAccountsToken,
  getPublicKey,
  setRecoveryKey,
  twoFactorRecoveryStatus,
  twoFactorStatus,
  updateEmailMfa,
} from './handlers/users/accountExtras.ts';
import { deleteAccount, getDeleteChallenge } from './handlers/users/deleteAccount.ts';
import { getUploadUrls } from './handlers/files/uploadUrls.ts';
import { getMultipartUploadUrlV2, getUploadUrlV2, uploadEligibility } from './handlers/files/uploadUrlV2.ts';
import { getMultipartUploadUrls } from './handlers/files/multipartUploadUrls.ts';
import { commitFile } from './handlers/files/commit.ts';
import { updateFile } from './handlers/files/updateFile.ts';
import { updateThumbnail } from './handlers/files/updateThumbnail.ts';
import { downloadFile, downloadFileUrl } from './handlers/files/download.ts';
import { previewFile, previewFileUrl } from './handlers/files/preview.ts';
import { filesInfo } from './handlers/files/info.ts';
import { filesSize } from './handlers/files/size.ts';
import { updateMagicMetadata } from './handlers/files/magicMetadata.ts';
import { createCollection } from './handlers/collections/create.ts';
import { getCollectionsV2 } from './handlers/collections/getV2.ts';
import { collectionDiffV2 } from './handlers/collections/diffV2.ts';
import { addFiles, moveFiles, removeFilesV3, restoreFiles } from './handlers/collections/fileActions.ts';
import { renameCollection, updateCollectionMagicMetadata } from './handlers/collections/rename.ts';
import { deleteCollectionV3 } from './handlers/collections/deleteV3.ts';
import { getCollectionById } from './handlers/collections/getById.ts';
import { createEntityKey, ensureEntityKey, getEntityKey } from './handlers/entity/key.ts';
import { createEntity, deleteEntity, entityDiff, updateEntity } from './handlers/entity/data.ts';
import { getFeatureFlags, getRemoteStoreValue, updateRemoteStoreValue } from './handlers/stubs/remoteStore.ts';
import { getPlansV2, getSubscription, verifySubscription } from './handlers/stubs/billing.ts';
import { pushToken, reportEvent, storageBonusDetails } from './handlers/stubs/misc.ts';
import {
  contactsDiff,
  deleteSuggestions,
  pendingRemoveActions,
  socialCounts,
  socialLatestUpdates,
} from './handlers/stubs/social.ts';
import { putFileData, putVideoData } from './handlers/filedata/putData.ts';
import { fileDataStatusDiff, getFileData, getFilesData } from './handlers/filedata/fetchData.ts';
import { previewUploadUrl, previewUrl } from './handlers/filedata/preview.ts';
import { trashFiles } from './handlers/trash/trashFiles.ts';
import { trashDiffV2 } from './handlers/trash/diffV2.ts';
import { deleteTrash } from './handlers/trash/deleteTrash.ts';
import { emptyTrash } from './handlers/trash/emptyTrash.ts';

export const buildApp = (deps: Deps): Hono => {
  const app = new Hono();
  const authed = requireAuth(deps);

  // Gate observability (make lan / make dev): every request + status, and a
  // loud marker for routes we don't serve — those are the M5 capture list.
  if (deps.config.logRequests) {
    app.use('*', async (c, next) => {
      const started = Date.now();
      await next();
      const marker = c.res.status === 404 ? '  <-- UNHANDLED ROUTE?' : '';
      console.log(
        `${c.req.method} ${c.req.path} -> ${c.res.status} (${Date.now() - started}ms)${marker}`,
      );
    });
  }

  // [HEALTH]
  app.get('/ping', handler(ping(deps)));

  // [AUTH-OTT]
  app.post('/users/ott', handler(sendOtt(deps)));
  app.post('/users/verify-email', handler(verifyEmail(deps)));

  // [AUTH-SRP]
  app.get('/users/srp/attributes', handler(getSrpAttributes(deps)));
  app.post('/users/srp/setup', authed, handler(setupSrp(deps)));
  app.post('/users/srp/complete', authed, handler(completeSrpSetup(deps)));
  app.post('/users/srp/create-session', handler(createSrpSession(deps)));
  app.post('/users/srp/verify-session', handler(verifySrpSessionHandler(deps)));
  app.post('/users/srp/update', authed, handler(updateSrp(deps)));

  // [KEYS] / [ACCOUNT]
  app.put('/users/attributes', authed, handler(putUserAttributes(deps)));
  app.get('/users/session-validity/v2', authed, handler(sessionValidity(deps)));
  app.post('/users/logout', authed, handler(logout(deps)));
  app.get('/users/sessions', authed, handler(getSessions(deps)));
  app.delete('/users/session', authed, handler(terminateSession(deps)));
  app.get('/users/details/v2', authed, handler(detailsV2(deps)));
  app.post('/users/change-email', authed, handler(changeEmail(deps)));
  app.put('/users/email-mfa', authed, handler(updateEmailMfa(deps)));
  app.get('/users/two-factor/status', authed, handler(twoFactorStatus(deps)));
  app.get('/users/two-factor/recovery-status', authed, handler(twoFactorRecoveryStatus(deps)));
  app.put('/users/recovery-key', authed, handler(setRecoveryKey(deps)));
  app.get('/users/public-key', authed, handler(getPublicKey(deps)));
  app.get('/users/accounts-token', authed, handler(getAccountsToken(deps)));
  app.get('/users/delete-challenge', authed, handler(getDeleteChallenge(deps)));
  app.delete('/users/delete', authed, handler(deleteAccount(deps)));

  // [UPLOAD]
  app.get('/files/upload-eligibility', authed, handler(uploadEligibility(deps)));
  app.get('/files/upload-urls', authed, handler(getUploadUrls(deps)));
  app.get('/files/multipart-upload-urls', authed, handler(getMultipartUploadUrls(deps)));
  app.post('/files/upload-url', authed, handler(getUploadUrlV2(deps)));
  app.post('/files/multipart-upload-url', authed, handler(getMultipartUploadUrlV2(deps)));
  app.post('/files', authed, handler(commitFile(deps)));
  app.put('/files/update', authed, handler(updateFile(deps)));
  app.put('/files/thumbnail', authed, handler(updateThumbnail(deps)));

  // [FILE-READ]
  app.get('/files/download/:fileID', authed, handler(downloadFile(deps)));
  app.get('/files/download/v2/:fileID', authed, handler(downloadFileUrl(deps)));
  app.get('/files/download/v3/:fileID', authed, handler(downloadFileUrl(deps)));
  app.get('/files/preview/:fileID', authed, handler(previewFile(deps)));
  app.get('/files/preview/v2/:fileID', authed, handler(previewFileUrl(deps)));
  app.get('/files/thumbnail/v3/:fileID', authed, handler(previewFileUrl(deps)));
  app.post('/files/info', authed, handler(filesInfo(deps)));
  app.post('/files/size', authed, handler(filesSize(deps)));

  // [FILE-META]
  app.put('/files/magic-metadata', authed, handler(updateMagicMetadata(deps, false)));
  app.put('/files/public-magic-metadata', authed, handler(updateMagicMetadata(deps, true)));

  // [COLLECTIONS] [SYNC]
  app.post('/collections', authed, handler(createCollection(deps)));
  app.get('/collections/v2', authed, handler(getCollectionsV2(deps)));
  app.get('/collections/v2/diff', authed, handler(collectionDiffV2(deps)));
  app.post('/collections/add-files', authed, handler(addFiles(deps)));
  app.post('/collections/move-files', authed, handler(moveFiles(deps)));
  app.post('/collections/restore-files', authed, handler(restoreFiles(deps)));
  app.post('/collections/v3/remove-files', authed, handler(removeFilesV3(deps)));
  app.post('/collections/rename', authed, handler(renameCollection(deps)));
  app.put('/collections/magic-metadata', authed, handler(updateCollectionMagicMetadata(deps, false)));
  app.put('/collections/public-magic-metadata', authed, handler(updateCollectionMagicMetadata(deps, true)));
  app.delete('/collections/v3/:collectionID', authed, handler(deleteCollectionV3(deps)));
  // param route LAST so the static /collections/* routes above win
  app.get('/collections/:collectionID', authed, handler(getCollectionById(deps)));

  // [FILE-DATA]
  app.put('/files/data', authed, handler(putFileData(deps)));
  app.put('/files/video-data', authed, handler(putVideoData(deps)));
  app.post('/files/data/fetch', authed, handler(getFilesData(deps)));
  app.get('/files/data/fetch', authed, handler(getFileData(deps)));
  app.post('/files/data/status-diff', authed, handler(fileDataStatusDiff(deps)));
  app.get('/files/data/preview-upload-url', authed, handler(previewUploadUrl(deps)));
  app.get('/files/data/preview', authed, handler(previewUrl(deps)));

  // [ENTITY]
  app.post('/user-entity/key', authed, handler(createEntityKey(deps)));
  app.post('/user-entity/key/ensure', authed, handler(ensureEntityKey(deps)));
  app.get('/user-entity/key', authed, handler(getEntityKey(deps)));
  app.post('/user-entity/entity', authed, handler(createEntity(deps)));
  app.put('/user-entity/entity', authed, handler(updateEntity(deps)));
  app.delete('/user-entity/entity', authed, handler(deleteEntity(deps)));
  app.get('/user-entity/entity/diff', authed, handler(entityDiff(deps)));

  // Stubs the app requires to boot
  app.get('/remote-store', authed, handler(getRemoteStoreValue(deps)));
  app.post('/remote-store/update', authed, handler(updateRemoteStoreValue(deps)));
  app.get('/remote-store/feature-flags', authed, handler(getFeatureFlags(deps)));
  app.get('/billing/plans/v2', handler(getPlansV2(deps)));
  app.get('/billing/subscription', authed, handler(getSubscription(deps)));
  app.post('/billing/verify-subscription', authed, handler(verifySubscription(deps)));
  app.get('/storage-bonus/details', authed, handler(storageBonusDetails(deps)));
  app.post('/push/token', authed, handler(pushToken(deps)));
  app.post('/users/event', authed, handler(reportEvent(deps)));

  // Social/sharing sync probes (gate finding D27 — empty in core scope)
  app.get('/comments-reactions/updated-at', authed, handler(socialLatestUpdates(deps)));
  app.get('/comments-reactions/counts', authed, handler(socialCounts(deps)));
  app.get('/collection-actions/pending-remove', authed, handler(pendingRemoveActions(deps)));
  app.get('/collection-actions/delete-suggestions', authed, handler(deleteSuggestions(deps)));
  app.get('/contacts/diff', authed, handler(contactsDiff(deps)));

  // [TRASH]
  app.post('/files/trash', authed, handler(trashFiles(deps)));
  app.get('/trash/v2/diff', authed, handler(trashDiffV2(deps)));
  app.post('/trash/delete', authed, handler(deleteTrash(deps)));
  app.post('/trash/empty', authed, handler(emptyTrash(deps)));

  return app;
};
