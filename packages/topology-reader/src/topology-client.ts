/**
 * Read an external party's protocol signing keys from Canton topology.
 *
 * WHY THIS EXISTS AS ITS OWN PROCESS. The keys live on the participant's ADMIN
 * gRPC API, which Canton ships unauthenticated and all-or-nothing: the same
 * port carries ParticipantRepairService (ExportAcs / ImportAcs). Handing that
 * port to the facilitator — a process that serves an unauthenticated /settle to
 * the internet — would make a facilitator compromise a node compromise. Canton
 * offers no per-method authorization, so the narrow boundary has to be built,
 * and this is it: one read, one method, no write service imported anywhere.
 *
 * WHERE THE KEY ACTUALLY LIVES, measured on MainNet rather than assumed:
 *   - ListNamespaceDelegation  -> EMPTY for an external party (both stores)
 *   - ListPartyToKeyMapping    -> EMPTY (and deprecated in the proto)
 *   - ListPartyToParticipant   -> the key, under `partySigningKeys.keys[]`
 *
 * The record reads from the BROADCAST synchronizer store, so it answers for
 * parties this participant does not host — verified against the DSO party,
 * which is hosted on Digital-Asset, Cumberland and SV-Nodeops participants and
 * still reads back in full.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

const PROTO_ROOT = fileURLToPath(new URL("../proto", import.meta.url));
const READ_SERVICE_PROTO =
  "com/digitalasset/canton/topology/admin/v30/topology_manager_read_service.proto";
const SERVICE_PATH =
  "com.digitalasset.canton.topology.admin.v30.TopologyManagerReadService";

/** The only key usage that can sign a protocol transaction. A key published
 *  solely for namespace or proof-of-ownership cannot, and returning it would
 *  invite a verifier to accept a signature that the ledger will not. */
const USAGE_PROTOCOL = "SIGNING_KEY_USAGE_PROTOCOL";
/** Ed25519. The only curve the inline carriage's signatures use. */
const SPEC_ED25519 = "SIGNING_KEY_SPEC_EC_CURVE25519";
/** Canton hands back a full X.509 SubjectPublicKeyInfo, which is exactly what
 *  node's createPublicKey({format:"der", type:"spki"}) consumes. Any other
 *  format would need a conversion we deliberately do not guess at. */
const FORMAT_DER_SPKI = "CRYPTO_KEY_FORMAT_DER_X509_SUBJECT_PUBLIC_KEY_INFO";

/**
 * A party id is `<hint>::<namespace fingerprint>`. Pinned because the topology
 * filter below is a PREFIX filter: a lax id here would silently widen the query.
 */
export const PARTY_RE = /^[A-Za-z0-9:_.\- ]{1,180}::[0-9a-f]{16,140}$/;

export interface PartySigningKey {
  /** X.509 SubjectPublicKeyInfo DER, base64 — verbatim from topology. */
  derBase64: string;
  usage: readonly string[];
  keySpec: string;
}

export interface TopologyReader {
  /** The party's protocol signing keys, or an empty array when topology knows
   *  the party but publishes no usable key. Throws when topology could not be
   *  read at all: "cannot tell" and "no keys" must never collapse together. */
  getPartySigningKeys(party: string): Promise<PartySigningKey[]>;
  close(): void;
}

export class TopologyReaderError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = "TopologyReaderError";
  }
}

interface StoreId {
  synchronizer?: { physicalId?: string; id?: string };
  authorized?: unknown;
}

/**
 * Pick the CURRENT synchronizer store.
 *
 * A participant that has lived through a logical synchronizer upgrade holds
 * several: this node carries both `…::34-0` and `…::35-5`, the pre- and
 * post-LSU stores. The suffix is `<protocolVersion>-<serial>`, and the current
 * one is the highest pair. Hard-coding it would strand the reader at the next
 * LSU, which is a scheduled, recurring event — so it is resolved, not pinned.
 */
export function selectCurrentStore(stores: readonly StoreId[]): string {
  let best: { id: string; pv: number; serial: number } | undefined;
  for (const s of stores) {
    const id = s.synchronizer?.physicalId;
    if (!id) continue;
    const m = /::(\d+)-(\d+)$/.exec(id);
    // A physical id without the suffix is not a shape we can rank; ranking it
    // by guesswork could silently select a retired store.
    if (!m) continue;
    const pv = Number(m[1]);
    const serial = Number(m[2]);
    if (!best || pv > best.pv || (pv === best.pv && serial > best.serial)) {
      best = { id, pv, serial };
    }
  }
  if (!best) {
    throw new TopologyReaderError(
      "no synchronizer store with a rankable physical id; refusing to guess"
    );
  }
  return best.id;
}

/**
 * Keep only what can actually verify an inline payment's signature.
 *
 * THE EXACT-PARTY CHECK IS LOAD-BEARING AND EASY TO MISS: Canton's
 * `filter_party` is a PREFIX filter. Asking for `agent::1220ab` returns every
 * party whose id starts with that, so a caller who shortened an id would be
 * handed a stranger's keys and would then happily verify a stranger's
 * signature. The requested party must equal the returned one exactly.
 */
