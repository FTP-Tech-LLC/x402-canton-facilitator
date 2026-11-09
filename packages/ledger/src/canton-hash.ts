/**
 * canton-hash — the OFFICIAL Canton hash recompute, wired so the agent's
 * Ed25519 signature is cryptographically bound to the bytes it verified.
 *
 * WHY THIS EXISTS
 * ---------------
 * The agent's self-custody guarantee has two independent legs (see
 * verify-prepared.ts):
 *
 *   1. STRUCTURAL verify ("the bytes match my intent") — decode the relay's
 *      `PreparedTransaction` / topology bytes and pin receiver/amount/instrument
 *      (transfer) or own-key/own-namespace (onboarding) to caller intent.
 *   2. HASH recompute ("I signed the bytes I saw") — recompute the signing hash
 *      from those exact bytes EXACTLY as the Canton participant does on
 *      `execute`/`allocate`, compare it to the relay-returned hash, and sign the
 *      RECOMPUTED value. This defeats a relay that returns structurally-honest
 *      bytes paired with the hash of a DIFFERENT transaction (then forwards the
 *      different bytes to the participant).
 *
 * Leg 2 was missing — `hash-binding.ts` was fail-closed with no conformant
 * recompute. This module supplies it by delegating to the official, published,
 * Apache-2.0 `@canton-network/core-tx-visualizer` (the same code the rest of the
 * Canton wallet ecosystem signs with), so the bytes-exact V2 algorithm is the
 * library's problem, not a hand-reimplementation's. The conformance test
 * (`canton-hash.conformance.test.ts`) gates trusting it against live vectors.
 *
 * We deliberately do NOT use the SDK's `sign()` — it signs the relay-returned
 * hash directly with no recompute/compare, which would reproduce the blind-sign
 * bug. We use the library only for HASHING and keep our own compare-then-sign.
 */
import {
  decodePreparedTransaction,
  hashPreparedTransaction,
  computeSha256CantonHash,
  computeMultiHashForTopology,
} from "@canton-network/core-tx-visualizer";

/**
 * Node-graph limits applied before hashing. The same defaults as
 * `@canton-network/core-tx-hashing`: a root is at depth 1. MainNet payments and
 * swaps stay under 50 nodes and depth 5; a full merge batch stays under the
 * 256-node cap of the core decoder (see acs-limits.ts).
 */
export const MAX_HASHED_NODES = 10_000;
export const MAX_HASHED_NODE_DEPTH = 100;

/**
 * At most this many hashing steps in a transaction, by default.
 *
 * The hasher awaits for every string, every list or record element, every
 * part of a dotted name and every identifier, and blocks the event loop until
 * it is done, so its time follows that count: about 2 to 5 µs a step on one
 * core. Twelve names of 100,000 dots each (2.4 MB) took 3.5 s. Real
 * transactions in the fixtures take 66 to 8,238 steps (the largest is a 126 KB
 * Tradecraft funding with 397 identifiers), at most 75 per KB, and a transfer
 * adds about 200 per input holding. The default leaves room for any wallet transaction; a server
 * that hashes bytes from strangers passes its own lower budget.
 */
export const MAX_HASHED_STEPS = 100_000;

/**
 * How many object levels the decoded transaction may nest. The hasher copies
 * everything below each level of a value into the level above, so its time
 * grows with depth times size, and around 9,000 levels it runs out of stack.
 * Real transactions reach 45 levels; Daml's own limit of 100 value levels
 * comes to about 511 here, and this leaves twice that.
 */
export const MAX_HASHED_VALUE_DEPTH = 1_024;

/** Extra steps for an identifier: the hasher encodes its package id and both
 *  names with several awaits each, measured at about twice the cost of the
 *  three strings counted for it. */
const IDENTIFIER_STEPS = 4;

/** Seed lookups per step: the hasher scans every node seed for each node. */
const SEED_SCANS_PER_STEP = 600;

/** Node ids come from whoever built the bytes. Canton writes them as small
 *  integers; anything else is not echoed, since error text reaches callers that
 *  match on it. */
function idLabel(id: string): string {
  return /^\d{1,10}$/.test(id) ? id : `(a ${id.length}-character id)`;
}

/** The node graph of a prepared transaction is not a tree the hasher can walk. */
export class PreparedTransactionGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreparedTransactionGraphError";
  }
}

/** The transaction takes more hashing work than the caller's budget allows,
 *  in steps or in depth. A graph error too, so a caller that refuses those
 *  refuses this. */
export class PreparedTransactionBudgetError extends PreparedTransactionGraphError {
  constructor(message: string) {
    super(message);
    this.name = "PreparedTransactionBudgetError";
  }
}

type DecodedPrepared = ReturnType<typeof decodePreparedTransaction>;
type DecodedNode = NonNullable<DecodedPrepared["transaction"]>["nodes"][number];

