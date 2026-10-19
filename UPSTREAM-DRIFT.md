# UPSTREAM-DRIFT — ente main vs our pin, and live deployment status

Audit date: **2026-10-19**. Pin: `ente-io/ente` `c762d70e6c` (2026-08-16, the
source the contract shapes were taken from; museum image digest in
ORACLE-VERSION). Compared against upstream `main` at `f4cdad4b7e`
(2026-10-18): 267 server commits under `server/` (Ente Space under
`server/space` excluded — separate social product), plus the mobile
(`mobile/apps/photos`, `mobile/packages`) and web (`web/packages`,
`web/apps/{photos,albums,cast}`) Photos clients.

Nothing here has been fixed yet — this is the record that the follow-up
work (NEXT-TASKS items 11–15) is cut from.

## 1. Verdict

No upstream change breaks the stock clients against this server in its
current configuration. Five soft spots and four privacy divergences, below.

## 2. Breakages / soft spots (fix list)

| # | Change | Impact today | Fix |
|---|---|---|---|
| 1 | Device-token **response** header renamed `X-Ente-Link-Device-Token` → `X-Link-Device-Token` (upstream 9413f24ed0; request header `X-Auth-Link-Device-Token` unchanged). Albums web reads only the new name from photos-v1.3.63 (2026-09-02). | None on the pinned photos-v1.3.61. After an albums bump every visit counts as a new device, so link device limits trip. Confirmed live: CORS exposes only the old name. | Emit both names; expose both (`src/middleware/publicAccess.ts:87,95`, `src/middleware/cors.ts:44`). |
| 2 | Mobile "Unshare and Hide" calls user-entity type `library_share` and `POST /collections/unshare/bulk`, ungated (only `librarySharingService.init()` is flag-gated). Pre-dates the pin. | Error dialog; album not hidden. Plain "Hide" works. | Accept `library_share` in `ENTITY_TYPES` (`src/handlers/entity/key.ts:15`); implement `unshare/bulk`. |
| 3 | `POST /push/token` gains `platform`; Android now registers with `apnsToken: null`. | We 400 (zod `z.string().optional()` rejects null); client only logs. | `.nullish()` + accept `platform` (`src/handlers/stubs/misc.ts:26`). |
| 4 | Public-link 410 bodies carry `code: LINK_EXPIRED / LINK_DISABLED / LINK_UNAVAILABLE` (44d9f97965). | Mobile shows "unavailable" instead of "expired". | Add `code` (`src/middleware/publicAccess.ts:65`). |
| 5 | Batch sharing: mobile calls `POST /users/public-keys` and `POST /collections/share/batch` on every share (max 10 per batch). | Works via fallback: public keys on any 404; share/batch only on a **non-JSON** 404 (`collection_sharing_actions.dart:237`). A JSON `notFound` handler would silently break sharing. | Implement both, or guard-test that unknown routes keep a plain-text 404. |

## 3. Privacy divergences (upstream now strips; we still send)

- Removed files in collection diffs are blanked to `{id, ownerID, collectionID, collectionOwnerID, metadata:{encryptedData:"-"}, isDeleted, updationTime}` (d321d76008). We send full keys + metadata of removed files to sharees and public viewers (`src/domain/files.ts:300`; the D61 "tombstones are NOT blanked" note is now stale).
- Unshare tombstones reduced to `{id, owner:{id,email:""}, encryptedKey, type, attributes:{}, updationTime, isDeleted}` (211a6154b6). Ours leak `encryptedName` and `pubMagicMetadata` (`src/domain/collections.ts:300`).
- `GET /collections/:id` no longer returns the owner's private `magicMetadata` to non-owners (deecc64921). Ours does (`src/handlers/collections/getById.ts`).
- `GET /users/sessions` returns opaque `th:<b64 sha256>` identifiers plus `isCurrent`; DELETE accepts both forms (0e2d6b2473). We return raw bearer tokens (`src/handlers/users/sessions.ts:20`).

Harmless: `KeyAttributes.kekHash` removed upstream (eda8a14548); we still send it, clients ignore it.

## 4. Already fine

- `RestrictLegacyUploads` (6b8c6e0f61) — museum 410s `GET /files/upload-urls` for some users. Current mobile + web use only `POST /files/upload-url` and `POST /files/multipart-upload-url`, which we serve with matching shapes (`src/handlers/files/uploadUrlV2.ts`). Mobile only falls back to the legacy route if `/files/upload-eligibility` 404s; we serve it.
- Same-collection move rejection (81b0473d10) — already enforced.
- Pending-upload metadata, app provenance, multipart cleanup, session-bound JWTs, 4 MiB body limit, stricter validation — server-internal or we are looser.

## 5. serverApiFlag

Upstream sends `UploadV2 | Comments | BackupOptions | CastSessionsV2 | DeferredMultipartChecksums | VideoStreaming | LibrarySharing` to everyone, `PreviewUploadV2` to internal users only. We send `0` (`src/handlers/stubs/remoteStore.ts:55`).

