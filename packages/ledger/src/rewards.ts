/**
 * Integrator-side app-reward helpers for x402 (CIP-47 Featured App Activity
 * Markers + claiming the resulting coupons).
 *
 * EMISSION: a project that integrates x402 and holds a `FeaturedAppRight` emits
 * a `FeaturedAppActivityMarker` per settled x402 payment via its own
 * `X402ProviderContext` (DAML package `canton-x402-provider`).
 *
 * CLAIM: the DSO converts each marker into an `AppRewardCoupon` (~10 min); the
 * project mints CC from those coupons via `AmuletRules_Transfer` with
 * `InputAppRewardCoupon`. Note: a validator's wallet automation usually
 * auto-claims coupons, so this manual claim is for control / setups without it.
 *
 * Everything here is submitted as the integrator's OWN party, so the
 * INTEGRATOR's validator pays the tiny traffic and earns the reward; the x402
 * facilitator is never involved. The facilitator code does not import this.
 */
import type {
  CantonClient,
  CreateCommand,
  CreatedEvent,
  DisclosedContract,
  ExerciseCommand,
  TransactionResult,
} from "./client.js";
import type { ScanClient } from "./scan.js";

/** Package-name templateId of the integrator-side X402ProviderContext. */
export const X402_PROVIDER_CONTEXT_TEMPLATE =
  "#canton-x402-provider:Canton.X402Provider:X402ProviderContext";

type Submitter = Pick<CantonClient, "submitAndWaitForTransaction">;

export interface X402PaymentInput {
  resourceUrl: string;
  updateId: string;
  amount: string;
}

// ─── emission: command builders (pure) ──────────────────────────────────────

export function buildCreateProviderContextCommand(args: {
  app: string;
  featuredAppRightCid: string;
  templateId?: string;
}): CreateCommand {
  return {
    CreateCommand: {
      templateId: args.templateId ?? X402_PROVIDER_CONTEXT_TEMPLATE,
      createArguments: {
        app: args.app,
        featuredAppRightCid: args.featuredAppRightCid,
      },
    },
  };
}

export function buildRecordX402PaymentCommand(args: {
  providerContextCid: string;
  resourceUrl: string;
  updateId: string;
  amount: string;
  recordedAt: string;
  templateId?: string;
}): ExerciseCommand {
  return {
    ExerciseCommand: {
      templateId: args.templateId ?? X402_PROVIDER_CONTEXT_TEMPLATE,
      contractId: args.providerContextCid,
      choice: "RecordX402Payment",
      choiceArgument: {
        resourceUrl: args.resourceUrl,
        updateId: args.updateId,
        amount: args.amount,
        recordedAt: args.recordedAt,
      },
    },
  };
}

export function buildRecordX402PaymentBatchCommand(args: {
  providerContextCid: string;
  payments: X402PaymentInput[];
  recordedAt: string;
  templateId?: string;
}): ExerciseCommand {
  return {
    ExerciseCommand: {
      templateId: args.templateId ?? X402_PROVIDER_CONTEXT_TEMPLATE,
      contractId: args.providerContextCid,
      choice: "RecordX402PaymentBatch",
      choiceArgument: {
        payments: args.payments,
        recordedAt: args.recordedAt,
      },
    },
  };
}

// ─── emission: submitters (act as the integrator's party) ───────────────────

export interface CreateProviderContextArgs {
  app: string;
  featuredAppRightCid: string;
  userId: string;
  synchronizerId: string;
  templateId?: string;
}

/** Create the integrator's X402ProviderContext once (binds party -> FeaturedAppRight). */
export async function createX402ProviderContext(
  client: Submitter,
  args: CreateProviderContextArgs
): Promise<TransactionResult> {
  return client.submitAndWaitForTransaction({
    commandId: `x402-provider-context-${args.app}`,
    userId: args.userId,
    actAs: [args.app],
    synchronizerId: args.synchronizerId,
    commands: [
      buildCreateProviderContextCommand({
        app: args.app,
        featuredAppRightCid: args.featuredAppRightCid,
        ...(args.templateId ? { templateId: args.templateId } : {}),
      }),
    ],
  });
}

