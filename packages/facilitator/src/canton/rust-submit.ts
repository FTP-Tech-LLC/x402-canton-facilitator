import { execFile, type ChildProcess } from "node:child_process";
import {
  CantonError,
  type TokenProvider,
  type TransactionResult,
} from "@ftptech/x402-canton-ledger";
import { FaucetPreSubmitError, type FaucetSubmit } from "./faucet.js";

/**
 * The faucet's final submission through packages/grant-sender, a Rust binary on
 * the Canton Rust SDK. A drop-in for `client.submitAndWaitForTransaction`: same
 * commands, same endpoint and the same classes of `CantonError`, so the
 * reservation and retry rules in faucet.ts and routes/wallet.ts do not know
 * which one ran.
 *
 * The binary runs once per grant, outside this process: a crash or a hang there
 * costs one grant, not the payments served here.
 *
 * Only a participant's own answer may carry an HTTP status, because that is
 * what `provesNothingCommitted` reads. Anything else that goes wrong once the
 * process has started says nothing about the ledger, and must surface as "may
 * have committed" so the reservation holds. The one exception is the binary's
 * own refusal of a request, which comes before it sends anything.
 */

/** Where packages/facilitator/Dockerfile installs the binary. */
const GRANT_SENDER_BIN = "/usr/local/bin/grant-sender";
/** The binary's exit code for a request it refused without sending anything. */
const EXIT_BAD_REQUEST = 2;
/** The timeout of the CantonClient in services.ts. */
const SUBMIT_TIMEOUT_MS = 45_000;
/** The binary enforces the timeout itself. This is for one that hangs anyway. */
const KILL_GRACE_MS = 5_000;
const SUBMIT_PATH = "/v2/commands/submit-and-wait-for-transaction";
/** What CantonClient keeps of an error body. */
const ERROR_BODY_CHARS = 1024;

export interface RustSubmitOptions {
  participantUrl: string;
  token: string | TokenProvider;
  bin?: string;
  timeoutMs?: number;
  killGraceMs?: number;
}

/** One line of stdout, see packages/grant-sender/README.md. Anything else is an
 *  answer we cannot read, which proves nothing. */
function toResult(stdout: string): TransactionResult {
  let out: Record<string, unknown> | null;
  try {
    out = JSON.parse(stdout) as Record<string, unknown> | null;
  } catch {
    out = null;
  }
  if (out?.result === "committed" && typeof out.updateId === "string" && out.updateId !== "") {
    return {
      updateId: out.updateId,
      offset: typeof out.offset === "number" ? out.offset : 0,
      events: [],
    };
  }
  if (out?.result === "http" && typeof out.status === "number") {
    throw new CantonError(
      `POST ${SUBMIT_PATH} returned HTTP ${out.status}`,
      "HTTP_ERROR",
      out.status,
      String(out.body ?? "").slice(0, ERROR_BODY_CHARS)
    );
  }
  if (out?.result === "failed" && typeof out.code === "string") {
    throw new CantonError(`POST ${SUBMIT_PATH} failed: ${String(out.message)}`, out.code);
  }
  throw new CantonError(
    `grant-sender gave an unreadable answer: ${stdout.slice(0, 200)}`,
    "INVALID_RESPONSE"
  );
}

function run(bin: string, input: string, killAfterMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = execFile(
        bin,
        [],
        // The token goes over stdin. The empty env keeps it away from a proxy
        // the SDK would honour; it is no sandbox: the child runs as this user.
        { env: {}, timeout: killAfterMs, killSignal: "SIGKILL" },
        (err, stdout) => {
          if (!err) {
            resolve(stdout);
          } else if (child.pid === undefined || err.code === EXIT_BAD_REQUEST) {
            // Nothing can have reached the ledger.
            reject(new FaucetPreSubmitError(err));
          } else {
            reject(
              new CantonError(
                `grant-sender failed (exit ${err.code}, signal ${err.signal}): ${err.message}`,
                err.killed ? "TIMEOUT" : "TRANSPORT_ERROR"
              )
            );
          }
        }
      );
    } catch (err) {
      reject(new FaucetPreSubmitError(err));
      return;
    }
    // A child that dies before reading fails this write with EPIPE. A stream
    // error with no listener would take the whole facilitator down, and the
    // exit reports it anyway.
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream?.on("error", () => undefined);
    }
    child.stdin?.end(input);
  });
}

export function createRustSubmit(opts: RustSubmitOptions): FaucetSubmit {
  const {
    participantUrl,
    token,
    bin = GRANT_SENDER_BIN,
    timeoutMs = SUBMIT_TIMEOUT_MS,
    killGraceMs = KILL_GRACE_MS,
  } = opts;
  return async (commands) => {
    let bearer: string;
    try {
      bearer = typeof token === "string" ? token : await token();
    } catch (err) {
      throw new FaucetPreSubmitError(err);
    }
    const input = JSON.stringify({ participantUrl, token: bearer, timeoutMs, commands });
    return toResult(await run(bin, input, timeoutMs + killGraceMs));
  };
}
