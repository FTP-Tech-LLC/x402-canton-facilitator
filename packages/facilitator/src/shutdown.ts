/**
 * A DEPLOY MUST NOT CUT A PAYMENT IN HALF — AND MUST NOT HANG FOREVER TRYING
 * NOT TO.
 *
 * `/settle` holds a request across two ledger calls: an execute with a 45s
 * budget, then a completion poll of 20 × 600ms. So a settle that has already
 * dispatched a submission can be in flight for the better part of a minute, and
 * during that window the participant may sequence it whether we are listening
 * or not.
 *
 * Two things were wrong on the way out:
 *
 *   1. `await app.close()` had NO deadline. Under a stuck ledger call it never
 *      returns, so the process sits there until the orchestrator loses patience
 *      and SIGKILLs it — which is the same outcome, reached later and in a less
 *      predictable place.
 *   2. Nothing shipped a `stop_grace_period`, so Docker's default is 10s. That
 *      is shorter than a single in-flight settle, meaning the ordinary
 *      documented upgrade could kill the process mid-payment. The compose files
 *      now ask for more time; this asks for less than they give, so WE decide
 *      when to stop waiting rather than being killed mid-decision.
 *
 * The deadline is deliberately shorter than the compose grace: losing the race
 * to SIGKILL means no final log line and no chance to record anything.
 */

/** Longer than one worst-case in-flight settle (45s execute + ~12s poll), and
 *  shorter than the 70s `stop_grace_period` the shipped composes set. */
export const DRAIN_DEADLINE_MS = 55_000;

export interface ShutdownDeps {
  /** Usually `app.close()`. */
  close: () => Promise<void>;
  exit: (code: number) => void;
  log: {
    info: (obj: unknown, msg: string) => void;
    error: (obj: unknown, msg: string) => void;
  };
  deadlineMs?: number;
  /** Injected so the test does not wait 55 real seconds. */
  setTimeoutFn?: typeof setTimeout;
}

/**
 * Build the SIGTERM/SIGINT handler.
 *
 * Repeat signals are ignored rather than starting a second drain — an operator
 * pressing Ctrl-C twice, or an orchestrator sending SIGTERM then SIGINT, should
 * not race two `close()` calls against each other.
 */
export function createShutdownHandler(
  deps: ShutdownDeps
): (signal: string) => Promise<void> {
  const deadlineMs = deps.deadlineMs ?? DRAIN_DEADLINE_MS;
  const timer = deps.setTimeoutFn ?? setTimeout;
  let started = false;

  return async function shutdown(signal: string): Promise<void> {
    if (started) {
      deps.log.info({ signal }, "shutdown already in progress; ignoring signal");
      return;
    }
    started = true;
    deps.log.info({ signal, deadlineMs }, "shutting down: draining in-flight requests");

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([
      deps.close().then(() => "drained" as const),
      new Promise<"timeout">((resolve) => {
        timeoutHandle = timer(() => resolve("timeout"), deadlineMs);
      }),
    ]).catch(() => "error" as const);
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);

    if (drained === "drained") {
      deps.log.info({ signal }, "shutdown: drained cleanly");
    } else {
      // Say it plainly. A settle that was mid-flight here may well have been
      // sequenced on the ledger, and the next process needs to know that this
      // one stopped without seeing the answer.
      deps.log.error(
        { signal, deadlineMs, outcome: drained },
        "shutdown: gave up waiting for in-flight requests — a settle dispatched " +
          "before this point may have committed WITHOUT being recorded here"
      );
    }
    // Exit 0 either way: this was an orderly stop that ran out of patience, not
    // a crash, and a non-zero code would make restart policies read it as one.
    deps.exit(0);
  };
}