function childIds(node: DecodedNode): readonly string[] {
  const versioned = node.versionedNode;
  if (versioned.oneofKind !== "v1") return [];
  const type = versioned.v1.nodeType;
  if (type.oneofKind === "exercise") return type.exercise.children;
  if (type.oneofKind === "rollback") return type.rollback.children;
  return [];
}

/**
 * The hasher recurses from the roots through every exercise and rollback child
 * with no visited set, so a node that is its own descendant never returns and a
 * node shared by two parents is hashed once per path. Require every referenced
 * node to exist once and be reached once, within the limits above. Iterative,
 * so the check itself cannot recurse.
 */
function assertHashableNodeGraph(prepared: DecodedPrepared): void {
  const tx = prepared.transaction;
  if (!tx) return;
  if (tx.nodes.length > MAX_HASHED_NODES) {
    throw new PreparedTransactionGraphError(
      `transaction has ${tx.nodes.length} nodes, the limit is ${MAX_HASHED_NODES}`
    );
  }
  // One seed per create or exercise node at most. The hasher looks each one
  // up by scanning the whole list, so extra seeds only cost.
  if (tx.nodeSeeds.length > tx.nodes.length) {
    throw new PreparedTransactionGraphError(
      `transaction has ${tx.nodeSeeds.length} node seeds for ${tx.nodes.length} nodes`
    );
  }
  const byId = new Map<string, DecodedNode>();
  for (const node of tx.nodes) {
    if (byId.has(node.nodeId)) {
      throw new PreparedTransactionGraphError(`node id ${idLabel(node.nodeId)} appears twice`);
    }
    byId.set(node.nodeId, node);
  }
  // In a tree every node is referenced once, as a root or as a child, so more
  // references than nodes means a node is reached twice.
  let references = tx.roots.length;
  if (references > byId.size) {
    throw new PreparedTransactionGraphError("more roots than nodes");
  }
  const reached = new Set<string>();
  const stack: Array<[string, number]> = tx.roots.map((id) => [id, 1]);
  while (stack.length > 0) {
    const [id, depth] = stack.pop() as [string, number];
    const node = byId.get(id);
    if (!node) {
      throw new PreparedTransactionGraphError(`node ${idLabel(id)} is referenced but missing`);
    }
    if (reached.has(id)) {
      throw new PreparedTransactionGraphError(
        `node ${idLabel(id)} is reached twice (a cycle or a shared child)`
      );
    }
    if (depth > MAX_HASHED_NODE_DEPTH) {
      throw new PreparedTransactionGraphError(
        `node ${idLabel(id)} is at depth ${depth}, the limit is ${MAX_HASHED_NODE_DEPTH}`
      );
    }
    reached.add(id);
    const children = childIds(node);
    references += children.length;
    if (references > byId.size) {
      throw new PreparedTransactionGraphError(
        "the transaction references more nodes than it has"
      );
    }
    for (const child of children) stack.push([child, depth + 1]);
  }
}

/**
 * Canton HashPurpose integers (4-byte big-endian domain-separation prefixes),
 * confirmed against canonical Canton
 * `community/base/.../crypto/HashPurpose.scala`. These are stable API: ids are
 * eagerly-initialized and never reused.
 */
export const HASH_PURPOSE = {
  /** Per onboarding/topology transaction hash. */
  TopologyTransactionSignature: 11,
  /** Derive a public-key fingerprint (party namespace) from raw key bytes. */
  PublicKeyFingerprint: 12,
  /** The combined multiHash over all topology transaction hashes. */
  MultiTopologyTransaction: 55,
} as const;

/**
 * Recompute the prepared-transaction signing hash (Canton
 * HASHING_SCHEME_VERSION_V2) from the EXACT base64 `preparedTransaction` the
 * relay returns from `POST /v1/wallet/submit/prepare`, returning it base64.
 *
 * This is hash (1): a Merkle hash over the Daml transaction node tree, returned
 * as the raw 32 bytes (NOT multihash-framed) base64-encoded — exactly what the
 * relay returns as `hash`. Compare base64-to-base64; sign the RECOMPUTED value.
 *
 * Async: `hashPreparedTransaction` uses WebCrypto (`crypto.subtle.digest`).
 *
 * The bytes are decoded once, the node graph and the hashing budget are
 * checked (`assertHashableNodeGraph`, `assertHashBudget`), and the same decoded
 * object is hashed, so the checks and the hash always see the same tree.
 */
export async function recomputeHash(
  preparedTransactionB64: string,
  opts: { maxSteps?: number } | null = {}
): Promise<string> {
  const prepared = decodePreparedTransaction(preparedTransactionB64);
  assertHashableNodeGraph(prepared);
  assertHashBudget(prepared, opts?.maxSteps ?? MAX_HASHED_STEPS);
  return hashPreparedTransaction(prepared, "base64");
}

/**
 * Refuse a transaction that takes more than `max` hashing steps
 * (`MAX_HASHED_STEPS`) or nests deeper than `MAX_HASHED_VALUE_DEPTH`. Counts
 * every string with its dots, every array element, every bytes field and
 * every identifier of the decoded transaction, and the seed scans, an upper
 * bound on what the hasher awaits. Iterative, with no awaits, and it stops at
 * the first step over the budget, so a refusal costs less than the budget.
 */
