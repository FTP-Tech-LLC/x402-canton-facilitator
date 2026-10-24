# Maintenance Playbook

Operating procedures for the Canton x402 stack after launch: how to ship
a version, what to check when the platform underneath changes, how to
track audit remediation, and what to do when settlement stops working.

Contents:

1. [Version upgrade procedure](#1-version-upgrade-procedure)
2. [Ledger-API compatibility checklist](#2-ledger-api-compatibility-checklist)
3. [Audit findings remediation log](#3-audit-findings-remediation-log)
4. [Incident response](#4-incident-response)
5. [Monitoring](#5-monitoring)
6. [Key and secret rotation](#6-key-and-secret-rotation)
7. [Backup and restore](#7-backup-and-restore)

Companion docs: [deployment.md](deployment.md) for standing up the
facilitator, [COMPATIBILITY.md](COMPATIBILITY.md) for the version matrix.

---

## 1. Version upgrade procedure

There are four independently-versioned surfaces: the npm packages, the
facilitator service image, the topology reader beside the participant,
and the Canton participant underneath. Upgrade them one at a time and
verify between each.

### 1a. npm packages (core, ledger)

1. Make the change on a branch. Keep internal dependencies on caret
   ranges (`workspace:^`) so published tarballs carry caret ranges, not
   an exact pin.
2. Green-gate the whole workspace:
   ```bash
   pnpm -r typecheck && pnpm -r test && pnpm -r build
   ```
3. Bump the changed package versions. If a scheme string or an envelope
   field name changed, that is a breaking change: major-bump `core` and
   plan a coordinated facilitator redeploy (see the `exact` boundary in
   COMPATIBILITY.md section 3).
4. Regenerate the lockfile after any dependency-spec change, or the
   `--frozen-lockfile` Docker build breaks:
   ```bash
   pnpm install
   ```
5. Publish (requires the publisher's npm auth and 2FA):
   ```bash
   pnpm --filter <package> publish --access public
   ```
6. Verify the published artifact:
   ```bash
   npm view @ftptech/<package> version
   ```
   and install it into a scratch project to confirm the tarball resolves
   its caret ranges.

### 1b. Facilitator service image

1. Green-gate and build the image with a descriptive tag:
   ```bash
   docker compose -f packages/facilitator/docker-compose.production.yml build
   ```
2. Keep the previous image tag and the previous `.env`. Rollback is
   reverting the tag and re-running `up`.
3. Deploy:
   ```bash
   docker compose -f packages/facilitator/docker-compose.production.yml up -d
   ```
4. Verify readiness and one real payment before declaring done:
   - `/ready` returns 200 (from the host; the edge hides it).
   - `curl https://<host>/supported` lists the expected network,
     instruments and signer.
   - Run one small live payment and confirm on Scan that funds moved. A
     success response is not proof; the ledger is.
5. If `/ready` stays red or the settle fails, roll back immediately:
   revert `IMAGE_TAG` in `.env` and `up` the previous image.

> Never blind-copy the box-local `.env` or docker-compose overrides
> during a redeploy. Host-specific invariants (internal host aliases,
> scan-bridge entries) live only on the box and are not in the repo.
> Sync the built artifact, not the ops config.

The money path uses no custom DAR, so there is no DAR to rebuild or
vet. A Splice package upgrade needs no rebuild either: Splice interfaces
are bound by `#package-name`.

### 1c. Canton participant

A participant minor or major upgrade is the highest-risk change. Treat
it as a platform migration:

1. Read the Canton release notes for JSON Ledger API v2 changes.
2. Run the entire [ledger-API compatibility checklist](#2-ledger-api-compatibility-checklist)
   against the upgraded participant on a test network first.
3. Confirm the topology reader still answers for a known party.
4. On the test network, before touching MainNet: one payment through
   verify and settle, and one payment to a merchant without a
   preapproval, which must be refused with
   `invalid_exact_canton_preapproval_missing`.

---

## 2. Ledger-API compatibility checklist

Run this before and after any Canton participant upgrade, and whenever a
ledger call starts returning HTTP 400 that used to work. These are the
JSON Ledger API v2 invariants the stack depends on. Each has burned real
hours in the wild.

- [ ] **Template-id format is `#package-name:Module.Path:Entity`.** The
      leading `#` is mandatory. Without it the parser reads the first
      segment as a literal package-id hash and the call fails.
- [ ] **Body shape is endpoint-dependent.**
      `submit-and-wait-for-transaction` (markers, legacy provider
      preapproval) wants the wrapped shape
      `{commands: {commandId, actAs, commands, ...}}`. The flat variant
      returns `400 Missing required field at 'commands.commands'`.
- [ ] **`submit-and-wait-for-transaction-tree` is gone.** Deprecated in
      3.4, removed in 3.5. Use `submit-and-wait-for-transaction`.
- [ ] **Command discriminators are wrapping keys, not `kind` fields.**
      `{"CreateCommand": {...}}`, not `{"kind": "CreateCommand", ...}`.
- [ ] **Daml `Int` is a JSON string** (`"50"`), not a number. Output is
      always a string; a numeric parse can lose precision on large values.
- [ ] **`Party` is `name::fingerprint`** and `Time` is an RFC3339 ISO
      string.
- [ ] **`disclosedContracts` is required** for any choice exercise on a
      DSO-signed contract (AmuletRules, open mining round, the
      allocation/transfer factory). Missing it returns
      `CONTRACT_NOT_FOUND` 404. The `created_event_blob` comes from Scan.
- [ ] **ACS reads for heavy parties must filter by template or
      interface**, not wildcard. A party with more contracts than the
      node lists in one response (200 by default) gets a 413-class
      error. Ledger 0.5+ reads in bounded slices (`?limit=N`); the relay
      serves them as `/holdings?slice=1`.
- [ ] **ACS filters go in `eventFormat`.** Canton 3.6 rejects the
      top-level `filter` and `verbose` fields with HTTP 400 (3.7 removes
      them). Needs ledger 0.6.1 or later.
- [ ] **`transaction-by-id` is disabled from Canton 3.6**
      (`DEPRECATED_API_DISABLED`; 3.7 removes it). The settle
      funds-moved check reads `update-by-id`. Needs ledger 0.6.2.
- [ ] **Scan `holdings/state` is v2 only from Splice 0.9.** v0 and v1
      answer 404.
- [ ] **Maximum deduplication duration.** A participant may set it far
      below Canton's default. A resubmitted command id can then commit
      twice. The marker worker deduplicates against a ledger offset and
      never resubmits an unknown outcome; keep custom scripts the same.
- [ ] **Topology route available.** The topology reader needs Canton
      3.5.10 (Splice 0.6.14) or later.
- [ ] **Auth token audience and issuer match** what the upgraded
      participant expects. An OIDC audience change is a silent 401 until
      you re-read the participant config.
- [ ] **`/ready` is green** after the upgrade: ledger token, participant
      and Scan reachable.
- [ ] **One live settle moves funds on Scan.** The only real proof.

---

## 3. Audit findings remediation log

The security audit is a milestone gate: all Critical and High findings
must be remediated before milestone acceptance. The audit report will be
published in this repo when final. Track every finding here through to
a merged fix.

| ID | Severity | Summary | Status | Fix (PR / commit) | Date closed |
|---|---|---|---|---|---|
| _example_ | High | _short description_ | Remediated | _#NN_ | _YYYY-MM-DD_ |

Process:

1. When the audit report lands, transcribe every Critical/High/Medium
   finding into the table with status `Open`.
2. Each finding gets a branch, a regression test that fails on the
   vulnerable code and passes on the fix, and a PR. Reference the finding
   ID in the PR.
3. Move to `Remediated` only when the fix is merged and the regression
   test is in CI. Low/informational findings may be `Accepted` with a
   one-line rationale.
4. Critical and High must all be `Remediated` before requesting
   milestone acceptance. Re-run the auditor's proof-of-concept against
   the fixed build and attach the result.
5. Keep the published report and this log in sync. The log is the living
   status; the report is the point-in-time record.

---

## 4. Incident response

### `/settle` returning errors

1. Check the circuit breaker state on `/metrics`. If it is OPEN, settles
   are being refused on purpose after a failure burst. It half-opens
   after the cooldown. Do not force it; find the underlying failure.
2. Check the participant is reachable and the auth token is fresh. An
   expired OIDC token surfaces as ledger 401s while the process keeps
   running. The facilitator mints its own m2m token; if the token
   endpoint is down it cannot settle.
3. Check Scan. A `503` from one SV should fail over to
   `CANTON_SCAN_FALLBACK_URLS`. If all Scan URLs are down, factory
   resolution fails and settles cannot be built. A 403 usually means the
   host is not on the SV allowlist or the URL carries a port.
4. Check the topology reader. If it is down or its token is wrong,
   every payment fails with `invalid_exact_canton_signature_invalid`.
5. Check the Global-Synchronizer traffic budget if the member-id monitor
   is enabled. A depleted budget throttles the facilitator's own
   submissions.

### `/ready` red

`/ready` fails closed if the ledger token cannot be minted or the
participant or Scan is unreachable. The response names the failing
check. Fix that dependency; the probe recovers on its own.

### Payer-side retry storm

The per-payer settle cap (`CANTON_X402_SETTLE_RATE_MAX_PER_PAYER`) and
the circuit breaker bound the damage from a client that re-pays in a
loop. To restrict whom the facilitator relays for, set
`CANTON_X402_INLINE_MERCHANT_POLICY=provider-or-allowlist`. On the relay,
`CANTON_X402_ABUSE_*` bans repeat offenders by IP. There is no per-payer
block list. `CANTON_EXCLUDED_PARTIES` only filters the attribution
report and blocks nothing.

### Rollback

Any bad deploy rolls back by reverting the image tag in `.env` and
re-running `docker compose up -d`. Keep the last known-good tag and
`.env` for exactly this.

---

## 5. Monitoring

- **`/metrics`** (Prometheus): verify and settle counters, a latency
  histogram, circuit-breaker state, and settle burn accounting. Scrape it
  from a private interface, not the public proxy.
- **`/ready`**: wire it to your uptime monitor. It is the single
  dependency-health signal.
- **GS traffic-budget monitor**: set `CANTON_FACILITATOR_MEMBER_ID` to
  enable a 60-second poller that tracks the facilitator's own
  Global-Synchronizer traffic consumption. Alert before the budget runs
  low, because a depleted budget silently stalls settles.
- **Logs**: pino JSON with a custom error serializer that surfaces
  Canton error fields. Rotate with the json-file driver (10 MB x 5 per
  service in the production compose).
- **Attribution trail**: the per-payment audit rows in Postgres map
  `payment_id -> settlement updateId -> bytes consumed`. This is the
  source of truth for the burn dashboard.

---

## 6. Key and secret rotation

All secrets live only in the per-deployment `.env`. Rotate on a schedule
and after any suspected exposure.

| Secret | Rotate by |
|---|---|
| `OIDC_CLIENT_SECRET` | issue a new m2m secret in the IdP, update `.env`, restart |
| `CANTON_X402_OPERATOR_TOKEN` | generate a new random token, update `.env`, restart |
| `CANTON_X402_AGENT_WALLET_KEY` | rotate the `X-Agent-Key`, update relay clients, restart |
| `POSTGRES_PASSWORD` | rotate in Postgres, update `DATABASE_URL`, restart |
| npm publish token | revoke the old token in the npm account, issue a granular one |

The facilitator holds no user custody: the relay prepares but never
signs, and agents hold their own keys. There is no user-key rotation to
perform facilitator-side.

---

## 7. Backup and restore

Postgres holds attribution and idempotency state. The production compose
bind-mounts the data directory so an external cron can snapshot it:

```bash
docker exec <postgres-container> pg_dumpall -U x402 > x402-$(date +%F).sql
```

Restore into a fresh Postgres 16, point `DATABASE_URL` at it, and restart
the facilitator. Idempotency keys are re-derived from the ledger on
demand, so a short gap in the attribution table degrades reporting
granularity but does not double-settle: settlement idempotency is
enforced against the ledger, not only against the database.
