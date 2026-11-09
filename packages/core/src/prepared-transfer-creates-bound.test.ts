/**
 * What a transfer tree may create, and who signed its root.
 *
 * `TransferFactory_Transfer` is an interface choice whose controller is the
 * sender, so a root on a look-alike template runs its own code with the
 * sender's authority. Beside an honest delivery of the root amount it can
 * create a contract the sender signs, with a choice the merchant controls;
 * exercised later, that choice acts with the sender's authority. These are the
 * review's bytes (PR #279): the MainNet captures with such a create added, and
 * the USDCx capture also re-rooted on another package id.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  assertPreparedTransferMatches,
  decodePrepared,
  extractTransfer,
  PreparedTransferMismatchError,
  type PreparedTransferExpectation,
} from "./prepared-transfer.js";

const fx = (name: string): string =>
  readFileSync(new URL(`../../agent-wallet/src/__fixtures__/${name}`, import.meta.url), "utf8").trim();

/* ── a protobuf editor that keeps field order (enough to add or rewrite nodes) ── */
interface Field {
  field: number;
  wire: number;
  v?: bigint;
  bytes?: Buffer;
}
function readVarint(buf: Buffer, i: number): [bigint, number] {
  let x = 0n;
  let shift = 0n;
  let b: number;
  do {
    b = buf[i++]!;
    x |= BigInt(b & 0x7f) << shift;
    shift += 7n;
  } while (b & 0x80);
  return [x, i];
}
function parse(buf: Buffer): Field[] {
  const out: Field[] = [];
  let i = 0;
  while (i < buf.length) {
    let key: bigint;
    [key, i] = readVarint(buf, i);
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (wire === 0) {
      let v: bigint;
      [v, i] = readVarint(buf, i);
      out.push({ field, wire, v });
    } else if (wire === 1 || wire === 5) {
      const n = wire === 1 ? 8 : 4;
      out.push({ field, wire, bytes: buf.subarray(i, i + n) });
      i += n;
    } else if (wire === 2) {
      let n: bigint;
      [n, i] = readVarint(buf, i);
      out.push({ field, wire, bytes: buf.subarray(i, i + Number(n)) });
      i += Number(n);
    } else throw new Error(`wire ${wire}`);
  }
  return out;
}
function varint(x: bigint): Buffer {
  const b: number[] = [];
  do {
    let c = Number(x & 0x7fn);
    x >>= 7n;
    if (x) c |= 0x80;
    b.push(c);
  } while (x);
  return Buffer.from(b);
}
function encode(fields: Field[]): Buffer {
  return Buffer.concat(
    fields.map((f) => {
      const key = varint((BigInt(f.field) << 3n) | BigInt(f.wire));
      if (f.wire === 0) return Buffer.concat([key, varint(f.v!)]);
      if (f.wire === 1 || f.wire === 5) return Buffer.concat([key, f.bytes!]);
      return Buffer.concat([key, varint(BigInt(f.bytes!.length)), f.bytes!]);
    })
  );
}
const len = (field: number, bytes: Buffer): Field => ({ field, wire: 2, bytes });
const str = (field: number, s: string): Field => len(field, Buffer.from(s, "utf8"));
const utf8 = (f: Field | undefined): string => Buffer.from(f?.bytes ?? []).toString("utf8");
const vParty = (p: string): Buffer => encode([str(7, p)]);
const vRecord = (entries: Array<{ label: string; value: Buffer }>): Buffer =>
  encode([len(14, encode(entries.map((e) => len(2, encode([str(1, e.label), len(2, e.value)])))))]);

/** The captured tree with one more create, a child of the root (review's attack-create). */
function withChildCreate(b64: string, template: string, signatories: string[], stakeholders: string[]): string {
  const top = parse(Buffer.from(b64, "base64"));
  const txI = top.findIndex((f) => f.field === 1);
  const tx = parse(top[txI]!.bytes!);
  const rootId = utf8(tx.find((f) => f.field === 2));
  const newId = "9999";
  for (const f of tx) {
    if (f.field !== 3) continue;
    const node = parse(f.bytes!);
    if (utf8(node.find((x) => x.field === 1)) !== rootId) continue;
    const v1I = node.findIndex((x) => x.field === 1000);
    const v1 = parse(node[v1I]!.bytes!);
    const exI = v1.findIndex((x) => x.field === 3);
    const ex = parse(v1[exI]!.bytes!);
    let last = -1;
    ex.forEach((x, i) => {
      if (x.field === 12) last = i;
    });
    ex.splice(last + 1, 0, str(12, newId));
    v1[exI] = len(3, encode(ex));
    node[v1I] = len(1000, encode(v1));
    f.bytes = encode(node);
  }
  const [mod, ent] = template.split(":");
  const create = encode([
    str(1, "2.1"),
    str(2, "00" + "ab".repeat(33)),
    str(3, "attacker-package"),
    len(4, encode([str(1, "cd".repeat(32)), str(2, mod!), str(3, ent!)])),
    len(5, vRecord([{ label: "owner", value: vParty(signatories[0]!) }])),
    ...signatories.map((s) => str(6, s)),
    ...stakeholders.map((s) => str(7, s)),
  ]);
  tx.push(len(3, encode([str(1, newId), len(1000, encode([len(1, create)]))])));
  top[txI] = len(1, encode(tx));
  return encode(top).toString("base64");
}