| bit | client effect | ours |
|---|---|---|
| 1<<0 UploadV2 | not read by current clients | safe to set |
| 1<<1 Comments | mobile social UI | keep off (stubs) |
| 1<<2 BackupOptions | not read by Photos clients | safe to set |
| 1<<3 VideoStreaming | **mobile streams videos by default**; at 0 users must opt in by hand | set — the vid_preview path is implemented |
| 1<<5 CastSessionsV2 | multi-cast UI | keep off (no /cast) |
| 1<<6 DeferredMultipartChecksums | web, internal/dev builds only | no effect |
| 1<<7 LibrarySharing | library sharing + family screen | keep off |
| 1<<8 PreviewUploadV2 | POST preview-upload routes | keep off until implemented |

Recommended value: **13** (bits 0, 2, 3).

## 6. New client features since the pin

| Feature | Gate | Endpoints | Ours |
|---|---|---|---|
| Batch album sharing, recipient roles | none (404 fallback) | `/users/public-keys`, `/collections/share/batch` | missing (falls back) |
| Library sharing | bit 7 | `/collections/share/bulk`, `/collections/unshare/bulk`, entity `library_share` | missing (see #2) |
| Preview upload v2 | bit 8 | `POST /files/data/preview-upload-url`, `/files/data/multipart-preview-upload-url` | missing; v1 GET works |
| Cast PQ pairing / multi-cast | bit 5 (legacy pairing ungated) | `/cast/*` | missing |
| Account deletion summary | 404 handled | `/users/deletion-summary` | missing, harmless |
| Android push registration | none | `/push/token` | stub (see #3) |

Pre-existing gaps that current clients now surface in the UI: shared memory links (`enableMemoryShareLink` hard-coded true — button shows, fails), comments/reactions buttons in shared albums, `/files/copy`, sharee pin/archive (`/collections/sharee-magic-metadata`), `suggest-delete`, `/files/duplicates`, single-file links, passkeys, family, legacy/emergency contacts.

## 7. Full-view image without the original (cost question)

**Not possible with stock clients.**

- Neither client generates or consumes `img_preview`. Mobile full view (`ui/viewer/file/zoomable_image.dart`) always calls `getFileFromServer`, which fetches the original; web (`gallery/services/download-core.ts`) likewise. The only mobile `img_preview` string (`video_preview_service.dart:1110`) is reached solely from video widgets; preview uploads are `vid_preview` only.
- E2EE: the server cannot substitute a smaller object. Redirecting to the thumbnail object fails decryption (different stream header) and triggers the decryption-failure dialog.
- On a failed original fetch, mobile keeps the 512px thumbnail with no dialog and retries on rebuild/reconnect; web retries 3× (2/5/10 s), keeps the 720px thumbnail and shows an error icon. Archive-and-degrade works, visibly: no zoom, save/share/export of the original fail.

Options, best first:

1. Originals → **S3 Intelligent-Tiering (no archive tiers)** instead of GLACIER_IR: same ~$4/TB-mo in Archive Instant Access, no $0.03/GB retrieval fee, no 90-day minimum, fully instant; ~$0.0025/1k objects/mo monitoring. Lifecycle cannot move objects already in GLACIER_IR into Intelligent-Tiering, so existing originals need a copy-in-place (one GIR read fee); the rule change alone helps new uploads. Verify current pricing before deciding.
2. Set serverApiFlag bit 3 so clients make HLS previews by default; then **video** originals can go to Deep Archive, since playback uses `vid_preview`.
3. Deep Archive for the old **image** tail via the plan §7 touch-to-restore design, accepting thumbnail-only viewing. Saves ~$3/TB-mo over option 1.
4. Patched client generating a ~2048px `img_preview` encrypted with the file key; the server half (`/files/data/preview*`) exists. Cost: maintaining an app fork.

## 8. Live deployment status (2026-10-19, profile `ente-sl`)

Contrary to AWS-RESOURCES.md/README at the time of the audit, **M7 is
deployed**: two environments, applied 2026-08-27/28.

| | prod | test |
|---|---|---|
| Region | ap-south-1 | ap-southeast-1 |
| CloudFront | Deployed, WAF attached | Deployed, WAF attached |
| API + trash-purge Lambdas | Active, last update Successful (2026-08-28) | Active, same code hash |
| DynamoDB | ACTIVE, 7,906 items, deletion protection on | ACTIVE, 219 items, protection off |
| Trash-purge rule | ENABLED, `rate(1 day)` | ENABLED, `rate(1 day)` |
| Error alarms | OK | OK |
| `SIGNUP_MODE` | invite | open |
| Lifecycle | originals → GLACIER_IR after 7 d; multipart abort; noncurrent expiry | same |
| Activity (Lambda log streams/day) | daily use, ~10–40/day in Sept rising to 99 on 2026-10-18 | idle since 2026-08-28 |

- The prod API bundle is **byte-identical** to a fresh `make build-lambda` of `b050725` — nothing undeployed.
- Live probes, both environments: `/ping` pong with the right instance id; private routes 401 `missing token`; unknown-email SRP attributes 404 `{}`; `/public-collection/info` without token 401; `/albums/` serves the viewer; CORS preflight 200; unknown routes plain-text 404.
- Not checkable with the `ente-deployer` policy: CloudWatch metrics, log contents, bucket listing / storage-class split, `lambda:List*`, `ses:List*`. Mail goes out from a personal Gmail identity — confirm SES production access. A read-only ops profile (or `cloudwatch:GetMetricStatistics`, `logs:FilterLogEvents`, `s3:ListBucket`) would close this.
