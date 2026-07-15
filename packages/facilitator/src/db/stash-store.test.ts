import { describe, it, expect } from "vitest";
import {
  createInMemoryTfStashStore,
  createPostgresTfStashStore,
  createTfStashStore,
  type TfStashStore,
} from "./stash-store.js";
import type { PgExecutor } from "./pool.js";

const PAYER = "agent::1220aaaa";
const RECEIVER = "merchant::1220bbbb";

function baseRec(executeBefore: string) {
  return {
    payer: PAYER,
    receiver: RECEIVER,
    amount: "0.2500000000",
    instrumentAdmin: "DSO::1220cccc",
    instrumentId: "Amulet",
    executeBefore,
    txHash: "ab".repeat(32),
    preparedTx: "cHJlcGFyZWQ=",
  };
}

function future(ms = 60_000): string {
  return new Date(Date.now() + ms).toISOString();
}
function past(ms = 60_000): string {
  return new Date(Date.now() - ms).toISOString();
}

describe("InMemoryTfStashStore", () => {
  it("create → get round-trips the record with a fresh ref", async () => {
    const s = createInMemoryTfStashStore();
    const ref = await s.create(baseRec(future()));
    const row = await s.get(ref);
    expect(row).not.toBeNull();
    expect(row!.ref).toBe(ref);
    expect(row!.payer).toBe(PAYER);
    expect(row!.receiver).toBe(RECEIVER);
    expect(row!.signature).toBeUndefined();
    expect(row!.settledUpdateId).toBeUndefined();
  });

  it("create → get round-trips an optional memo (omitted when unset)", async () => {
    const s = createInMemoryTfStashStore();
    const withMemo = await s.create({ ...baseRec(future()), memo: "order-42" });
    expect((await s.get(withMemo))!.memo).toBe("order-42");
    // A record created without a memo carries none on read-back.
    const without = await s.create(baseRec(future()));
    expect((await s.get(without))!.memo).toBeUndefined();
  });

  it("attachSignature: ok once, already_signed on repeat, not_found on junk", async () => {
    const s = createInMemoryTfStashStore();
    const ref = await s.create(baseRec(future()));
    expect(await s.attachSignature(ref, "c2ln")).toBe("ok");
    expect((await s.get(ref))!.signature).toBe("c2ln");
    expect(await s.attachSignature(ref, "b3RoZXI=")).toBe("already_signed");
    // The first signature must survive the rejected overwrite.
    expect((await s.get(ref))!.signature).toBe("c2ln");
    expect(await s.attachSignature("nope", "c2ln")).toBe("not_found");
  });

  it("attachSignature: expired ref refuses the signature (T8 at commit time)", async () => {
    const s = createInMemoryTfStashStore();
    const ref = await s.create(baseRec(past()));
    expect(await s.attachSignature(ref, "c2ln")).toBe("expired");
  });

  it("recordSettled: true once, false on the second write (idempotent success)", async () => {
    const s = createInMemoryTfStashStore();
    const ref = await s.create(baseRec(future()));
    expect(await s.recordSettled(ref, "1220update1")).toBe(true);
    expect(await s.recordSettled(ref, "1220update2")).toBe(false);
    // The ORIGINAL updateId wins — a legit retry returns the recorded success.
    expect((await s.get(ref))!.settledUpdateId).toBe("1220update1");
  });

  it("sweep: drops expired-unsettled rows, retains settled rows until their retention", async () => {
    const s = createInMemoryTfStashStore();
    const dead = await s.create(baseRec(past(120_000)));
    const settled = await s.create(baseRec(past(120_000)));
    await s.recordSettled(settled, "1220u");
    const live = await s.create(baseRec(future()));
    // Grace 60s: the unsettled expired row goes; the settled row survives a
    // 1h retention; the live row is untouched.
    const n = await s.sweep(new Date(), 60_000, 3_600_000);
    expect(n).toBe(1);
    expect(await s.get(dead)).toBeNull();
    expect(await s.get(settled)).not.toBeNull();
    expect(await s.get(live)).not.toBeNull();
  });

  it("livePayerCount counts only unsettled+unexpired rows of that payer", async () => {
    const s = createInMemoryTfStashStore();
    await s.create(baseRec(future()));
    await s.create(baseRec(future()));
    const settled = await s.create(baseRec(future()));
    await s.recordSettled(settled, "1220u");
    await s.create(baseRec(past())); // expired
    await s.create({ ...baseRec(future()), payer: "other::1220dddd" });
    expect(await s.livePayerCount(PAYER, new Date())).toBe(2);
  });

  it("bounds memory by evicting oldest beyond maxSize", async () => {
    const s = createInMemoryTfStashStore({ maxSize: 2 });
    const a = await s.create(baseRec(future()));
    const b = await s.create(baseRec(future()));
    const c = await s.create(baseRec(future()));
    expect(await s.get(a)).toBeNull();
    expect(await s.get(b)).not.toBeNull();
    expect(await s.get(c)).not.toBeNull();
  });
});