/** The root's input contract (Metadata.input_contracts) re-signed by `signatories`. */
function withRootSignatories(b64: string, signatories: string[] | null): string {
  const top = parse(Buffer.from(b64, "base64"));
  const d = decodePrepared(b64);
  const rootCid = d.exercises.find((e) => e.choiceId === "TransferFactory_Transfer")!.contractId!;
  const mdI = top.findIndex((f) => f.field === 2);
  const md = parse(top[mdI]!.bytes!);
  const out: Field[] = [];
  for (const f of md) {
    if (f.field !== 7) {
      out.push(f);
      continue;
    }
    const ic = parse(f.bytes!);
    const cI = ic.findIndex((x) => x.field === 1);
    const c = parse(ic[cI]!.bytes!);
    if (utf8(c.find((x) => x.field === 2)) !== rootCid) {
      out.push(f);
      continue;
    }
    if (signatories === null) continue; // drop it
    const kept = c.filter((x) => x.field !== 6);
    const at = kept.findIndex((x) => x.field === 7);
    kept.splice(at < 0 ? kept.length : at, 0, ...signatories.map((s) => str(6, s)));
    ic[cI] = len(1, encode(kept));
    out.push(len(7, encode(ic)));
  }
  top[mdI] = len(2, encode(out));
  return encode(top).toString("base64");
}

/** Re-point the root exercise (and its input contract) at another package id. */
function withLookalikeRoot(b64: string): string {
  const top = parse(Buffer.from(b64, "base64"));
  const swap = (idBytes: Buffer): Buffer => {
    const id = parse(idBytes);
    const i = id.findIndex((x) => x.field === 1);
    id[i] = str(1, "ee".repeat(32));
    return encode(id);
  };
  const txI = top.findIndex((f) => f.field === 1);
  const tx = parse(top[txI]!.bytes!);
  const rootId = utf8(tx.find((f) => f.field === 2));
  let rootCid = "";
  for (const f of tx) {
    if (f.field !== 3) continue;
    const node = parse(f.bytes!);
    if (utf8(node.find((x) => x.field === 1)) !== rootId) continue;
    const v1I = node.findIndex((x) => x.field === 1000);
    const v1 = parse(node[v1I]!.bytes!);
    const exI = v1.findIndex((x) => x.field === 3);
    const ex = parse(v1[exI]!.bytes!);
    rootCid = utf8(ex.find((x) => x.field === 2));
    const tI = ex.findIndex((x) => x.field === 4);
    ex[tI] = len(4, swap(ex[tI]!.bytes!));
    v1[exI] = len(3, encode(ex));
    node[v1I] = len(1000, encode(v1));
    f.bytes = encode(node);
  }
  top[txI] = len(1, encode(tx));
  const mdI = top.findIndex((f) => f.field === 2);
  const md = parse(top[mdI]!.bytes!);
  for (let i = 0; i < md.length; i++) {
    if (md[i]!.field !== 7) continue;
    const ic = parse(md[i]!.bytes!);
    const cI = ic.findIndex((x) => x.field === 1);
    const c = parse(ic[cI]!.bytes!);
    if (utf8(c.find((x) => x.field === 2)) !== rootCid) continue;
    const tI = c.findIndex((x) => x.field === 4);
    c[tI] = len(4, swap(c[tI]!.bytes!));
    ic[cI] = len(1, encode(c));
    md[i] = len(7, encode(ic));
  }
  top[mdI] = len(2, encode(md));
  return encode(top).toString("base64");
}

/** A structured Identifier "Module:Entity" on another package. */
const templateId = (field: number, qualified: string): Field => {
  const [mod, ent] = qualified.split(":");
  return len(field, encode([str(1, "cd".repeat(32)), str(2, mod!), str(3, ent!)]));
};

