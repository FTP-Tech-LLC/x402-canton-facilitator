#!/usr/bin/env bash
# Bootstrap a Canton participant to host the x402 facilitator.
#
# Run once per fresh participant. Idempotent — re-runs do nothing if
# the party already exists and rights are already granted.
#
# Steps:
#   1. Allocate the facilitator party (`partyIdHint=ftp_facilitator`).
#   2. Grant CanActAs + CanReadAs of that party to the ledger user
#      (so the facilitator JWT can query ACS / submit commands).
#   3. Print the resulting party id + env block ready for
#      `.env.<environment>` consumption by `packages/facilitator`.
#
# Env vars:
#   CANTON_PARTICIPANT_URL  — JSON Ledger API v2 base URL (default
#                              http://localhost:3975 for cn-quickstart
#                              App Provider participant)
#   CANTON_USER_ID          — ledger user id to grant rights to
#                              (default "ledger-api-user")
#   JWT_ISSUER              — "unsafe-hmac" (default for LocalNet /
#                              cn-quickstart) or "oidc" (production)
#   JWT_SECRET              — HMAC secret if JWT_ISSUER=unsafe-hmac
#                              (default "unsafe")
#   PARTY_HINT              — partyIdHint (default "ftp_facilitator")

set -euo pipefail

PARTICIPANT_URL="${CANTON_PARTICIPANT_URL:-http://localhost:3975}"
USER_ID="${CANTON_USER_ID:-ledger-api-user}"
JWT_ISSUER="${JWT_ISSUER:-unsafe-hmac}"
JWT_SECRET="${JWT_SECRET:-unsafe}"
PARTY_HINT="${PARTY_HINT:-ftp_facilitator}"

if [[ "$JWT_ISSUER" != "unsafe-hmac" ]]; then
  echo "ERROR: only JWT_ISSUER=unsafe-hmac is supported for now. OIDC bootstrap is pending." >&2
  exit 1
fi

JWT=$(node -e '
const { createHmac } = require("node:crypto");
const b64 = s => Buffer.from(s).toString("base64").replace(/=+$/,"").replace(/\+/g,"-").replace(/\//g,"_");
const sub = process.argv[1], aud = "https://canton.network.global", secret = process.argv[2];
const h = b64(JSON.stringify({alg:"HS256",typ:"JWT"}));
const p = b64(JSON.stringify({sub,aud}));
const s = createHmac("sha256",secret).update(`${h}.${p}`).digest("base64").replace(/=+$/,"").replace(/\+/g,"-").replace(/\//g,"_");
console.log(`${h}.${p}.${s}`);
' "$USER_ID" "$JWT_SECRET")

api() {
  local method="$1" path="$2"
  shift 2
  curl -sfS -X "$method" \
    -H "Authorization: Bearer $JWT" \
    -H "Content-Type: application/json" \
    "$@" \
    "${PARTICIPANT_URL}${path}"
}

echo "→ Checking participant reachable at $PARTICIPANT_URL"
api GET "/livez" > /dev/null && echo "  ✓ livez OK"
api GET "/readyz" > /dev/null && echo "  ✓ readyz OK"

echo "→ Looking up existing party with hint=${PARTY_HINT}"
EXISTING=$(api GET "/v2/parties" | node -e '
const data = JSON.parse(require("fs").readFileSync(0,"utf8"));
const hint = process.argv[1];
const m = (data.partyDetails||[]).find(p => p.party && p.party.startsWith(hint+"::") && p.isLocal);
if (m) console.log(m.party);
' "$PARTY_HINT")

if [[ -n "$EXISTING" ]]; then
  PARTY="$EXISTING"
  echo "  ✓ already exists: ${PARTY}"
else
  echo "→ Allocating new party"
  ALLOC=$(api POST "/v2/parties" -d "{\"partyIdHint\":\"${PARTY_HINT}\",\"displayName\":\"x402 facilitator\"}")
  PARTY=$(echo "$ALLOC" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).partyDetails.party)')
  echo "  ✓ allocated: ${PARTY}"
fi

echo "→ Granting CanActAs + CanReadAs of ${PARTY} to user ${USER_ID}"
api POST "/v2/users/${USER_ID}/rights" -d "$(cat <<EOF
{
  "userId": "${USER_ID}",
  "identityProviderId": "",
  "rights": [
    {"kind":{"CanActAs":{"value":{"party":"${PARTY}"}}}},
    {"kind":{"CanReadAs":{"value":{"party":"${PARTY}"}}}}
  ]
}
EOF
)" > /dev/null && echo "  ✓ rights granted (idempotent — Canton merges)"

echo ""
echo "──────────────────────────────────────────────────────────"
echo "Bootstrap complete. Add this to your .env.<environment>:"
echo ""
echo "CANTON_FACILITATOR_PARTY=${PARTY}"
echo "CANTON_PARTICIPANT_URL=${PARTICIPANT_URL}"
echo "CANTON_USER_ID=${USER_ID}"
echo "JWT_ISSUER=${JWT_ISSUER}"
echo "JWT_SECRET=${JWT_SECRET}"
echo ""
echo "──────────────────────────────────────────────────────────"