export function extractKeys(
  results: readonly unknown[],
  requestedParty: string
): PartySigningKey[] {
  const out: PartySigningKey[] = [];
  for (const r of results) {
    const item = (r as { item?: Record<string, unknown> }).item;
    if (!item || item["party"] !== requestedParty) continue;
    const keys = (item["partySigningKeys"] as { keys?: unknown[] } | undefined)
      ?.keys;
    if (!Array.isArray(keys)) continue;
    for (const k of keys) {
      const key = k as {
        format?: string;
        publicKey?: string | Buffer;
        usage?: string[];
        keySpec?: string;
      };
      if (key.format !== FORMAT_DER_SPKI) continue;
      if (key.keySpec !== SPEC_ED25519) continue;
      if (!key.usage?.includes(USAGE_PROTOCOL)) continue;
      const der = key.publicKey;
      if (der === undefined) continue;
      out.push({
        derBase64: Buffer.isBuffer(der)
          ? der.toString("base64")
          : Buffer.from(der, "base64").toString("base64"),
        usage: [...key.usage],
        keySpec: key.keySpec,
      });
    }
  }
  return out;
}

export interface TopologyReaderOptions {
  /** host:port of the participant admin API (plaintext, node-local). */
  adminAddress: string;
  /** Per-call deadline. A topology read that hangs must not hold a request. */
  deadlineMs?: number;
  /** Cache TTL for the resolved store id. */
  storeTtlMs?: number;
}

export function createTopologyReader(
  opts: TopologyReaderOptions
): TopologyReader {
  const deadlineMs = opts.deadlineMs ?? 5_000;
  const storeTtlMs = opts.storeTtlMs ?? 300_000;

  const pkg = protoLoader.loadSync(READ_SERVICE_PROTO, {
    includeDirs: [PROTO_ROOT],
    keepCase: false,
    longs: String,
    enums: String,
    defaults: false,
    oneofs: true,
    // Canton's proto tree is vendored from the participant image we run; see
    // this package's README for how to refresh it.
    bytes: Buffer,
  });
  const loaded = grpc.loadPackageDefinition(pkg) as unknown as Record<
    string,
    unknown
  >;
  const ServiceCtor = SERVICE_PATH.split(".").reduce<unknown>(
    (acc, part) => (acc as Record<string, unknown>)?.[part],
    loaded
  ) as grpc.ServiceClientConstructor | undefined;
  if (typeof ServiceCtor !== "function") {
    throw new TopologyReaderError(
      `vendored protos do not define ${SERVICE_PATH}`
    );
  }

  const client = new ServiceCtor(
    opts.adminAddress,
    grpc.credentials.createInsecure(),
    {
      // A single party's record is a few hundred bytes. The cap is a backstop
      // against a query that somehow escapes the exact-party pin: an unfiltered
      // ListNamespaceDelegation on MainNet returns ~150 MB.
      "grpc.max_receive_message_length": 8 * 1024 * 1024,
    }
  );

  let cachedStore: { id: string; at: number } | undefined;

  const call = <T>(method: string, request: unknown): Promise<T> =>
    new Promise((resolve, reject) => {
      const fn = (client as unknown as Record<string, unknown>)[method];
      if (typeof fn !== "function") {
        reject(new TopologyReaderError(`admin API has no ${method}`));
        return;
      }
      (fn as (...a: unknown[]) => void).call(
        client,
        request,
        { deadline: Date.now() + deadlineMs },
        (err: unknown, res: T) => (err ? reject(err) : resolve(res))
      );
    });

  const currentStore = async (now: number): Promise<string> => {
    if (cachedStore && now - cachedStore.at < storeTtlMs) return cachedStore.id;
    const res = await call<{ storeIds?: StoreId[] }>("ListAvailableStores", {});
    const id = selectCurrentStore(res.storeIds ?? []);
    cachedStore = { id, at: now };
    return id;
  };

  return {
    async getPartySigningKeys(party: string): Promise<PartySigningKey[]> {
      if (!PARTY_RE.test(party)) {
        throw new TopologyReaderError(
          "party id is not a well-formed <hint>::<fingerprint>; refusing to " +
            "issue a prefix query"
        );
      }
      let store: string;
      try {
        store = await currentStore(Date.now());
      } catch (err) {
        throw new TopologyReaderError("could not resolve the topology store", err);
      }
      let res: { results?: unknown[] };
      try {
        res = await call<{ results?: unknown[] }>("ListPartyToParticipant", {
          baseQuery: {
            store: { synchronizer: { physicalId: store } },
            headState: {},
          },
          filterParty: party,
        });
      } catch (err) {
        // A failed read is NOT "this party has no keys". The caller fails
        // closed on the difference, so it must be able to see it.
        throw new TopologyReaderError("topology read failed", err);
      }
      return extractKeys(res.results ?? [], party);
    },
    close(): void {
      (client as unknown as { close?: () => void }).close?.();
    },
  };
}

/** Exported for the README's freshness check: which participant image the
 *  vendored protos came from. */
export function vendoredProtoSource(): string {
  try {
    return readFileSync(
      fileURLToPath(new URL("../proto/SOURCE", import.meta.url)),
      "utf8"
    ).trim();
  } catch {
    return "unknown";
  }
}