/** A v1 Exercise node body (exercise = 3), e.g. an Archive. */
function exerciseBody(o: { cid: string; template: string; choice: string; signatories: string[] }): Field {
  return len(
    3,
    encode([
      str(1, "2.1"),
      str(2, o.cid),
      str(3, "some-package"),
      templateId(4, o.template),
      ...o.signatories.map((p) => str(5, p)),
      ...o.signatories.map((p) => str(6, p)),
      ...o.signatories.map((p) => str(7, p)),
      str(9, o.choice),
      len(10, vRecord([])),
      { field: 11, wire: 0, v: 1n },
    ])
  );
}

/** A v1 Create node body (create = 1) with a given contract id. */
function createBody(o: { cid: string; template: string; signatories: string[] }): Field {
  return len(
    1,
    encode([
      str(1, "2.1"),
      str(2, o.cid),
      str(3, "some-package"),
      templateId(4, o.template),
      len(5, vRecord([{ label: "owner", value: vParty(o.signatories[0]!) }])),
      ...o.signatories.map((p) => str(6, p)),
      ...o.signatories.map((p) => str(7, p)),
    ])
  );
}

/** The captured tree with `bodies` appended as children of the root, in order. */
function withRootChildren(b64: string, bodies: Field[]): string {
  const top = parse(Buffer.from(b64, "base64"));
  const txI = top.findIndex((f) => f.field === 1);
  const tx = parse(top[txI]!.bytes!);
  const rootId = utf8(tx.find((f) => f.field === 2));
  const ids = bodies.map((_, i) => `99${i}`);
  for (const f of tx) {
    if (f.field !== 3) continue;
    const node = parse(f.bytes!);
    if (utf8(node.find((x) => x.field === 1)) !== rootId) continue;
    const v1I = node.findIndex((x) => x.field === 1000);
    const v1 = parse(node[v1I]!.bytes!);
    const exI = v1.findIndex((x) => x.field === 3);
    const ex = parse(v1[exI]!.bytes!);
    let last = -1;
    ex.forEach((x, i) => {
      if (x.field === 12) last = i;
    });
    ex.splice(last + 1, 0, ...ids.map((id) => str(12, id)));
    v1[exI] = len(3, encode(ex));
    node[v1I] = len(1000, encode(v1));
    f.bytes = encode(node);
  }
  bodies.forEach((body, i) => tx.push(len(3, encode([str(1, ids[i]!), len(1000, encode([body]))]))));
  top[txI] = len(1, encode(tx));
  return encode(top).toString("base64");
}

/** The captured tree with one more Metadata.input_contracts entry. */
function withInputContract(b64: string, o: { cid: string; template: string; signatories: string[] }): string {
  const top = parse(Buffer.from(b64, "base64"));
  const mdI = top.findIndex((f) => f.field === 2);
  const md = parse(top[mdI]!.bytes!);
  const created = createBody(o).bytes!;
  md.push(len(7, encode([len(1, created), { field: 1000, wire: 0, v: 1n }])));
  top[mdI] = len(2, encode(md));
  return encode(top).toString("base64");
}

/* ── the captures and the expectations they are paid or sent with ── */
const OPERATOR =
  "auth0_007c6643538f2eadd3e573dd05b9::12205bcc106efa0eaa7f18dc491e5c6f5fb9b0cc68dc110ae66f4ed6467475d7c78e";
const BRIDGE = "Bridge-Operator::1220c8448890a70e65f6906bd48d797ee6551f094e9e6a53e329fd5b2b549334f13f";
const AMULET_FACTORY = "Splice.ExternalPartyAmuletRules:ExternalPartyAmuletRules";
const REGISTRY_FACTORIES = [
  "Utility.Registry.App.V0.Model.TransferPreapproval:TransferPreapproval",
  "Utility.Registry.App.V0.Service.AllocationFactory:AllocationFactory",
];

const DSO = "DSO::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc";

/** The wallet's expectation for a capture, read off the capture itself. The
 *  wallet knows the network's DSO out of band; a registry admin is not it. */