/** Minimal fake pg executor with just enough SQL routing for the store. */
function mockExec(): { exec: PgExecutor; rows: Map<string, Record<string, unknown>> } {
  const rows = new Map<string, Record<string, unknown>>();
  const exec: PgExecutor = {
    async query(sql: string, params: unknown[] = []) {
      if (sql.startsWith("CREATE") || sql.startsWith("ALTER"))
        return { rows: [], rowCount: 0 };
      if (sql.startsWith("INSERT INTO tf_stash")) {
        const [ref, payer, receiver, amount, admin, id, eb, hash, prep, memo] =
          params as string[];
        rows.set(ref, {
          ref,
          payer,
          receiver,
          amount,
          instrument_admin: admin,
          instrument_id: id,
          execute_before: eb,
          tx_hash: hash,
          prepared_tx: prep,
          memo: memo ?? null,
          signature: null,
          settled_update_id: null,
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE tf_stash SET signature")) {
        const [ref, sig] = params as string[];
        const row = rows.get(ref);
        if (
          row &&
          row.signature === null &&
          new Date(row.execute_before as string).getTime() > Date.now()
        ) {
          row.signature = sig;
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith("UPDATE tf_stash SET settled_update_id")) {
        const [ref, uid] = params as string[];
        const row = rows.get(ref);
        if (row && row.settled_update_id === null) {
          row.settled_update_id = uid;
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith("SELECT signature")) {
        const row = rows.get((params as string[])[0]);
        return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (sql.startsWith("SELECT ref")) {
        const row = rows.get((params as string[])[0]);
        return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (sql.startsWith("SELECT count")) {
        const [payer, nowIso] = params as string[];
        let n = 0;
        for (const row of rows.values()) {
          if (
            row.payer === payer &&
            row.settled_update_id === null &&
            new Date(row.execute_before as string).getTime() >
              new Date(nowIso).getTime()
          )
            n++;
        }
        return { rows: [{ n }], rowCount: 1 };
      }
      if (sql.startsWith("DELETE FROM tf_stash")) {
        const [unsettledCutoff, settledCutoff] = params as string[];
        let n = 0;
        for (const [ref, row] of rows) {
          const eb = new Date(row.execute_before as string).getTime();
          const gone =
            row.settled_update_id === null
              ? eb < new Date(unsettledCutoff).getTime()
              : eb < new Date(settledCutoff).getTime();
          if (gone) {
            rows.delete(ref);
            n++;
          }
        }
        return { rows: [], rowCount: n };
      }
      throw new Error(`unrouted sql: ${sql}`);
    },
  };
  return { exec, rows };
}

describe("PostgresTfStashStore (injected executor)", () => {
  async function roundTrip(s: TfStashStore): Promise<void> {
    const ref = await s.create(baseRec(future()));
    expect((await s.get(ref))!.payer).toBe(PAYER);
    expect(await s.attachSignature(ref, "c2ln")).toBe("ok");
    expect(await s.attachSignature(ref, "b3RoZXI=")).toBe("already_signed");
    expect(await s.recordSettled(ref, "1220u1")).toBe(true);
    expect(await s.recordSettled(ref, "1220u2")).toBe(false);
    expect((await s.get(ref))!.settledUpdateId).toBe("1220u1");
  }

  it("full lifecycle over SQL matches the in-memory semantics", async () => {
    const { exec } = mockExec();
    await roundTrip(createPostgresTfStashStore(exec));
  });

  it("memo round-trips through the INSERT/SELECT columns (omitted when unset)", async () => {
    const { exec } = mockExec();
    const s = createPostgresTfStashStore(exec);
    const withMemo = await s.create({ ...baseRec(future()), memo: "order-42" });
    expect((await s.get(withMemo))!.memo).toBe("order-42");
    const without = await s.create(baseRec(future()));
    expect((await s.get(without))!.memo).toBeUndefined();
  });

  it("expired row refuses a signature (guarded UPDATE)", async () => {
    const { exec } = mockExec();
    const s = createPostgresTfStashStore(exec);
    const ref = await s.create(baseRec(past()));
    expect(await s.attachSignature(ref, "c2ln")).toBe("expired");
  });

  it("sweep deletes by the two cutoffs", async () => {
    const { exec } = mockExec();
    const s = createPostgresTfStashStore(exec);
    const dead = await s.create(baseRec(past(120_000)));
    const settled = await s.create(baseRec(past(120_000)));
    await s.recordSettled(settled, "1220u");
    expect(await s.sweep(new Date(), 60_000, 3_600_000)).toBe(1);
    expect(await s.get(dead)).toBeNull();
    expect(await s.get(settled)).not.toBeNull();
  });

  it("livePayerCount excludes settled and expired rows", async () => {
    const { exec } = mockExec();
    const s = createPostgresTfStashStore(exec);
    await s.create(baseRec(future()));
    const settled = await s.create(baseRec(future()));
    await s.recordSettled(settled, "1220u");
    await s.create(baseRec(past()));
    expect(await s.livePayerCount(PAYER, new Date())).toBe(1);
  });
});

describe("createTfStashStore factory", () => {
  it("no dbUrl/executor → in-memory", async () => {
    const s = createTfStashStore({});
    const ref = await s.create(baseRec(future()));
    expect((await s.get(ref))!.ref).toBe(ref);
  });

  it("executor takes precedence", async () => {
    const { exec, rows } = mockExec();
    const s = createTfStashStore({ executor: exec, dbUrl: "postgres://x" });
    const ref = await s.create(baseRec(future()));
    expect(rows.has(ref)).toBe(true);
  });
});
