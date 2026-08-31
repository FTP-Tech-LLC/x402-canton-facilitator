import { randomUUID } from "node:crypto";
import {
  CantonError,
  type CantonClient,
  type DisclosedContract,
} from "@ftptech/x402-canton-ledger";

/**
 * Agent CC faucet. The facilitator sends a tiny one-time Canton-Coin seed from
 * its OWN party to an agent party so the agent can run a real x402 payment with
 * NO human funding step (out-of-box e2e). This is `e2e/fund.mjs` turned into a
 * service: it is the SAME mechanism that funds every agent today —
 *
 *   1. select the facilitator's own Amulet holdings as inputs;
 *   2. resolve the token-standard transfer factory from Scan (with those inputs);
 *   3. submit `TransferFactory_Transfer` as `actAs:[facilitator]` (the facilitator
 *      controls its own LOCAL party via the validator m2m token — no agent key,
 *      no relay round-trip, and it pays its own gas exactly as on every settle).
 *
 * Because the agent (a fresh external party) has no `TransferPreapproval`, the
 * transfer lands as a PENDING `TransferInstruction` that the agent accepts with
 * the existing `claimAll` (`TransferInstruction_Accept`). The `auto_fund` MCP tool
 * does faucetClaim -> claimAll -> balance, so the agent ends with spendable CC.
 *
 * Safety lives in the ROUTE (per-party-once + per-IP cap + daily-budget breaker +
 * the explicit enable flag); this service just performs one bounded transfer.
 *
 * `getDso` + `resolveTransferFactory` are INJECTED so production wires them to the
 * same flavor-independent `getDso` + `scanFetchRetry` closures the wallet relay
 * already uses (the proven path), and tests mock them.
 */
export interface FaucetTransfer {
  sender: string;
  receiver: string;
  amount: string;
  instrumentId: { admin: string; id: string };
  requestedAt: string;
  executeBefore: string;
  inputHoldingCids: string[];
  meta: { values: Record<string, string> };
}

export interface ResolvedFaucetFactory {
  factoryId: string;
  transferFactoryTemplateId: string;
  choiceContextData: unknown;
  disclosedContracts: DisclosedContract[];
}

export interface FaucetServiceDeps {
  client: Pick<
    CantonClient,
    "submitAndWaitForTransaction" | "queryActiveContracts"
  >;
  /** The facilitator's own party — the faucet SENDER (and provider). */
  facilitatorParty: string;
  /** Ledger user the facilitator submits as (validator m2m). */
  userId: string;
  /** Global Synchronizer id to submit on. */
  synchronizerId: string;
  /** Per-claim CC amount (Daml Decimal string), e.g. "0.02". */
  amountCc: string;
  /** Authoritative DSO party id (from Scan). */
  getDso: () => Promise<string>;
  /** Resolve the token-standard transfer factory for `transfer` (with the
   *  facilitator's own inputHoldingCids). Wired in the route to the SAME
   *  scanFetchRetry path the relay's resolve/transfer-factory + e2e/fund.mjs use. */
  resolveTransferFactory: (args: {
    transfer: FaucetTransfer;
    dso: string;
  }) => Promise<ResolvedFaucetFactory>;
}

export interface FaucetClaimResult {
  updateId: string;
  amount: string;
  recipient: string;
}

const AMULET_TEMPLATE_ID = "#splice-amulet:Splice.Amulet:Amulet";
/** Fee headroom over the faucet amount when selecting inputs (the choice burns a
 *  small fee from inputs and returns change). Matches e2e/fund.mjs. */
const FEE_MARGIN_CC = 0.01;

/**
 * A claim that failed STRICTLY BEFORE the ledger submission — during the Scan
 * read, the ACS query on our own party, or the registry resolve. None of those
 * can move CC, so this is a proof that nothing was committed.
 *
 * It exists because the route's per-party reservation is a ONE-TIME lifetime
 * grant. Without a way to tell "we never asked the ledger" from "we asked and
 * lost the answer", the route had to fail closed on both, and an honest agent
 * lost its only faucet claim — with the daily and lifetime budget debited for
 * CC that never left — whenever Scan or the registry hiccuped.
 */
