# RUNBOOK — M5 stock-app LAN gate

Goal (build plan M5): the stock ente Photos app completes onboarding against
this server — signup, key setup, backup of a small library, gallery browse,
album create, trash/restore, second-device login sees everything. Record every
unexpected request the app makes; each becomes an issue or an allowlist entry
with a written justification.

## Before you start

1. Record the app version you're about to use in `ORACLE-VERSION` (decision
   D1b: pin at gate time). Play Store → ente Photos → App info shows it.
2. Phone and Mac on the same wifi; macOS firewall allowing inbound node, or
   temporarily off.

## Run

```bash
make up      # LocalStack
make lan     # prints the URL, e.g. http://192.168.1.23:8080
```

`make lan` enables the hardcoded-OTT domain (museum quickstart parity):
**any `…@example.org` email verifies with code `123456`** — no real mail needed.

## In the app

1. Install ente Photos; on the onboarding screen **tap the logo 7 times** —
   the "Developer settings" / custom server endpoint dialog appears.
2. Enter the printed `http://<mac-ip>:8080` and save.
3. Sign up with `you@example.org`, OTT `123456`, set a password (this runs
   the real argon2 + SRP setup against our server).
4. Back up a small album (a handful of photos + one video).
5. Verify: gallery browse (thumbnails), full-screen open (original download),
   album create/rename, favorite (magic metadata), trash a photo, restore it,
   video playback (vid_preview HLS — M6 gate).
6. Second device (or reinstall): log in with the same email/password — SRP
   login path — and confirm the library appears.

## Record

- Watch the server log (`make lan` foreground) for any **404 route** or
  **4xx/5xx** the app triggers — those are unimplemented/wrong endpoints.
  Copy each into an issue in NEXT-TASKS.md, or add an allowlist entry with
  justification once captures exist.
- On success, note app version + date in ORACLE-VERSION and tick M5 in
  README status.

## Gate log

- **2026-08-17 first run:** login ✅, account recovery ✅, uploads ❌.
  Two causes found and fixed:
  1. presigned URLs were signed for `127.0.0.1:4567` (unreachable from the
     phone) — `make lan` now signs against the Mac's LAN IP automatically;
  2. the current app uploads via `POST /files/upload-url` /
     `POST /files/multipart-upload-url` (V2) + `GET /files/upload-eligibility`,
     which didn't exist yet — implemented (DECISIONS.md D26).
  `make lan` now also logs every request (404s marked `UNHANDLED ROUTE?`) —
  copy any such line into NEXT-TASKS when the app hits one.
- **2026-08-17 second run:** request log surfaced three sync-loop probes we
  didn't serve — `/comments-reactions/updated-at`,
  `/collection-actions/pending-remove`, `/contacts/diff`. Implemented as
  empty envelopes together with their `counts` / `delete-suggestions`
  siblings (DECISIONS.md D27).
- **2026-08-17 third run:** trash worked but every subsequent sync polled
  `GET /collections/0` — our trash diff emitted `collectionID: 0` instead of
  the origin collection, and `GET /collections/:collectionID` didn't exist.
  Both fixed (DECISIONS.md D28); existing trash rows self-heal.
- Re-run after pulling fixes: restart `make lan` (LocalStack keeps its
  state; your account survives).
