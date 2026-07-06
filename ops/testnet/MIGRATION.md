# TestNet / MainNet deploy runbook

The facilitator is network-driven by env. Nothing in the container is
network-specific: `CANTON_NETWORK`, `CANTON_SCAN_URL`, `CANTON_SYNCHRONIZER_ID`,
and the OIDC vars fully determine which network it serves. Deploying to TestNet
or MainNet means standing up the same image against that network's endpoints
with the matching `.env`. The same image serves both — no rebuild per network.

The live facilitators run this flow today: `FTP-validator-2` on TestNet and
`FTP-validator-1` on MainNet.

## What the code requires

`loadConfig()` accepts `CANTON_NETWORK = canton:devnet | canton:testnet |
canton:mainnet`. Everything else (Scan read, verify, free settle, replay store,
CAIP-2 handling) is network-agnostic. `parseNetworkReference("canton:testnet")`
returns `testnet` and `isCantonNetwork("canton:testnet")` returns true (same for
`canton:mainnet`).

## Values that change per network

| Var | TestNet | MainNet |
|-----|---------|---------|
| `CANTON_NETWORK` | `canton:testnet` | `canton:mainnet` |
| `CANTON_SCAN_URL` | `scan.sv-1.test.global.canton.network.sync.global` | `scan.sv-2.global.canton.network.digitalasset.com` |
| `CANTON_SYNCHRONIZER_ID` | TestNet `global-domain::1220...` | MainNet `global-domain::1220...` (different value) |
| `CANTON_FACILITATOR_PARTY` | allocated on the TestNet participant | allocated on the MainNet participant |
| `CANTON_PARTICIPANT_URL` | TestNet validator participant | MainNet validator participant |
| `OIDC_*`, `CANTON_USER_ID` | TestNet validator m2m client | MainNet validator m2m client |

Everything else (Postgres, image tag, bind, scan flavor `sv`, operator token)
is identical. Full template: `ops/testnet/.env.example` (MainNet:
`ops/mainnet/.env.example` + the overlay in `ops/mainnet/docker-compose.yml`).

## Steps

1. Discover the public refs (synchronizer id + DSO) from the target network's
   SV Scan. These are DSO-signed and readable by any participant on the
   synchronizer, so this works from anywhere the scan host resolves:

   ```bash
   # TestNet
   SCAN_BASE=https://scan.sv-1.test.global.canton.network.sync.global/api/scan \
     bash scripts/fetch-public-refs.sh
   # MainNet
   SCAN_BASE=https://scan.sv-2.global.canton.network.digitalasset.com/api/scan \
     bash scripts/fetch-public-refs.sh
   cat .env.public   # -> CANTON_SYNCHRONIZER_ID, DSO_PARTY
   ```

2. Provision an OIDC m2m client for the facilitator on the target network (its
   own client, not the validator's secret). Note the token endpoint, client id,
   client secret.

3. Allocate the facilitator party on the target participant and grant the
   ledger user CanActAs + CanReadAs of it:

   ```bash
   bash scripts/bootstrap-facilitator.sh   # against the target participant + admin token
   ```

4. Fill the env:

   ```bash
   cp ops/testnet/.env.example <deploy-dir>/.env   # or ops/mainnet/.env.example
   # set CANTON_SYNCHRONIZER_ID, CANTON_FACILITATOR_PARTY, CANTON_PARTICIPANT_URL,
   #     OIDC_* , CANTON_USER_ID, POSTGRES_PASSWORD, CANTON_X402_OPERATOR_TOKEN
   ```

5. Build, ship, and load the image (the image is network-neutral — no rebuild
   per network):

   ```bash
   bash scripts/build-deploy-image.sh
   # docker save | gzip -> scp -> on the box: docker load < canton-x402-facilitator-<sha>.tar.gz
   ```

6. Bring it up:

   ```bash
   cd <deploy-dir> && docker compose -f docker-compose.yml up -d
   ```

## Verify

```bash
curl -s https://<facilitator>/supported | grep -o 'canton:testnet'   # or canton:mainnet
curl -s https://<facilitator>/health                                 # ok
```

Then a real round-trip: a CIP-56 agent->merchant payment, `/verify` against the
target Scan, `/settle` is a no-op for CIP-56 (the agent submitted the transfer,
so the facilitator's validator pays no synchronizer traffic).

## Funding for live e2e tests

To run an end-to-end test you need a funded agent party holding the instrument
you're transferring. On networks where `AmuletRules.isDevNet` is true the e2e
scripts can self-fund via `AmuletRules_DevNet_Tap`; on TestNet/MainNet the tap
is generally unavailable, so fund the agent party from the network faucet /
validator wallet and run the transfer scripts against an existing holding. Check
the flag on the box first:

```bash
curl -s https://scan.sv-1.test.global.canton.network.sync.global/api/scan/v0/amulet-rules \
  | grep -o '"isDevNet":[a-z]*'
```

The verify/settle path itself is identical; only the funding source changes. The
facilitator does not tap and does not depend on this — it only affects how we
mint test CC for an end-to-end test.

## Teardown

To stop a deploy: `docker compose down` in that network's deploy dir. Each
network is a separate folder + `.env` + container set with its own Postgres
volume, so there is no shared state between TestNet and MainNet.

## Checklist

- [ ] `CANTON_NETWORK` = `canton:testnet` (or `canton:mainnet`)
- [ ] `CANTON_SCAN_URL` = target SV host (confirmed reachable from the box)
- [ ] `CANTON_SYNCHRONIZER_ID` = target network id (from step 1)
- [ ] `CANTON_PARTICIPANT_URL` = target participant
- [ ] `CANTON_FACILITATOR_PARTY` allocated on the target + rights granted
- [ ] `OIDC_*` + `CANTON_USER_ID` = target m2m client
- [ ] `LEDGER_API_AUDIENCE` confirmed against the target participant
- [ ] `POSTGRES_PASSWORD` + `CANTON_X402_OPERATOR_TOKEN` set to fresh randoms
- [ ] image built + loaded on the box
- [ ] `/supported` reports the right network, `/health` ok
- [ ] one real CIP-56 round-trip verified (verify + settle)
