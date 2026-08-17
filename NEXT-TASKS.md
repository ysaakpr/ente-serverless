# NEXT-TASKS

In dependency order. D-numbers reference DECISIONS.md.
(2026-08-16 decision round: oracle pinned by digest (D1), captures explicitly
deferred (D2), M5 runbook prepared (D3, see RUNBOOK-M5.md), hashing_key in
local tfvars (D4a), object sweep implemented (D6), account routes pulled
forward and implemented.)

1. **Write the capture script + run it (D2, deferred by decision).** Bring up
   the pinned oracle (`make oracle-up`), drive the synthetic client
   (test/helpers/client.ts) against museum, record request/response pairs
   under `test/fixtures/oracle-<digest>/`, grow `tools/capture-diff.ts` into
   the replay-and-diff harness, add `tools/contract-allowlist.ts` with
   justified entries only. Correct handlers where captures disagree — the
   remaining CAPTURE-GATED items are D9 (magic-metadata version) and D10
   (stub payloads, 2FA recovery-status shape, accounts-token).
2. **SRP oracle vector test** (M1 gate leftover): scripted known-password
   account against museum, transcript pinned as fixture, replayed against us.
3. **M5 stock-app LAN gate (D3, prepared):** `make lan` + RUNBOOK-M5.md;
   pin the app version in ORACLE-VERSION at gate time (D1b); record every
   unexpected request.
4. **M7 deploy (D4):** `make build-lambda`, fill `src/infra/dev/ente-sl.tfvars`
   from the example (BACK UP hashing_key), `tofu apply`, replay gates against
   the real URL, then the app over the internet. Still open: account/region +
   SES-verified mail_from.
5. **Hardening follow-ups:** account-deletion data cleanup in the sweep cron
   (rows/objects of deleted users); CI (unit + infra every push; integration
   behind a LocalStack service).
