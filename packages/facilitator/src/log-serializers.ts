/**
 * Custom Pino log serializers (log hygiene).
 *
 * The facilitator's ledger/scan failures are surfaced as `CantonError`, which
 * carries the ACTUAL cause on `code` / `status` / `responseBody` (e.g. a
 * sequencer traffic exhaustion vs a nonce mismatch vs an auth 401). Pino's
 * default `stdSerializers.err` only keeps `type`/`message`/`stack` — so those
 * three diagnostic fields were being dropped from the logs, leaving an operator
 * unable to tell WHY a settle failed from the log line alone.
 *
 * This serializer spreads the standard err serialization and then threads the
 * CantonError-specific fields through when present, so `{ err }` log calls
 * (which already pepper the route handlers) suddenly carry the ledger reason.
 */
import pino from "pino";

/** Shape of the extra fields a CantonError exposes (duck-typed so this module
 *  does not need a value import of the ledger package). */
interface CantonErrorLike {
  code?: unknown;
  status?: unknown;
  responseBody?: unknown;
}

/** The pino `SerializedError` shape (type/message/stack/…) plus the optional
 *  CantonError diagnostic fields. Mirrors what Fastify's logger `serializers.err`
 *  expects a serializer to return ({ type, message, stack, … }). */
export type SerializedCantonError = ReturnType<typeof pino.stdSerializers.err> & {
  code?: unknown;
  status?: unknown;
  responseBody?: unknown;
};

/**
 * Pino err serializer = `stdSerializers.err` output PLUS `code` / `status` /
 * `responseBody` when the error carries them (CantonError). Non-Canton errors
 * serialize exactly as before (the extra keys are simply absent).
 *
 * The parameter type matches pino/Fastify's serializer signature (the standard
 * serializer takes the pino error type), so this drops straight into Fastify's
 * `logger.serializers.err` without a cast.
 */
export function cantonErrSerializer(
  err: Parameters<typeof pino.stdSerializers.err>[0]
): SerializedCantonError {
  const base = pino.stdSerializers.err(err);
  const e = err as unknown as CantonErrorLike;
  const extra: Pick<
    SerializedCantonError,
    "code" | "status" | "responseBody"
  > = {};
  if (e.code !== undefined) extra.code = e.code;
  if (e.status !== undefined) extra.status = e.status;
  if (e.responseBody !== undefined) extra.responseBody = e.responseBody;
  return { ...base, ...extra };
}