export interface RecordX402PaymentArgs {
  providerContextCid: string;
  app: string;
  userId: string;
  synchronizerId: string;
  resourceUrl: string;
  updateId: string;
  amount: string;
  recordedAt?: string;
  templateId?: string;
}

/**
 * Emit one app-reward marker for a settled x402 payment, atomically with its
 * audit record. `commandId` is derived from the updateId so a retry is
 * idempotent. actAs = the integrator's party.
 */
export async function recordX402Payment(
  client: Submitter,
  args: RecordX402PaymentArgs
): Promise<TransactionResult> {
  const recordedAt = args.recordedAt ?? new Date().toISOString();
  return client.submitAndWaitForTransaction({
    commandId: `x402-marker-${args.updateId}`,
    userId: args.userId,
    actAs: [args.app],
    synchronizerId: args.synchronizerId,
    commands: [
      buildRecordX402PaymentCommand({
        providerContextCid: args.providerContextCid,
        resourceUrl: args.resourceUrl,
        updateId: args.updateId,
        amount: args.amount,
        recordedAt,
        ...(args.templateId ? { templateId: args.templateId } : {}),
      }),
    ],
  });
}

export interface RecordX402PaymentBatchArgs {
  providerContextCid: string;
  app: string;
  userId: string;
  synchronizerId: string;
  payments: X402PaymentInput[];
  recordedAt?: string;
  templateId?: string;
}

/**
 * Batch-emit markers for many settled payments in ONE submission (one traffic
 * charge on the integrator's validator). Run on an interval to minimize cost.
 */
export async function recordX402PaymentBatch(
  client: Submitter,
  args: RecordX402PaymentBatchArgs
): Promise<TransactionResult> {
  const recordedAt = args.recordedAt ?? new Date().toISOString();
  return client.submitAndWaitForTransaction({
    commandId: `x402-marker-batch-${recordedAt}`,
    userId: args.userId,
    actAs: [args.app],
    synchronizerId: args.synchronizerId,
    commands: [
      buildRecordX402PaymentBatchCommand({
        providerContextCid: args.providerContextCid,
        payments: args.payments,
        recordedAt,
        ...(args.templateId ? { templateId: args.templateId } : {}),
      }),
    ],
  });
}

// ─── round marker: emit one weighted FeaturedAppActivityMarker per mining round ─

/** Package-name templateId for the DSO-issued FeaturedAppRight (v2). */
export const FEATURED_APP_RIGHT_V2_TEMPLATE =
  "#splice-api-featured-app-v2:Splice.Api.FeaturedAppRightV2:FeaturedAppRight";

export interface EmitX402RoundMarkerArgs {
  /** FTP's own party — holds the FeaturedAppRight and earns the reward. */
  app: string;
  userId: string;
  synchronizerId: string;
  featuredAppRightCid: string;
  /** USD weight for this round: Σ(traffic_bytes) / 1e6 * 60. */
  weight: number;
  /** Mining round number — baked into commandId for idempotent retries. */
  roundNumber: number;
}

/**
 * Emit one FeaturedAppActivityMarker for a mining round with a USD weight.
 * Exercises FeaturedAppRight_CreateActivityMarker directly (no X402ProviderContext)
 * so the weight reflects actual traffic burned rather than a fixed per-payment 1.0.
 * commandId is deterministic on roundNumber → safe to retry on network failure.
 */
export async function emitX402RoundMarker(
  client: Submitter,
  args: EmitX402RoundMarkerArgs
): Promise<TransactionResult> {
  return client.submitAndWaitForTransaction({
    commandId: `x402-round-marker-${args.roundNumber}`,
    userId: args.userId,
    actAs: [args.app],
    synchronizerId: args.synchronizerId,
    commands: [
      {
        ExerciseCommand: {
          templateId: FEATURED_APP_RIGHT_V2_TEMPLATE,
          contractId: args.featuredAppRightCid,
          choice: "FeaturedAppRight_CreateActivityMarker",
          choiceArgument: {
            beneficiaries: [
              { beneficiary: args.app, weight: "1.0000000000" },
            ],
            weight: args.weight.toFixed(10),
          },
        },
      } as ExerciseCommand,
    ],
  });
}