function assertHashBudget(prepared: DecodedPrepared, max: number): void {
  const tx = prepared.transaction;
  let steps = tx ? Math.ceil((tx.nodes.length * tx.nodeSeeds.length) / SEED_SCANS_PER_STEP) : 0;
  const over = () =>
    new PreparedTransactionBudgetError(
      `the transaction takes more than ${max} hashing steps (strings, list and record elements, parts of dotted names, identifiers)`
    );
  // Written so a budget that is not a number refuses rather than passes.
  if (!(steps <= max)) throw over();
  const stack: Array<[unknown, number]> = [[prepared, 0]];
  while (stack.length > 0) {
    const [value, depth] = stack.pop() as [unknown, number];
    if (typeof value === "string") {
      steps += 1;
      for (let at = value.indexOf("."); at !== -1 && steps <= max; at = value.indexOf(".", at + 1)) {
        steps += 1;
      }
    } else if (value instanceof Uint8Array) {
      steps += 1;
    } else if (value !== null && typeof value === "object") {
      if (depth >= MAX_HASHED_VALUE_DEPTH) {
        throw new PreparedTransactionBudgetError(
          `the transaction nests deeper than ${MAX_HASHED_VALUE_DEPTH} object levels`
        );
      }
      if (Array.isArray(value)) {
        steps += value.length;
        if (steps <= max) for (const item of value) stack.push([item, depth + 1]);
      } else {
        const fields = value as Record<string, unknown>;
        if (typeof fields.moduleName === "string" && typeof fields.entityName === "string") {
          steps += IDENTIFIER_STEPS;
        }
        for (const item of Object.values(fields)) stack.push([item, depth + 1]);
      }
    }
    if (!(steps <= max)) throw over();
  }
}

/**
 * Recompute the onboarding topology multiHash (hash (2)) from the array of
 * base64 `onboardingTransactions` the relay returns from
 * `POST /v1/wallet/onboard/prepare`, returning it base64 to compare against the
 * relay's `hashToSign`.
 *
 * Algorithm (spec A.3 / B.4), 4-line wrapper over the library primitives:
 *   h_i      = computeSha256CantonHash(11, raw_i)        // per-tx, 34B framed
 *   combined = computeMultiHashForTopology([h_0, h_1..])  // sorted-by-hex, framed
 *   multiHash= computeSha256CantonHash(55, combined)      // combined, 34B framed
 *
 * The per-tx hash is over the RAW topology-transaction bytes as delivered (the
 * hasher never decodes the proto), and `computeMultiHashForTopology` sorts the
 * per-tx hashes by lowercase-hex ascending before combining — so the ORDER of
 * `onboardingTransactions` does not matter. Both the per-tx hashes and the final
 * multiHash are multihash-framed (0x12 0x20 prefix, 34 bytes); we compare the
 * base64 verbatim and never strip the prefix.
 */
export async function recomputeTopologyMultiHash(
  onboardingTxB64: string[]
): Promise<string> {
  const raw = await Promise.all(
    onboardingTxB64.map((b64) =>
      computeSha256CantonHash(
        HASH_PURPOSE.TopologyTransactionSignature,
        bytesFromB64(b64)
      )
    )
  );
  const combined = await computeMultiHashForTopology(raw);
  const hash = await computeSha256CantonHash(
    HASH_PURPOSE.MultiTopologyTransaction,
    combined
  );
  return Buffer.from(hash).toString("base64");
}

/**
 * Derive a Canton public-key fingerprint from raw public-key bytes:
 * `hex( computeSha256CantonHash(12, publicKeyBytes) )` (spec B.5). The result is
 * the multihash-framed (0x12 0x20 + 32 = 34 bytes) hash rendered as lowercase
 * hex (68 chars) — the form Canton uses for the `publicKeyFingerprint` / party
 * namespace.
 *
 * NOTE on which key-byte form to pass: Canton's fingerprint preimage is a
 * specific serialization of the signing public key. Callers that need to match a
 * relay-returned `publicKeyFingerprint` should try both the SPKI/DER bytes and
 * the bare 32-byte Ed25519 point and keep the one that matches (see
 * `onboard.ts`); this function is a pure transform over whatever bytes it is
 * given, and the surrounding assert is fail-closed so a wrong guess refuses.
 */
export async function fingerprintHex(
  publicKeyBytes: Uint8Array
): Promise<string> {
  const framed = await computeSha256CantonHash(
    HASH_PURPOSE.PublicKeyFingerprint,
    publicKeyBytes
  );
  return Buffer.from(framed).toString("hex");
}

/** Decode a base64 string to bytes; throws on invalid base64-derived empties is
 *  left to the library's own digest (empty input still hashes). Kept tiny and
 *  dependency-free so the hash adapters stay pure. */
function bytesFromB64(b64: string): Uint8Array {
  return Buffer.from(b64, "base64");
}
