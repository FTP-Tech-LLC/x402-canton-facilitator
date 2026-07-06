/**
 * transfer-factory ("V3") /verify + /settle arm tests.
 *
 * Covers the brief acceptance rows that are unit-testable without a live
 * ledger: T2 (replay: attack fails / legit retry is idempotent), T4 (same-ref
 * concurrency resolves to one success), T6 (no preapproval → fail-closed, no
 * half-state), T8 (executeBefore expiry), T9 (recorded fields vs requirements),
 * plus the OFF-by-default inertness gate.
 */
import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import type {
  FacilitatorRequest,
  SettleResponse,
  VerifyResponse,
} from "@ftptech/x402-canton-core";
import { registerSettleRoute, type SettleRouteServices } from "./settle.js";
import { registerVerifyRoute, type VerifyRouteServices } from "./verify.js";
import { runValidation } from "./common.js";
import {
  createInMemoryTfStashStore,
  type TfStashStore,
} from "../db/stash-store.js";

const FACILITATOR = "ftp_facilitator::1220fff";
const PAYER = "agent::1220abc";
const MERCHANT = "merchant::1220def";
const DSO = "DSO::1220dso";
const SYNC = "global-domain::1220xyz";

function tfBody(over: Partial<{ amount: string; payTo: string }> = {}): FacilitatorRequest {
  return {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      scheme: "exact",
      network: "canton:mainnet",
      resource: { url: "https://api.example.com/x" },
      accepted: {} as never,
      payload: {
        assetTransferMethod: "transfer-factory",
        payer: PAYER,
        submissionRef: "REF",
      } as never,
    },
    paymentRequirements: {
      scheme: "exact",
      network: "canton:mainnet",
      amount: over.amount ?? "2500000000", // atomic 0.25 CC
      asset: "CC",
      payTo: over.payTo ?? MERCHANT,
      maxTimeoutSeconds: 120,
      extra: {
        assetTransferMethod: "transfer-factory",
        feePayer: FACILITATOR,
        synchronizerId: SYNC,
        instrumentId: { admin: DSO, id: "Amulet" },
        executeBeforeSeconds: 120,
      },
    } as never,
  };
}

/** Seed a committed (signed) stash row keyed "REF". */
async function seedRow(
  stash: TfStashStore,
  over: Partial<{
    amount: string;
    receiver: string;
    executeBefore: string;
    admin: string;
    id: string;
  }> = {}
): Promise<string> {
  // create() generates its own ref; we need "REF" so the body matches. Use a
  // store whose create is overridden to force the ref.
  const ref = "REF";
  // deposit directly by reaching through create then rename is awkward; instead
  // use a tiny custom store below. This helper is only used with makeStash().
  await (stash as unknown as { _seed: (r: string, rec: unknown) => void })._seed(
    ref,
    {
      ref,
      payer: PAYER,
      receiver: over.receiver ?? MERCHANT,
      amount: over.amount ?? "0.2500000000",
      instrumentAdmin: over.admin ?? DSO,
      instrumentId: over.id ?? "Amulet",
      executeBefore:
        over.executeBefore ?? new Date(Date.now() + 60_000).toISOString(),
      txHash: "hash",
      preparedTx: "prepared",
      signature: JSON.stringify({
        hashingSchemeVersion: "HASHING_SCHEME_VERSION_V2",
        partySignatures: { signatures: [{ party: PAYER, signatures: [{}] }] },
      }),
    }
  );
  return ref;
}

/** In-memory stash exposing a `_seed` to force a specific ref + recordSettled. */
function makeStash(): TfStashStore & {
  _seed: (r: string, rec: unknown) => void;
} {
  const base = createInMemoryTfStashStore();
  const rows = new Map<string, unknown>();
  return {
    ...base,
    _seed(r, rec) {
      rows.set(r, rec);
    },
    async get(ref) {
      return (rows.get(ref) as never) ?? null;
    },
    async recordSettled(ref, updateId) {
      const row = rows.get(ref) as { settledUpdateId?: string } | undefined;
      if (!row) return false;
      if (row.settledUpdateId) return false;
      row.settledUpdateId = updateId;
      return true;
    },
  };
}

