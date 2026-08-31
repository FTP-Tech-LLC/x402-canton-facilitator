/**
 * Two ways the ledger refuses a submission that we can name with certainty, and
 * the ONLY place either rule lives.
 *
 * They started inside `routes/settle.ts` because that is where they were first
 * needed. The preapproval path discloses contract ids read through a TTL cache
 * and hits the same contention refusal, so a second copy was one paste away —
 * and two copies of one rule that drift apart has been the single most
 * expensive bug shape in this codebase.
 */
/** Marker the participant emits when a submission's input holdings no longer
 *  cover the transfer amount. */
const INSUFFICIENT_FUNDS_MARKER = "ITR_InsufficientFunds";

/**
 * Markers for the ledger refusing a submission because its INPUT holdings were
 * already consumed or are locked by a concurrent in-flight transaction. Same
 * marker set the agent-wallet client keys on (`isStaleInputHoldingError`),
 * which was written against strings observed in production, plus
 * `LOCKED_CONTRACTS` — the in-flight case, which the client never sees because
 * only the relay submits.
 */
const INPUT_CONTENTION_RE =
  /LOCKED_CONTRACTS|INACTIVE_CONTRACTS|inactive contract|UNKNOWN_CONTRACT_SYNCHRONIZERS|have been archived|CONTRACT_NOT_FOUND|Contract could not be found/i;

/**
 * True iff a failed ExecuteSubmission is the ledger refusing the transfer
 * because its pinned input Amulets are gone or locked.
 *
 * WHY THIS DESERVES ITS OWN CODE. pay/prepare selects input holdings
 * largest-first from the ACS and remembers nothing, so two payments from one
 * party that overlap in time can be built over the SAME Amulet. Both are valid
 * signed transfers; the ledger settles one and refuses the other here. Reported
 * as the catch-all `invalid_exact_canton_execute_failed`, that refusal reaches
 * the client as an AMBIGUOUS outcome — the one class the client is right to
 * stop dead on without retrying (fetch.ts STOP_ON_FIRST), because in general a
 * re-pay after "maybe it settled" is a second payment. So a collision the relay
 * created ended as a hard payment failure demanding a human read the ledger.
 *
 * There is nothing ambiguous about it. The caller only reaches this branch once
 * `answerNeverArrived` is false — the participant's verdict ARRIVED — and this
 * verdict is a conflict-detection refusal: the inputs were spent elsewhere, so
 * the transfer had no effect. Nothing moved, provably, and the honest answer is
 * "retry": the payer's remaining (or change) holdings fund a fresh attempt, and
 * exactly one payment happens.
 */
export function isInputContentionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (INPUT_CONTENTION_RE.test(msg)) return true;
  const body = (err as { responseBody?: unknown } | null)?.responseBody;
  return typeof body === "string" && INPUT_CONTENTION_RE.test(body);
}

/**
 * True iff a thrown ExecuteSubmission error is the ledger's insufficient-funds
 * rejection. The relayed `TransferFactory_Transfer` pins its input holdings at
 * build time (pay/prepare); if those holdings no longer cover the amount the
 * participant rejects the execute with `ITR_InsufficientFunds` (same marker the
 * preapproval prior-art keys on). The string can surface in the Error `message`
 * OR — for a CantonError raised from a non-2xx ledger response — in its
 * `responseBody`, so we check both. Best-effort match: a miss simply falls back
 * to the generic execute_failed.
 */
export function isInsufficientFundsError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes(INSUFFICIENT_FUNDS_MARKER)) return true;
  const body = (err as { responseBody?: unknown } | null)?.responseBody;
  return typeof body === "string" && body.includes(INSUFFICIENT_FUNDS_MARKER);
}