function expectationFor(b64: string): PreparedTransferExpectation {
  const d = decodePrepared(b64);
  const root = d.exercises.find((e) => e.choiceId === "TransferFactory_Transfer")!;
  const t = extractTransfer(root.chosenValue);
  const registry = t.instrumentId !== "Amulet";
  return {
    sender: t.sender,
    receiver: t.receiver,
    amount: t.amount,
    instrumentId: t.instrumentId,
    instrumentAdmin: t.instrumentAdmin,
    templateQualifiedName: registry ? REGISTRY_FACTORIES : AMULET_FACTORY,
    ...(registry ? { trustedRegistryParties: new Set([OPERATOR, BRIDGE]) } : {}),
    // The two-step offer to a pool is a swap's shape, opted in by the caller.
    ...(registry && t.receiver.startsWith("tc-swp_") ? { allowRegistryOffer: true } : {}),
    dsoParty: DSO,
    nowMs: Number(d.preparationTime! / 1000n) + 1000,
  };
}

const CAPTURES = [
  "mainnet-transfer-preapproval-0.1.21.b64",
  "mainnet-preapproval-distinct-provider.b64",
  "mainnet-preapproval-self-provider.b64",
  "mainnet-usdcx-transfer-preapproval.b64",
  "mainnet-cbtc-registry-offer-to-pool.b64",
  "mainnet-cbtc-registry-offer-beneficiary2.b64",
  "mainnet-usdcx-registry-self-merge.b64",
  "mainnet-usdcx-registry-self-merge-full.b64",
];

describe("every captured transfer still passes", () => {
  it.each(CAPTURES)("%s", (name) => {
    const b64 = fx(name);
    expect(() => assertPreparedTransferMatches(b64, expectationFor(b64))).not.toThrow();
  });
});

describe("a create the sender signs must be co-signed by the instrument admin", () => {
  const ATTACK = "Attack.Proxy:Proxy";

  it("was already refused in the offer shape, whose creates are pinned to Holding and TransferOffer", () => {
    const b64 = fx("mainnet-cbtc-registry-offer-to-pool.b64");
    const e = expectationFor(b64);
    expect(() => assertPreparedTransferMatches(withChildCreate(b64, ATTACK, [e.sender], [e.sender]), e)).toThrow(
      /registry transfer creates "Attack\.Proxy:Proxy"/
    );
  });

  it.each([
    "mainnet-transfer-preapproval-0.1.21.b64",
    "mainnet-preapproval-self-provider.b64",
    "mainnet-usdcx-transfer-preapproval.b64",
  ])("refuses a create signed by the sender alone beside the delivery (%s)", (name) => {
    const b64 = fx(name);
    const e = expectationFor(b64);
    const attack = withChildCreate(b64, ATTACK, [e.sender], [e.sender, e.receiver]);
    expect(decodePrepared(attack).nodes.some((n) => n.create?.templateQualifiedName === ATTACK)).toBe(true);
    expect(() => assertPreparedTransferMatches(attack, e)).toThrow(PreparedTransferMismatchError);
    expect(() => assertPreparedTransferMatches(attack, e)).toThrow(/signed by the sender/);
  });

  it("refuses one co-signed by the merchant: only the issuer's signature is out of a look-alike's reach", () => {
    const b64 = fx("mainnet-transfer-preapproval-0.1.21.b64");
    const e = expectationFor(b64);
    const attack = withChildCreate(b64, ATTACK, [e.sender, e.receiver], [e.sender, e.receiver]);
    expect(() => assertPreparedTransferMatches(attack, e)).toThrow(/signed by the sender/);
  });

  it("refuses it under a look-alike USDCx root on another package id", () => {
    const b64 = fx("mainnet-usdcx-transfer-preapproval.b64");
    const e = expectationFor(b64);
    const lookalike = withLookalikeRoot(b64);
    // The look-alike root alone still passes: its signatory is the receiver,
    // as the registry's own preapproval is.
    expect(() => assertPreparedTransferMatches(lookalike, e)).not.toThrow();
    const attack = withChildCreate(lookalike, ATTACK, [e.sender], [e.sender, e.receiver]);
    expect(() => assertPreparedTransferMatches(attack, e)).toThrow(/signed by the sender/);
  });
});

describe("a Canton Coin root is the DSO's own contract", () => {
  const b64 = fx("mainnet-transfer-preapproval-0.1.21.b64");
  const e = expectationFor(b64);

  it("refuses a root contract the merchant signed", () => {
    expect(() => assertPreparedTransferMatches(withRootSignatories(b64, [e.receiver]), e)).toThrow(
      /not by the DSO alone/
    );
  });

  it("refuses one the DSO signed together with someone else", () => {
    expect(() =>
      assertPreparedTransferMatches(withRootSignatories(b64, [e.instrumentAdmin!, e.receiver]), e)
    ).toThrow(/not by the DSO alone/);
  });

  it("refuses a root contract missing from the input contracts", () => {
    expect(() => assertPreparedTransferMatches(withRootSignatories(b64, null), e)).toThrow(
      /not by the DSO alone/
    );
  });

  it("keeps the DSO-signed root as captured", () => {
    expect(() => assertPreparedTransferMatches(withRootSignatories(b64, [e.instrumentAdmin!]), e)).not.toThrow();
  });
});