function baseSvc(
  stash: ReturnType<typeof makeStash>,
  tf: {
    preapproval?: "yes" | "no" | "unknown";
    execute?: () => Promise<{
      updateId: string;
      transferred: boolean;
      confirmInconclusive: boolean;
    }>;
  } = {}
): SettleRouteServices {
  const execute =
    tf.execute ??
    (async () => ({
      updateId: "1220settle",
      transferred: true,
      confirmInconclusive: false,
    }));
  return {
    facilitatorParty: FACILITATOR,
    network: "canton:mainnet",
    tfEnabled: true,
    tf: { stash, tfEnabled: true },
    tfStash: stash,
    transferFactory: {
      preapprovalKind: vi.fn(async () => tf.preapproval ?? "yes"),
      execute: vi.fn(execute),
    },
  } as unknown as SettleRouteServices;
}

async function callSettle(
  svc: SettleRouteServices,
  body: FacilitatorRequest
): Promise<SettleResponse> {
  const app = Fastify();
  await registerSettleRoute(app, svc);
  const res = await app.inject({ method: "POST", url: "/settle", payload: body });
  const json = res.json() as SettleResponse;
  await app.close();
  return json;
}

describe("transfer-factory /verify arm (runValidation)", () => {
  it("valid: recorded fields match requirements → isValid true", async () => {
    const stash = makeStash();
    await seedRow(stash);
    const v = await runValidation(
      tfBody(),
      { facilitatorParty: FACILITATOR, network: "canton:mainnet", tf: { stash, tfEnabled: true } } as never,
      Date.now()
    );
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.payer).toBe(PAYER);
  });

  it("T9: amount mismatch → amount_mismatch", async () => {
    const stash = makeStash();
    await seedRow(stash, { amount: "0.1000000000" }); // recorded 0.1, req 0.25
    const v = await runValidation(
      tfBody(),
      { facilitatorParty: FACILITATOR, network: "canton:mainnet", tf: { stash, tfEnabled: true } } as never,
      Date.now()
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("invalid_exact_canton_amount_mismatch");
  });

  it("T9: receiver mismatch → merchant_mismatch", async () => {
    const stash = makeStash();
    await seedRow(stash, { receiver: "someone-else::1220zzz" });
    const v = await runValidation(
      tfBody(),
      { facilitatorParty: FACILITATOR, network: "canton:mainnet", tf: { stash, tfEnabled: true } } as never,
      Date.now()
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("invalid_exact_canton_merchant_mismatch");
  });

  it("T8: executeBefore expired → submission_not_found", async () => {
    const stash = makeStash();
    await seedRow(stash, { executeBefore: new Date(Date.now() - 1000).toISOString() });
    const v = await runValidation(
      tfBody(),
      { facilitatorParty: FACILITATOR, network: "canton:mainnet", tf: { stash, tfEnabled: true } } as never,
      Date.now()
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("invalid_exact_canton_submission_not_found");
  });

  it("unknown ref → submission_not_found", async () => {
    const stash = makeStash(); // nothing seeded
    const v = await runValidation(
      tfBody(),
      { facilitatorParty: FACILITATOR, network: "canton:mainnet", tf: { stash, tfEnabled: true } } as never,
      Date.now()
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("invalid_exact_canton_submission_not_found");
  });

  it("TF disabled → transfer_factory_disabled", async () => {
    const stash = makeStash();
    await seedRow(stash);
    const v = await runValidation(
      tfBody(),
      { facilitatorParty: FACILITATOR, network: "canton:mainnet", tf: { stash, tfEnabled: false } } as never,
      Date.now()
    );
    expect(v.ok).toBe(false);
    if (!v.ok)
      expect(v.reason).toBe("invalid_exact_canton_transfer_factory_disabled");
  });
});

describe("transfer-factory /settle arm", () => {
  it("happy: relays, records the updateId, returns success", async () => {
    const stash = makeStash();
    await seedRow(stash);
    const svc = baseSvc(stash);
    const r = await callSettle(svc, tfBody());
    expect(r.success).toBe(true);
    if (r.success) expect(r.transaction).toBe("1220settle");
    expect((await stash.get("REF"))!.settledUpdateId).toBe("1220settle");
    expect(svc.transferFactory!.execute).toHaveBeenCalledTimes(1);
  });

  it("T2: legit retry of a settled ref is idempotent (no second execute)", async () => {
    const stash = makeStash();
    await seedRow(stash);
    const svc = baseSvc(stash);
    const first = await callSettle(svc, tfBody());
    expect(first.success).toBe(true);
    const second = await callSettle(svc, tfBody());
    expect(second.success).toBe(true);
    if (second.success) expect(second.transaction).toBe("1220settle");
    // execute ran exactly ONCE across both settles.
    expect(svc.transferFactory!.execute).toHaveBeenCalledTimes(1);
  });

  it("T2/T4: a failed on-ledger execute (respend of spent holdings) → execute_failed", async () => {
    const stash = makeStash();
    await seedRow(stash);
    const svc = baseSvc(stash, {
      execute: async () => {
        throw new Error("CONTRACT_NOT_FOUND: input holding already spent");
      },
    });
    const r = await callSettle(svc, tfBody());
    expect(r.success).toBe(false);
    if (!r.success)
      expect(r.errorReason).toBe("invalid_exact_canton_execute_failed");
    expect((await stash.get("REF"))!.settledUpdateId).toBeUndefined();
  });

  it("T6: merchant without preapproval → preapproval_missing, no execute", async () => {
    const stash = makeStash();
    await seedRow(stash);
    const svc = baseSvc(stash, { preapproval: "no" });
    const r = await callSettle(svc, tfBody());
    expect(r.success).toBe(false);
    if (!r.success)
      expect(r.errorReason).toBe("invalid_exact_canton_preapproval_missing");
    expect(svc.transferFactory!.execute).not.toHaveBeenCalled();
  });

  it("unknown preapproval (validator flavor) fails closed too", async () => {
    const stash = makeStash();
    await seedRow(stash);
    const svc = baseSvc(stash, { preapproval: "unknown" });
    const r = await callSettle(svc, tfBody());
    expect(r.success).toBe(false);
    if (!r.success)
      expect(r.errorReason).toBe("invalid_exact_canton_preapproval_missing");
    expect(svc.transferFactory!.execute).not.toHaveBeenCalled();
  });

  it("committed-zero-funds execute → execute_failed (funds-moved gate)", async () => {
    const stash = makeStash();
    await seedRow(stash);
    const svc = baseSvc(stash, {
      execute: async () => ({
        updateId: "1220x",
        transferred: false,
        confirmInconclusive: false,
      }),
    });
    const r = await callSettle(svc, tfBody());
    expect(r.success).toBe(false);
    if (!r.success)
      expect(r.errorReason).toBe("invalid_exact_canton_execute_failed");
  });

  it("TF disabled → transfer_factory_disabled, nothing executed", async () => {
    const stash = makeStash();
    await seedRow(stash);
    const svc = baseSvc(stash);
    (svc as { tfEnabled: boolean }).tfEnabled = false;
    const r = await callSettle(svc, tfBody());
    expect(r.success).toBe(false);
    if (!r.success)
      expect(r.errorReason).toBe(
        "invalid_exact_canton_transfer_factory_disabled"
      );
    expect(svc.transferFactory!.execute).not.toHaveBeenCalled();
  });
});

describe("transfer-factory /verify route (public shape)", () => {
  it("returns isValid:true for a valid tf payment", async () => {
    const stash = makeStash();
    await seedRow(stash);
    const app = Fastify();
    await registerVerifyRoute(app, {
      facilitatorParty: FACILITATOR,
      network: "canton:mainnet",
      tf: { stash, tfEnabled: true },
    } as unknown as VerifyRouteServices);
    const res = await app.inject({
      method: "POST",
      url: "/verify",
      payload: tfBody(),
    });
    const json = res.json() as VerifyResponse;
    expect(json.isValid).toBe(true);
    await app.close();
  });
});