export class FaucetPreSubmitError extends Error {
  constructor(override readonly cause: unknown) {
    super(
      `faucet claim failed before submission: ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
    this.name = "FaucetPreSubmitError";
  }
}

/** Contention class: another submission consumed the funder's selected input
 *  Amulets mid-flight (409 duplicate/contention, 404 CONTRACT_NOT_FOUND). Safe
 *  to re-select inputs and try again; anything else is not. */
function isInputContention(err: unknown): boolean {
  // Unwrap: input contention is a 409/404 the SUBMIT returns, but the registry
  // resolve can answer 404 for a holding that was just spent, and that arrives
  // wrapped. Both deserve the single re-selection retry.
  const e = err instanceof FaucetPreSubmitError ? err.cause : err;
  return e instanceof CantonError && (e.status === 409 || e.status === 404);
}

export class FaucetService {
  constructor(private readonly deps: FaucetServiceDeps) {}

  /** All payouts spend the SAME funder party's Amulets, and selectInputs picks
   *  largest-first — N CONCURRENT claims therefore pick the SAME holdings and
   *  race (one wins, the rest 409/404; observed live under a parallel quest
   *  burst). Claims run through this in-process chain ONE at a time, and a
   *  single contention-class failure re-selects inputs once before giving up
   *  (bounded: unbounded retries burn GS traffic — see the TransferCommand
   *  retry-storm history). */
  private payoutTail: Promise<void> = Promise.resolve();

  async claim(input: { recipient: string }): Promise<FaucetClaimResult> {
    const prev = this.payoutTail;
    let release!: () => void;
    this.payoutTail = new Promise<void>((r) => {
      release = r;
    });
    // Wait for the previous payout regardless of its outcome.
    await prev.catch(() => undefined);
    try {
      try {
        return await this.payout(input);
      } catch (err) {
        if (!isInputContention(err)) throw err;
        return await this.payout(input);
      }
    } finally {
      release();
    }
  }

  private async payout(input: {
    recipient: string;
  }): Promise<FaucetClaimResult> {
    const { client, facilitatorParty, userId, synchronizerId, amountCc } =
      this.deps;

    // EVERYTHING up to the submit is preparation: a Scan read, an ACS query on
    // our own party, and a registry HTTP call. None of them can move CC, so a
    // failure here PROVES nothing was committed — and the caller needs that
    // fact, because it is the difference between "your one lifetime faucet
    // claim is still yours" and "you burned it on our registry timing out".
    // Without the marker the route saw a bare Error / a 5xx, could not tell it
    // from a lost submit, and had to fail closed: reservation held, daily and
    // lifetime budget debited, for a payout that never left the building.
    let transfer: FaucetTransfer;
    let dso: string;
    let f: Awaited<ReturnType<FaucetServiceDeps["resolveTransferFactory"]>>;
    try {
      dso = await this.deps.getDso();
      const inputHoldingCids = await this.selectInputs(
        facilitatorParty,
        Number(amountCc)
      );

      const now = Date.now();
      transfer = {
        sender: facilitatorParty,
        receiver: input.recipient,
        amount: amountCc,
        instrumentId: { admin: dso, id: "Amulet" },
        requestedAt: new Date(now - 1000).toISOString(),
        executeBefore: new Date(now + 3_600_000).toISOString(),
        inputHoldingCids,
        meta: { values: {} },
      };

      f = await this.deps.resolveTransferFactory({ transfer, dso });
    } catch (err) {
      throw new FaucetPreSubmitError(err);
    }

    const result = await client.submitAndWaitForTransaction({
      commandId: `faucet-${randomUUID()}`,
      userId,
      // Facilitator only — the faucet sends the facilitator's OWN CC; no agent
      // signature is involved (the agent accepts the resulting pending transfer
      // itself, later, via claimAll).
      actAs: [facilitatorParty],
      synchronizerId,
      disclosedContracts: f.disclosedContracts,
      commands: [
        {
          ExerciseCommand: {
            templateId: f.transferFactoryTemplateId,
            contractId: f.factoryId,
            choice: "TransferFactory_Transfer",
            choiceArgument: {
              expectedAdmin: dso,
              transfer,
              extraArgs: {
                context: f.choiceContextData,
                meta: { values: {} },
              },
            },
          },
        },
      ],
    });

    return { updateId: result.updateId, amount: amountCc, recipient: input.recipient };
  }

  /**
   * Select the facilitator's own Amulet holdings to fund the faucet transfer,
   * largest first, until they cover the amount plus a small fee headroom. Mirrors
   * preapproval.ts `selectFeeInputs` + e2e/fund.mjs. Throws when the facilitator
   * cannot even cover the amount (it is unfunded — the operator must top it up).
   */
  private async selectInputs(party: string, wantCc: number): Promise<string[]> {
    const events = await this.deps.client.queryActiveContracts({
      filtersByParty: {
        [party]: {
          cumulative: [
            {
              identifierFilter: {
                TemplateFilter: {
                  value: {
                    templateId: AMULET_TEMPLATE_ID,
                    includeCreatedEventBlob: false,
                  },
                },
              },
            },
          ],
        },
      },
    });
    const holdings = events
      .map((e) => {
        const arg = e.createArgument as
          | { amount?: { initialAmount?: string } }
          | undefined;
        return {
          cid: e.contractId,
          amount: Number(arg?.amount?.initialAmount ?? 0),
        };
      })
      .filter((h) => Boolean(h.cid) && h.amount > 0)
      .sort((a, b) => b.amount - a.amount);

    const inputs: string[] = [];
    let total = 0;
    for (const h of holdings) {
      inputs.push(h.cid);
      total += h.amount;
      if (total >= wantCc + FEE_MARGIN_CC) break;
    }
    if (total < wantCc || inputs.length === 0) {
      throw new Error(
        `faucet: facilitator has insufficient Amulet holdings to fund ${wantCc} CC ` +
          `(have ${total} CC) — top up the facilitator party`
      );
    }
    return inputs;
  }
}