// ─── claim: turn AppRewardCoupons into CC (AmuletRules_Transfer) ─────────────

const APP_REWARD_COUPON_SUFFIX = ":Splice.Amulet:AppRewardCoupon";
/** Package-name templateId used to filter the ACS query for coupons. */
export const APP_REWARD_COUPON_TEMPLATE = `#splice-amulet${APP_REWARD_COUPON_SUFFIX}`;

export interface AppRewardCouponInfo {
  contractId: string;
  amount: string;
  /** The mining round the coupon belongs to (claimable only once that round is issuing). */
  roundNumber: string;
  featured: boolean;
}

export function parseAppRewardCoupons(
  events: CreatedEvent[]
): AppRewardCouponInfo[] {
  const out: AppRewardCouponInfo[] = [];
  for (const e of events) {
    if (!e.templateId.endsWith(APP_REWARD_COUPON_SUFFIX)) continue;
    const a = e.createArgument as {
      amount?: string;
      round?: { number?: string };
      featured?: boolean;
    };
    out.push({
      contractId: e.contractId,
      amount: a.amount ?? "0",
      roundNumber: a.round?.number ?? "",
      featured: a.featured ?? false,
    });
  }
  return out;
}

/** Sum 10-dp decimal strings without float precision loss. */
export function sumDecimals10(amounts: string[]): string {
  const SCALE = 10;
  let total = 0n;
  for (const a of amounts) {
    const neg = a.startsWith("-");
    const [i, f = ""] = (neg ? a.slice(1) : a).split(".");
    const scaled = BigInt((i || "0") + (f + "0".repeat(SCALE)).slice(0, SCALE));
    total += neg ? -scaled : scaled;
  }
  const negTotal = total < 0n;
  const s = (negTotal ? -total : total).toString().padStart(SCALE + 1, "0");
  return `${negTotal ? "-" : ""}${s.slice(0, -SCALE)}.${s.slice(-SCALE)}`;
}

export async function findAppRewardCoupons(
  client: Pick<CantonClient, "queryActiveContracts">,
  app: string
): Promise<AppRewardCouponInfo[]> {
  const events = await client.queryActiveContracts({
    filtersByParty: {
      [app]: {
        cumulative: [
          {
            identifierFilter: {
              TemplateFilter: {
                value: {
                  templateId: APP_REWARD_COUPON_TEMPLATE,
                  includeCreatedEventBlob: false,
                },
              },
            },
          },
        ],
      },
    },
  });
  return parseAppRewardCoupons(events);
}

export function buildClaimAppRewardsCommand(args: {
  amuletRulesTemplateId: string;
  amuletRulesCid: string;
  app: string;
  couponCids: string[];
  amount: string;
  openMiningRoundCid: string;
  issuingMiningRounds: Array<[{ number: string }, string]>;
  expectedDso: string;
}): ExerciseCommand {
  return {
    ExerciseCommand: {
      templateId: args.amuletRulesTemplateId,
      contractId: args.amuletRulesCid,
      choice: "AmuletRules_Transfer",
      choiceArgument: {
        transfer: {
          sender: args.app,
          provider: args.app,
          // Daml variant {tag, value} encoding in JSON Ledger API v2.
          inputs: args.couponCids.map((cid) => ({
            tag: "InputAppRewardCoupon",
            value: cid,
          })),
          outputs: [
            {
              receiver: args.app,
              receiverFeeRatio: "0.0",
              amount: args.amount,
              lock: null,
            },
          ],
          beneficiaries: null,
        },
        context: {
          openMiningRound: args.openMiningRoundCid,
          issuingMiningRounds: args.issuingMiningRounds,
          validatorRights: [],
          featuredAppRight: null,
        },
        // anti-swap: must match the DSO embedded in AmuletRules.
        expectedDso: args.expectedDso,
      },
    },
  };
}

/** Highest-number open round whose opensAt has passed (eligible); falls back to
 *  the highest-number round overall. Local copy to keep the ledger package
 *  self-contained (mirrors the facilitator's settle-path selection). */
function pickOpenRound<
  T extends {
    contract: { payload: { round: { number: string }; opensAt?: string } };
  }