describe("what a transfer tree may archive", () => {
  const OTHER = "00" + "fe".repeat(33);
  const NEW = "00" + "dd".repeat(33);
  const REGISTRY_PREAPPROVAL = "Utility.Registry.App.V0.Model.TransferPreapproval:TransferPreapproval";

  it("refuses an Archive of the agent's own registry TransferPreapproval under a look-alike USDCx root", () => {
    const b64 = fx("mainnet-usdcx-transfer-preapproval.b64");
    const e = expectationFor(b64);
    // A registry TransferPreapproval is signed by its receiver alone: here the agent.
    const attack = withRootChildren(withLookalikeRoot(b64), [
      exerciseBody({ cid: OTHER, template: REGISTRY_PREAPPROVAL, choice: "Archive", signatories: [e.sender] }),
    ]);
    expect(() => assertPreparedTransferMatches(attack, e)).toThrow(/archives/);
  });

  it("refuses it when the relay also lists that contract among the inputs", () => {
    const b64 = fx("mainnet-usdcx-transfer-preapproval.b64");
    const e = expectationFor(b64);
    const declared = withInputContract(withLookalikeRoot(b64), {
      cid: OTHER,
      template: REGISTRY_PREAPPROVAL,
      signatories: [e.sender],
    });
    const attack = withRootChildren(declared, [
      exerciseBody({ cid: OTHER, template: REGISTRY_PREAPPROVAL, choice: "Archive", signatories: [e.sender] }),
    ]);
    expect(() => assertPreparedTransferMatches(attack, e)).toThrow(/archives/);
  });

  it("refuses an Archive of a sender-signed contract beside the captured Canton Coin payment", () => {
    const b64 = fx("mainnet-transfer-preapproval-0.1.21.b64");
    const e = expectationFor(b64);
    const attack = withRootChildren(b64, [
      exerciseBody({ cid: OTHER, template: "Attack.Proxy:Proxy", choice: "Archive", signatories: [e.sender] }),
    ]);
    expect(() => assertPreparedTransferMatches(attack, e)).toThrow(/archives/);
  });

  it("admits a transient: a contract created earlier in the same transaction", () => {
    const b64 = fx("mainnet-transfer-preapproval-0.1.21.b64");
    const e = expectationFor(b64);
    const transient = withRootChildren(b64, [
      createBody({ cid: NEW, template: "Splice.Amulet:FeaturedAppActivityMarker", signatories: [DSO] }),
      exerciseBody({ cid: NEW, template: "Splice.Amulet:FeaturedAppActivityMarker", choice: "Archive", signatories: [DSO] }),
    ]);
    expect(() => assertPreparedTransferMatches(transient, e)).not.toThrow();
  });

  it("refuses the same pair in the other order: nothing can be archived before it exists", () => {
    const b64 = fx("mainnet-transfer-preapproval-0.1.21.b64");
    const e = expectationFor(b64);
    const reversed = withRootChildren(b64, [
      exerciseBody({ cid: NEW, template: "Splice.Amulet:FeaturedAppActivityMarker", choice: "Archive", signatories: [DSO] }),
      createBody({ cid: NEW, template: "Splice.Amulet:FeaturedAppActivityMarker", signatories: [DSO] }),
    ]);
    expect(() => assertPreparedTransferMatches(reversed, e)).toThrow(/archives/);
  });
});

describe("Canton Coin is told by the trusted DSO, not by the instrument id", () => {
  it("does not hold a registry root to the DSO pin when the admin is not the DSO", () => {
    const b64 = fx("mainnet-usdcx-transfer-preapproval.b64");
    expect(expectationFor(b64).instrumentAdmin).not.toBe(DSO);
    expect(() => assertPreparedTransferMatches(b64, expectationFor(b64))).not.toThrow();
  });

  it("holds a registry admin to it when the caller names that admin as the DSO", () => {
    // The receiver alone signs a registry TransferPreapproval, so the pin refuses.
    const b64 = fx("mainnet-usdcx-transfer-preapproval.b64");
    const e = expectationFor(b64);
    expect(() => assertPreparedTransferMatches(b64, { ...e, dsoParty: e.instrumentAdmin! })).toThrow(
      /not by the DSO alone/
    );
  });
});