>(rounds: readonly T[], nowMs: number): T | undefined {
  if (rounds.length === 0) return undefined;
  const scored = rounds.map((r) => {
    let num: bigint;
    try {
      num = BigInt(r.contract.payload.round.number);
    } catch {
      num = -1n;
    }
    const opensAtMs = r.contract.payload.opensAt
      ? Date.parse(r.contract.payload.opensAt)
      : NaN;
    return { r, num, opensAtMs };
  });
  const eligible = scored.filter(
    (x) => !Number.isFinite(x.opensAtMs) || x.opensAtMs <= nowMs
  );
  const pool = eligible.length > 0 ? eligible : scored;
  pool.sort((a, b) => (a.num < b.num ? 1 : a.num > b.num ? -1 : 0));
  return pool[0]?.r;
}

export interface ClaimAppRewardsResult {
  claimedCount: number;
  amount: string;
  updateId: string;
}

/**
 * Claim the integrator's currently-issuable AppRewardCoupons into CC. Only
 * coupons whose round is already in the issuing set are claimable (feeding an
 * earlier round fails with "TransferContext did not contain issuing mining
 * round"). Returns null when there is nothing claimable. Submitted as `app`.
 */
export async function claimAppRewards(
  client: Pick<
    CantonClient,
    "queryActiveContracts" | "submitAndWaitForTransaction"
  >,
  scan: Pick<ScanClient, "getAmuletRules" | "getOpenAndIssuingMiningRounds">,
  args: { app: string; userId: string; nowMs?: number }
): Promise<ClaimAppRewardsResult | null> {
  const coupons = await findAppRewardCoupons(client, args.app);
  if (coupons.length === 0) return null;

  const [amulet, rounds] = await Promise.all([
    scan.getAmuletRules(),
    scan.getOpenAndIssuingMiningRounds(),
  ]);
  const issuingNumbers = new Set(
    rounds.issuing_mining_rounds.map((ir) => ir.contract.payload.round.number)
  );
  const claimable = coupons.filter((c) => issuingNumbers.has(c.roundNumber));
  if (claimable.length === 0) return null; // coupons exist but rounds not issuing yet

  const openRound = pickOpenRound(
    rounds.open_mining_rounds,
    args.nowMs ?? Date.now()
  );
  if (!openRound) return null;

  const arc = amulet.amulet_rules.contract;
  const synchronizerId = amulet.amulet_rules.domain_id;
  const amount = sumDecimals10(claimable.map((c) => c.amount));

  const issuingPairs: Array<[{ number: string }, string]> = [];
  const disclosedContracts: DisclosedContract[] = [
    {
      templateId: arc.template_id,
      contractId: arc.contract_id,
      createdEventBlob: arc.created_event_blob,
      synchronizerId,
    },
    {
      templateId: openRound.contract.template_id,
      contractId: openRound.contract.contract_id,
      createdEventBlob: openRound.contract.created_event_blob,
      synchronizerId,
    },
  ];
  for (const ir of rounds.issuing_mining_rounds) {
    issuingPairs.push([
      { number: ir.contract.payload.round.number },
      ir.contract.contract_id,
    ]);
    disclosedContracts.push({
      templateId: ir.contract.template_id,
      contractId: ir.contract.contract_id,
      createdEventBlob: ir.contract.created_event_blob,
      synchronizerId,
    });
  }

  const result = await client.submitAndWaitForTransaction({
    commandId: `claim-app-rewards-${claimable[0]!.contractId}`,
    userId: args.userId,
    actAs: [args.app],
    synchronizerId,
    disclosedContracts,
    commands: [
      buildClaimAppRewardsCommand({
        amuletRulesTemplateId: arc.template_id,
        amuletRulesCid: arc.contract_id,
        app: args.app,
        couponCids: claimable.map((c) => c.contractId),
        amount,
        openMiningRoundCid: openRound.contract.contract_id,
        issuingMiningRounds: issuingPairs,
        expectedDso: arc.payload.dso,
      }),
    ],
  });

  return {
    claimedCount: claimable.length,
    amount,
    updateId: result.updateId,
  };
}
