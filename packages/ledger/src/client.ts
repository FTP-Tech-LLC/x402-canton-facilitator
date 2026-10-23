/**
 * Low-level JSON Ledger API v2 client for Canton.
 *
 * Encodes the gotchas from canton-learning-resources directly so callers
 * don't have to remember them:
 *   - Template IDs use the `#package-name:Module:Entity` format (leading
 *     `#` mandatory; without it, the parser reads the first segment as a
 *     literal package-id hash).
 *   - POST /v2/commands/submit-and-wait-for-transaction expects a wrapped
 *     body: `{commands: {commandId, userId, actAs, commands, ...}}`.
 *   - POST /v2/commands/submit-and-wait expects a FLAT body.
 *   - Discriminators are wrapping keys, not `kind` fields:
 *     `{"CreateCommand": {...}}`, not `{"kind": "CreateCommand", ...}`.
 *   - Daml `Int` is encoded as a JSON STRING (`"50"`). Pass through; do
 *     not parse to number (precision loss above 2^53).
 *   - `disclosedContracts` is required for any choice exercise on a
 *     DSO-signed contract (AmuletRules, OpenMiningRound). Each entry
 *     carries `created_event_blob` from the Scan API.
 *
 * All methods throw `CantonError` on transport failure or non-2xx
 * response. The error preserves the HTTP status code so callers can
 * distinguish client errors (4xx) from server errors (5xx).
 */

/**
 * Resolves a bearer token on each ledger call. Returned by
 * `createOidcTokenProvider` (facilitator/auth/token.ts) — caches the
 * Auth0 / Keycloak access_token and only re-fetches when it's
 * within `refreshSkewMs` of expiry. Plain `string` is accepted too
 * for LocalNet (cn-quickstart unsafe-hmac JWTs never expire).
 */
export type TokenProvider = () => Promise<string>;

export interface CantonClientOptions {
  participantUrl: string;
  /** Static bearer for LocalNet, or a resolver for OIDC (DevNet / MainNet). */
  token: string | TokenProvider;
  packageName: string;
  /** Request timeout. Defaults to 10s. */
  timeoutMs?: number;
  /** Override the fetch implementation. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
}

export type CreateCommand = {
  CreateCommand: {
    templateId: string;
    createArguments: Record<string, unknown>;
  };
};

export type ExerciseCommand = {
  ExerciseCommand: {
    templateId: string;
    contractId: string;
    choice: string;
    choiceArgument: Record<string, unknown>;
  };
};

export type JsCommand = CreateCommand | ExerciseCommand;

export interface DisclosedContract {
  templateId: string;
  contractId: string;
  createdEventBlob: string;
  synchronizerId: string;
}

/** `Commands.deduplication_period` in the JSON Ledger API v2 encoding. Absent
 *  means `Empty`, which the participant resolves to its configured maximum
 *  deduplication DURATION; an offset is the only form whose window does not
 *  depend on participant configuration or clocks. */
export type JsDeduplicationPeriod =
  | { DeduplicationOffset: { value: number } }
  | { DeduplicationDuration: { value: { seconds: number; nanos: number } } };

export interface JsCommandsBody {
  commandId: string;
  userId: string;
  actAs: string[];
  readAs?: string[];
  synchronizerId?: string;
  disclosedContracts?: DisclosedContract[];
  /** Identifies this attempt on its completion. Fresh per attempt; the
   *  commandId is what stays the same across retries. */
  submissionId?: string;
  deduplicationPeriod?: JsDeduplicationPeriod;
  commands: JsCommand[];
}

export interface CreatedEvent {
  contractId: string;
  templateId: string;
  createArgument: Record<string, unknown>;
  signatories: string[];
  observers: string[];
  packageName: string;
  /** The contract's created_event_blob — populated ONLY when the query/filter
   *  set includeCreatedEventBlob:true (absent otherwise). Needed to DISCLOSE a
   *  contract on a later submission (e.g. the v1 settle discloses the payer's own
   *  input amulets, which a facilitator-submitted Send cannot otherwise see). */
  createdEventBlob?: string;
  /** CIP-56 interface views — populated when the token implements
   *  standardized interfaces (e.g. HoldingV1). Optional in the API
   *  response; absent for non-standard tokens like TestToken. */
  interfaceViews?: Array<{
    interfaceId: string;
    viewValue: Record<string, unknown>;
  }>;
}

export interface TransactionResult {
  updateId: string;
  offset: number;
  /** Flat CreatedEvent list (ArchivedEvent and ExercisedEvent filtered out). */
  events: CreatedEvent[];
}

export interface InteractivePrepareBody {
  userId: string;
  commandId: string;
  actAs: string[];
  readAs?: string[];
  synchronizerId: string;
  /** When true, the participant returns a human-readable rendering
   *  of the hash for client-side cross-checking. Defaults to false. */
  verboseHashing?: boolean;
  packageIdSelectionPreference?: string[];
  commands: JsCommand[];
  disclosedContracts?: DisclosedContract[];
}

export interface PreparedSubmission {
  /** Base64-encoded `PreparedTransaction` protobuf. Opaque to the
   *  client — pass through to executeSubmission verbatim. */
  preparedTransaction: string;
  /** Base64-encoded SHA-256 hash of the prepared transaction. The
   *  external party signs THIS bytes value. */
  preparedTransactionHash: string;
}

/** One signature entry inside `partySignatures[].signatures[]`. */
export interface PartySignatureEntry {
  format: "SIGNATURE_FORMAT_CONCAT";
  /** Base64-encoded raw signature bytes. */
  signature: string;
  /** E.g. `"SIGNING_ALGORITHM_SPEC_ED25519"` or
   *  `"SIGNING_ALGORITHM_SPEC_EC_DSA_SHA_256"`. The string is opaque
   *  to this client and forwarded verbatim. */
  signingAlgorithmSpec: string;
  /** Public-key fingerprint identifying which key produced the
   *  signature. Format defined by the Canton topology. */
  signedBy: string;
}

export interface InteractiveExecuteBody {
  /** Unique id for the execution; the ledger REQUIRES it at runtime. */
  submissionId?: string;
  preparedTransaction: string;
  hashingSchemeVersion:
    | "HASHING_SCHEME_VERSION_V1"
    | "HASHING_SCHEME_VERSION_V2";
  partySignatures: {
    signatures: Array<{
      party: string;
      signatures: PartySignatureEntry[];
    }>;
  };
  deduplicationPeriod?:
    | { Empty: Record<string, never> }
    | { DeduplicationDuration: { duration: string } };
}

export interface InteractiveExecuteResult {
  updateId: string;
  completionOffset: number;
}

export interface ActiveContractsFilter {
  filtersByParty: Record<
    string,
    {
      cumulative: Array<{
        identifierFilter?: {
          WildcardFilter?: {
            value: { includeCreatedEventBlob: boolean };
          };
          TemplateFilter?: {
            value: { templateId: string; includeCreatedEventBlob: boolean };
          };
          InterfaceFilter?: {
            value: {
              interfaceId: string;
              includeInterfaceView: boolean;
              includeCreatedEventBlob: boolean;
            };
          };
        };
      }>;
    }
  >;
}

/**
 * The Canton error id (`DUPLICATE_COMMAND`, `SUBMISSION_ALREADY_IN_FLIGHT`, …)
 * carried by a failed JSON Ledger API call, or undefined.
 *
 * The HTTP status alone cannot tell these apart: the JSON API maps both gRPC
 * ABORTED and ALREADY_EXISTS to 409 (canton `GrpcHttpErrorCodes`), so "already
 * committed", "still in flight" and "rejected by the mediator" all arrive as
 * 409. The id in the body is the only discriminator.
 */
export function cantonErrorId(err: unknown): string | undefined {
  const body = (err as { responseBody?: unknown })?.responseBody;
  if (typeof body !== "string" || body === "") return undefined;
  try {
    const code = (JSON.parse(body) as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]+$/.test(code)) return code;
  } catch {
    // not JSON — fall through to the textual form
  }
  // A JSON body cut short by our own 1 KiB cap: `code` is its first field, so
  // it survives the cut even when the whole body no longer parses.
  const cut = /"code"\s*:\s*"([A-Z][A-Z0-9_]+)"/.exec(body)?.[1];
  if (cut) return cut;
  // gRPC-style text: "DUPLICATE_COMMAND(10,abc123): ..."
  return /\b([A-Z][A-Z0-9_]{3,})\(\d+,/.exec(body)?.[1];
}

/** One completion for a commandId (see findCommandCompletions). */
export interface CommandCompletion {
  submissionId?: string;
  updateId?: string;
  offset?: number;
  /** Absent when the submission was accepted. */
  rejection?: string;
}

/**
 * The top-level elements of a JSON array that arrived WHOLE, as raw strings.
 * A stream cut mid-element (or mid-string) simply ends the list there.
 */
export function completeArrayElements(text: string): string[] {
  const out: string[] = [];
  let i = text.indexOf("[");
  if (i < 0) return out;
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (i = i + 1; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      if (depth === 0 && start < 0) start = i;
    } else if (ch === "{" || ch === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" || ch === "]") {
      if (depth === 0) break; // the array's own closing bracket
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

export class CantonError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status?: number,
    public readonly responseBody?: string
  ) {
    super(message);
    this.name = "CantonError";
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** The participant's list cap, read from its refusal: "The number of matching
 *  elements (201) is greater than the node limit (200)." Undefined when the
 *  body does not say. */
function nodeListLimit(responseBody: string | undefined): number | undefined {
  const m = /node limit \((\d+)\)/.exec(responseBody ?? "");
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export class CantonClient {
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  /** The participant's list cap, once a refusal has named it (see
   *  queryActiveContractsSlice). Later slices start at it instead of being
   *  refused again. */
  private nodeListCap: number | undefined;

  constructor(private readonly opts: CantonClientOptions) {
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Build a canonical template reference: `#package:Module:Entity`.
   * The leading `#` is mandatory in Canton 3.4+.
   */
  templateRef(module: string, entity: string): string {
    return `#${this.opts.packageName}:${module}:${entity}`;
  }

  /**
   * POST /v2/commands/submit-and-wait-for-transaction
   *
   * Wrapped body shape: `{commands: {...flat}}`. Returns the resulting
   * transaction with `updateId`, `offset`, and a flat array of
   * `CreatedEvent`s (Archived/Exercised events are filtered out).
   */
  async submitAndWaitForTransaction(
    commands: JsCommandsBody
  ): Promise<TransactionResult> {
    const response = await this.post<{
      transaction?: {
        updateId?: string;
        offset?: number;
        events?: Array<
          | { CreatedEvent?: CreatedEvent }
          | { ArchivedEvent?: unknown }
          | { ExercisedEvent?: unknown }
        >;
      };
    }>("/v2/commands/submit-and-wait-for-transaction", { commands });

    const tx = response.transaction;
    if (!tx?.updateId) {
      throw new CantonError(
        "submit-and-wait-for-transaction returned no updateId",
        "INVALID_RESPONSE"
      );
    }
    const events: CreatedEvent[] = [];
    for (const e of tx.events ?? []) {
      if ("CreatedEvent" in e && e.CreatedEvent) {
        events.push(e.CreatedEvent);
      }
    }
    return { updateId: tx.updateId, offset: tx.offset ?? 0, events };
  }

  /**
   * POST /v2/commands/submit-and-wait
   *
   * Flat body shape: `{commandId, userId, actAs, commands, ...}`.
   * Returns `updateId` + `completionOffset`. No transaction details
   * available from this endpoint — use submitAndWaitForTransaction when
   * you need `events`.
   */
  async submitAndWait(
    commands: JsCommandsBody
  ): Promise<{ updateId: string; completionOffset: number }> {
    const response = await this.post<{
      updateId?: string;
      completionOffset?: number;
    }>("/v2/commands/submit-and-wait", commands);

    if (!response.updateId) {
      throw new CantonError(
        "submit-and-wait returned no updateId",
        "INVALID_RESPONSE"
      );
    }
    return {
      updateId: response.updateId,
      completionOffset: response.completionOffset ?? 0,
    };
  }

  /**
   * POST /v2/interactive-submission/prepare
   *
   * Builds the transaction the participant would submit on behalf of
   * an external party, but does NOT submit it. Returns the
   * serialized `preparedTransaction` (base64 protobuf) and its hash
   * so the external party can sign the hash locally with its own key.
   *
   * Pair with `executeSubmission` after the client has signed.
   */
  async interactiveSubmissionPrepare(
    body: InteractivePrepareBody
  ): Promise<PreparedSubmission> {
    const response = await this.post<{
      preparedTransaction?: string;
      preparedTransactionHash?: string;
    }>("/v2/interactive-submission/prepare", {
      // The participant REQUIRES packageIdSelectionPreference (omitting it ->
      // HTTP 400 "Missing required field at 'packageIdSelectionPreference'");
      // verboseHashing defaults false. Provide both so callers need not; any
      // explicit value in `body` still wins via the spread.
      verboseHashing: false,
      packageIdSelectionPreference: [],
      ...body,
    });
    if (!response.preparedTransaction || !response.preparedTransactionHash) {
      throw new CantonError(
        "interactive-submission/prepare returned incomplete response",
        "INVALID_RESPONSE"
      );
    }
    return {
      preparedTransaction: response.preparedTransaction,
      preparedTransactionHash: response.preparedTransactionHash,
    };
  }

  /**
   * POST /v2/interactive-submission/execute
   *
   * Submits a transaction prepared by `interactiveSubmissionPrepare`
   * together with the external party's signature over its hash.
   * Returns the resulting `updateId`.
   */
  async interactiveSubmissionExecute(
    body: InteractiveExecuteBody
  ): Promise<InteractiveExecuteResult> {
    const response = await this.post<{
      updateId?: string;
      completionOffset?: number;
    }>("/v2/interactive-submission/execute", body);
    // The participant's /execute is async: it returns {} and the updateId
    // arrives on the completion stream (poll via pollCompletionUpdateId). Do not
    // throw on a missing updateId here; callers that need it poll the completion.
    return {
      updateId: response.updateId ?? "",
      completionOffset: response.completionOffset ?? 0,
    };
  }

  /**
   * POST /v2/parties/external/generate-topology
   *
   * Asks the participant to build (but not submit) the topology
   * transactions needed to onboard a new external party. Returns
   * the partyId, the canonical `publicKeyFingerprint` (a multihash
   * sha2-256 the client cannot compute locally), the serialized
   * topology txs, and a `multiHash` over them ready to be signed.
   *
   * Pair with `allocateExternalParty` after the client has signed
   * the multiHash with its Ed25519 key. See
   * `ED25519_WIRE_CONSTANTS` in external-party.ts for the
   * required enum strings.
   */
  async generateExternalPartyTopology(body: {
    synchronizer: string;
    partyHint: string;
    publicKey: {
      format: string;
      keyData: string;
      keySpec: string;
    };
    localParticipantObservationOnly?: boolean;
    otherConfirmingParticipantUids?: string[];
    confirmationThreshold?: number;
    observingParticipantUids?: string[];
  }): Promise<{
    partyId: string;
    publicKeyFingerprint: string;
    topologyTransactions: string[];
    multiHash: string;
  }> {
    return this.post("/v2/parties/external/generate-topology", {
      localParticipantObservationOnly:
        body.localParticipantObservationOnly ?? false,
      confirmationThreshold: body.confirmationThreshold ?? 0,
      ...body,
    });
  }

  /**
   * POST /v2/parties/external/allocate
   *
   * Finalises onboarding of an external party. The caller signs
   * either each `onboardingTransactions[i]` individually OR the
   * combined `multiHash` from `generateExternalPartyTopology`; the
   * latter is the simpler single-signature path.
   *
   * `identityProviderId` is required (empty string for the default
   * IDP). `signedBy` in each Signature must be the participant-
   * supplied multihash fingerprint from generate-topology — not a
   * locally-computed value.
   */
  async allocateExternalParty(body: {
    synchronizer: string;
    identityProviderId: string;
    onboardingTransactions: Array<{
      transaction: string;
      signatures?: Array<{
        format: string;
        signature: string;
        signingAlgorithmSpec: string;
        signedBy: string;
      }>;
    }>;
    multiHashSignatures?: Array<{
      format: string;
      signature: string;
      signingAlgorithmSpec: string;
      signedBy: string;
    }>;
  }): Promise<{ partyId: string }> {
    return this.post("/v2/parties/external/allocate", body);
  }

  /**
   * POST /v2/updates/update-by-id
   *
   * Look up a transaction by its `updateId`, scoped to the requesting parties.
   * Returns the `events[]` array: by default the narrow projection (each
   * party's own creates and archives, no exercises — TRANSACTION_SHAPE_ACS_DELTA),
   * or with `fullEffects` the whole ledger-effects tree.
   *
   * Used by the CIP-56 client signer to correlate the exact
   * `TransferInstruction` cid created by a freshly-executed
   * `TransferFactory_Transfer` — ACS-scanning is unsafe because
   * the same sender may have unrelated TransferInstructions
   * outstanding from prior transfers.
   *
   * The narrow projection used to come from `POST /v2/updates/transaction-by-id`
   * with `requestingParties`. Canton 3.6 disables that endpoint
   * (DEPRECATED_API_DISABLED; 3.7 removes it). What it returned — measured on a
   * live MainNet USDCx settle: 2 events, both Created/Archived of the payer's
   * own Holding, no exercises — is the ACS-delta shape, so the same request
   * now goes to update-by-id with that shape.
   */
  async getTransactionById(args: {
    /** Ask for the full ledger-effects tree (exercises included) instead of the
     *  narrow projection. Needed by the registry funds-moved proof; see the
     *  measurement in the request body below. */
    fullEffects?: boolean;
    updateId: string;
    requestingParties: string[];
  }): Promise<{
    updateId: string;
    offset: number;
    events: Array<{
      CreatedEvent?: CreatedEvent;
      ExercisedEvent?: {
        contractId: string;
        templateId: string;
        choice: string;
        exerciseResult?: unknown;
      };
      ArchivedEvent?: { contractId: string; templateId: string };
    }>;
  }> {
    const response = await this.post<{
      transaction?: {
        updateId?: string;
        offset?: number;
        events?: Array<{
          CreatedEvent?: CreatedEvent;
          ExercisedEvent?: {
            contractId: string;
            templateId: string;
            choice: string;
            exerciseResult?: unknown;
          };
          ArchivedEvent?: { contractId: string; templateId: string };
        }>;
      };
    }>("/v2/updates/update-by-id", {
      // THE SAME PARTY ON THE SAME TRANSACTION SEES DIFFERENT EVENTS
      // DEPENDING ON THE SHAPE. Measured on a live MainNet USDCx settle, payer
      // as the requesting party:
      //   narrow (formerly transaction-by-id + requestingParties) -> 2 events,
      //     both Created/Archived of the payer's own Holding, NO exercises
      //   LEDGER_EFFECTS -> the full tree, including TransferFactory_Transfer
      //     WITH its exerciseResult
      // The registry funds-moved proof lives in that exerciseResult, so it asks
      // for fullEffects. Amulet keeps the narrow event set: its positive signal
      // is an archived Amulet, which the narrow shape already carries, and
      // widening the event set there could only add events its heuristics might
      // trip over — not a trade worth making on the path six merchants are paid
      // through.
      updateId: args.updateId,
      updateFormat: {
        includeTransactions: {
          eventFormat: {
            filtersByParty: Object.fromEntries(
              args.requestingParties.map((p) => [
                p,
                {
                  cumulative: [
                    {
                      identifierFilter: {
                        WildcardFilter: {
                          value: { includeCreatedEventBlob: false },
                        },
                      },
                    },
                  ],
                },
              ])
            ),
            verbose: false,
          },
          transactionShape: args.fullEffects
            ? "TRANSACTION_SHAPE_LEDGER_EFFECTS"
            : "TRANSACTION_SHAPE_ACS_DELTA",
        },
      },
    });
    // update-by-id wraps the transaction as { update: { Transaction: { value } } }
    // (MEASURED). The flat { transaction } wrapper of the old transaction-by-id
    // is still read, so a test double or a participant answering in that shape
    // parses the same.
    const wrapped = (
      response as unknown as {
        update?: { Transaction?: { value?: { updateId?: string; offset?: number; events?: unknown[] } } };
      }
    ).update?.Transaction?.value;
    const tx = wrapped ?? response.transaction ?? {};
    return {
      updateId: tx.updateId ?? args.updateId,
      offset: tx.offset ?? 0,
      events: (tx.events ?? []) as Awaited<
        ReturnType<CantonClient["getTransactionById"]>
      >["events"],
    };
  }

  /**
   * POST /v2/events/events-by-contract-id
   *
   * Direct O(1) lookup of a contract's create (and archive) events by
   * contract id — NO ACS enumeration. This matters operationally: an ACS
   * template slice over a party that observes MANY contracts (e.g. the
   * facilitator as the delegate-observer of every TransferCommand ever
   * created through the relay) trips the JSON API's maximum-list-elements
   * cap (HTTP 413) once enough UNSPENT contracts accumulate — and nothing
   * archives expired TransferCommands, so that count only grows. A by-cid
   * lookup is immune.
   *
   * Canton 3.4 expects the `eventFormat` body shape (filtersByParty +
   * verbose); a bare `requestingParties` field is rejected with
   * MISSING_FIELD. Returns `created: null` when the contract is invisible
   * to the requesting parties or does not exist; `archived: true` when it
   * existed but was archived (e.g. a TransferCommand consumed by its Send).
   *
   * `interfaceViews` asks for the contract through those interfaces instead
   * of the wildcard, so the create carries their views (`interfaceViews`):
   * the way to read one holding's token-standard view (HoldingV1) when the
   * holding is known by id but its template's own fields are not.
   */
  async getEventsByContractId(args: {
    contractId: string;
    requestingParties: string[];
    interfaceViews?: readonly string[];
  }): Promise<{ created: CreatedEvent | null; archived: boolean }> {
    const cumulative =
      args.interfaceViews && args.interfaceViews.length > 0
        ? args.interfaceViews.map((interfaceId) => ({
            identifierFilter: {
              InterfaceFilter: {
                value: { interfaceId, includeInterfaceView: true, includeCreatedEventBlob: false },
              },
            },
          }))
        : [
            {
              identifierFilter: {
                WildcardFilter: { value: { includeCreatedEventBlob: false } },
              },
            },
          ];
    const filtersByParty = Object.fromEntries(
      args.requestingParties.map((p) => [p, { cumulative }])
    );
    const response = await this.post<{
      created?: { createdEvent?: CreatedEvent } | CreatedEvent;
      archived?: unknown;
    }>("/v2/events/events-by-contract-id", {
      contractId: args.contractId,
      eventFormat: { filtersByParty, verbose: false },
    });
    const c = response.created;
    const created =
      c && typeof c === "object" && "createdEvent" in c
        ? ((c as { createdEvent?: CreatedEvent }).createdEvent ?? null)
        : ((c as CreatedEvent | undefined) ?? null);
    return { created, archived: Boolean(response.archived) };
  }

  /**
   * GET /v2/state/ledger-end
   *
   * Returns the current ledger end offset. Required before
   * `queryActiveContracts` because the ACS query needs an explicit
   * `activeAtOffset`.
   */
  async getLedgerEnd(): Promise<{ offset: number }> {
    const response = await this.get<{ offset?: number }>(
      "/v2/state/ledger-end"
    );
    // A MISSING/non-numeric offset is a malformed ledger-end response and
    // MUST throw — defaulting to 0 would silently query the ACS at the
    // oldest snapshot, returning an empty list, which callers
    // (findMerchantContract / findCip56TransferInstruction) then read as
    // "not found" instead of surfacing the error. A genuine offset of 0
    // (fresh ledger) is valid and preserved.
    if (typeof response.offset !== "number" || !Number.isFinite(response.offset)) {
      throw new CantonError(
        "getLedgerEnd: participant returned no numeric offset",
        "INVALID_RESPONSE"
      );
    }
    return { offset: response.offset };
  }

  /**
   * POST /v2/state/active-contracts
   *
   * Automatically fetches the current ledger end and uses it as
   * `activeAtOffset`. Extracts created events from both the nested
   * `contractEntry.JsActiveContract.createdEvent` and flat
   * `createdEvent` shapes so we tolerate forward-compatible response
   * envelopes.
   */
  async queryActiveContracts(
    filter: ActiveContractsFilter
  ): Promise<CreatedEvent[]> {
    const end = await this.getLedgerEnd();
    return this.activeContractsAt(filter, end.offset);
  }

  /**
   * POST /v2/state/active-contracts?limit=N — at most N contracts instead of
   * the participant's 413.
   *
   * The participant refuses an unbounded list longer than its element cap
   * (`http-list-max-elements-limit`, 200 by default), and the ACS has no
   * cursor. What it does accept is `limit`: it then returns the first N
   * matches, which the participant serves oldest-first. A party with more
   * contracts than the cap can therefore still be worked through — read a
   * slice, consume part of it (a merge), read again — which is how `merge`
   * converges on a wallet that a plain read cannot list at all.
   *
   * `complete` is true only when fewer than the limit came back: a slice of
   * exactly `limit` may or may not be everything, so it is reported as
   * incomplete. Callers must treat an incomplete slice as a PREFIX, never as
   * the whole set.
   *
   * A `limit` above the node's cap is itself refused with the cap in the
   * error ("node limit (K)"); the query is then repeated once at K, so the
   * caller does not have to know each participant's setting. This client then
   * remembers K and starts every later slice at it, so a node configured
   * below the default is refused once per client, not once per read.
   */
  async queryActiveContractsSlice(
    filter: ActiveContractsFilter,
    limit: number
  ): Promise<{ events: CreatedEvent[]; complete: boolean; limit: number }> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new CantonError(
        `queryActiveContractsSlice: limit must be a positive integer (got ${limit})`,
        "INVALID_ARGUMENT"
      );
    }
    const end = await this.getLedgerEnd();
    let used = this.nodeListCap === undefined ? limit : Math.min(limit, this.nodeListCap);
    let page: { events: CreatedEvent[]; rows: number };
    try {
      page = await this.activeContractsPage(filter, end.offset, used);
    } catch (err) {
      const cap =
        err instanceof CantonError && err.code === "ACS_LIMIT_EXCEEDED"
          ? nodeListLimit(err.responseBody)
          : undefined;
      if (cap === undefined || cap >= used) throw err;
      this.nodeListCap = cap;
      used = cap;
      page = await this.activeContractsPage(filter, end.offset, used);
    }
    // Completeness is decided on the ROWS the participant returned, not on the
    // events we kept: an entry without a created event (e.g. an in-flight
    // reassignment) still counts against the limit, and dropping it must not
    // turn a full — possibly partial — slice into a "complete" one.
    return { events: page.events, complete: page.rows < used, limit: used };
  }

  private async activeContractsAt(
    filter: ActiveContractsFilter,
    offset: number
  ): Promise<CreatedEvent[]> {
    return (await this.activeContractsPage(filter, offset)).events;
  }

  private async activeContractsPage(
    filter: ActiveContractsFilter,
    offset: number,
    limit?: number
  ): Promise<{ events: CreatedEvent[]; rows: number }> {
    type AcsEntry = {
      contractEntry?: {
        JsActiveContract?: { createdEvent?: CreatedEvent };
      };
      createdEvent?: CreatedEvent;
    };
    type AcsResponse = AcsEntry[] | { contractEntries?: AcsEntry[] };
    let response: AcsResponse;
    try {
      const path =
        limit === undefined
          ? "/v2/state/active-contracts"
          : `/v2/state/active-contracts?limit=${limit}`;
      // `eventFormat`, not the top-level `filter` + `verbose`: Canton 3.6
      // rejects those deprecated fields with 400 unless the participant sets
      // features.deprecated.enable-deprecated-parameters-34, and 3.7 removes
      // them. eventFormat is accepted since 3.3, so older nodes read it too.
      response = await this.post<AcsResponse>(path, {
        eventFormat: { ...filter, verbose: false },
        activeAtOffset: offset,
      });
    } catch (err) {
      // A 413 (or the JSON_API_MAXIMUM_LIST_ELEMENTS_NUMBER_REACHED marker the
      // participant returns when the ACS slice for this filter exceeds Canton's
      // element cap) must NOT be collapsed into a generic ledger error: the
      // callers (findMerchantContract / TransferCommand.find) would then either
      // surface it as unexpected_canton_ledger_error or — worse — treat the
      // failed query as an empty result and report a contract that DOES exist
      // as "not found". Re-throw a distinct, actionable code so the failure is
      // observable instead of masked.
      if (
        err instanceof CantonError &&
        (err.status === 413 ||
          (err.responseBody ?? "").includes("MAXIMUM_LIST_ELEMENTS"))
      ) {
        throw new CantonError(
          "active-contracts query exceeded the participant's element limit " +
            "(JSON_API_MAXIMUM_LIST_ELEMENTS_NUMBER_REACHED): the ACS slice for " +
            "this filter is too large. Narrow the TemplateFilter/InterfaceFilter " +
            "or paginate. This is an error, NOT an empty result, so a real " +
            "contract is never reported missing.",
          "ACS_LIMIT_EXCEEDED",
          err.status ?? 413,
          err.responseBody
        );
      }
      throw err;
    }

    // cn-quickstart (Splice 0.5.3) returns a bare JSON array at the
    // top level. Older / newer Canton versions may wrap in
    // `{contractEntries: [...]}`. Handle both.
    const entries: AcsEntry[] = Array.isArray(response)
      ? response
      : (response.contractEntries ?? []);

    const events: CreatedEvent[] = [];
    for (const entry of entries) {
      const created =
        entry.contractEntry?.JsActiveContract?.createdEvent ??
        entry.createdEvent;
      if (created) events.push(created);
    }
    return { events, rows: entries.length };
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  /**
   * Read an external party's Ed25519 SIGNING public keys from the synchronizer
   * topology, as JWKS. Returns the raw 32-byte keys.
   *
   * WHY THIS EXISTS: a party id carries a FINGERPRINT — a multihash over the
   * serialized SigningPublicKey protobuf — which is one-way, so the key it
   * names cannot be recovered from it. Verifying a payer's signature therefore
   * needs a topology read, and this is the only one the JSON Ledger API offers.
   *
   * OUR PARTICIPANT NEED NOT HOST THE PARTY. The endpoint resolves against the
   * broadcast synchronizer topology store, so any party on a synchronizer we
   * are connected to is readable; authorization is Public, not admin. That is
   * what makes cross-participant relaying possible at all.
   *
   * VERSION GATE, RE-MEASURED 2026-08-08 against the actual artifacts, and the
   * earlier claim here was wrong. The Splice-distributed participant does NOT
   * serve this route: neither canton-participant:0.6.13 (Canton 3.5.9) nor
   * :0.6.14 (Canton 3.5.10) contains any JoseService class in the shipped
   * canton-open-source jar, and the JSON Ledger API spec inside both images
   * lists 52 routes with no `jose` path. A live probe of the 0.6.13 participant
   * returns 404, identical to a nonsense path. Upstream Canton at tag v3.5.10
   * does define the route, so it exists somewhere — but not in what Splice
   * ships, which is what we run.
   *
   * So a 404 here is the NORMAL state today, not a stale-participant symptom.
   * Callers MUST treat it as "cannot verify", never as "no keys, so accept" —
   * which is what the verifier does, so the inline arm simply does not settle.
   *
   * The real source for an external party's signing key is the participant's
   * ADMIN gRPC topology read (ListNamespaceDelegation / the deprecated
   * ListPartyToKeyMapping, both present in the 0.6.13 protobuf we already run),
   * which reads the broadcast synchronizer store and so answers for parties we
   * do not host. Moving Rule 3 onto it needs no upgrade at all.
   *
   * NOTE ON `kid`, if this route is ever reachable: it is an RFC 7638 JWK
   * THUMBPRINT, not a Canton Fingerprint, and must never be used as
   * `Signature.signedBy` (see the comment in facilitator routes/settle.ts).
   *
   * Only keys usable for protocol signing come back, which is exactly the usage
   * an external party's signing key carries.
   */
  async getPartySigningKeys(
    synchronizerId: string,
    party: string
  ): Promise<Buffer[]> {
    return (await this.getPartySigningKeyEntries(synchronizerId, party)).map(
      (e) => e.key
    );
  }

  /**
   * The same topology read, keeping each key's published IDENTIFIER alongside
   * its bytes.
   *
   * WHY THE IDENTIFIER MATTERS: a relayed external signature must name the key
   * that produced it (`Signature.signedBy`). A party with ONE key can be named
   * by its own namespace, because the namespace IS that key's fingerprint — but
   * a party that has rotated or published a second key cannot. Verifying
   * against "any published key" while naming a fixed one is a mismatch the
   * participant rejects at execute, so the identifier has to survive the
   * lookup rather than be re-derived by guesswork.
   *
   * `kid` is passed through EXACTLY as published; it is deliberately not
   * synthesised. Canton's fingerprint preimage has two plausible key-byte
   * spellings (DER SPKI and the raw point — see the agent-wallet onboarding
   * check, which computes both and accepts either), so a locally derived
   * fingerprint would be a coin flip, and the wrong side of it is a failed
   * settle. Absent `kid` means the caller must fall back to what it can prove.
   */
  async getPartySigningKeyEntries(
    synchronizerId: string,
    party: string
  ): Promise<Array<{ key: Buffer; keyId?: string }>> {
    const res = await this.get<{
      keys?: Array<{ kty?: string; crv?: string; x?: string; kid?: string }>;
    }>(
      `/v2/jose/jwks/synchronizer/${encodeURIComponent(
        synchronizerId
      )}/party/${encodeURIComponent(party)}`
    );
    const out: Array<{ key: Buffer; keyId?: string }> = [];
    for (const k of res.keys ?? []) {
      // Pin the curve: an OKP entry for a different curve would decode to the
      // wrong length or the wrong algorithm, and silently skipping the check
      // would let a non-Ed25519 key reach an Ed25519 verify.
      if (k.kty !== "OKP" || k.crv !== "Ed25519" || typeof k.x !== "string") {
        continue;
      }
      // `x` is base64url, unpadded, RFC 8032 — the raw point, which is what
      // node's Ed25519 verify wants.
      const raw = Buffer.from(k.x, "base64url");
      if (raw.length === 32) {
        out.push({
          key: raw,
          ...(typeof k.kid === "string" && k.kid.length > 0
            ? { keyId: k.kid }
            : {}),
        });
      }
    }
    return out;
  }

  private async get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  /**
   * GET /v2/parties/{party}: this participant's record of a party, or
   * undefined when it has none. `isLocal` is true when this participant hosts
   * the party. A read refused for a party it does not host is the caller's
   * question answered, never a sign that our own read rights broke.
   */
  async getPartyDetails(party: string): Promise<{ party: string; isLocal: boolean } | undefined> {
    const r = await this.request<{ partyDetails?: Array<{ party?: string; isLocal?: boolean }> }>(
      "GET",
      `/v2/parties/${encodeURIComponent(party)}`
    );
    const d = r.partyDetails?.find((x) => x.party === party);
    return d ? { party, isLocal: d.isLocal === true } : undefined;
  }

  /**
   * Grant a participant user CanActAs on a party. Lets the relay's ledger user
   * read the party's ACS, PREPARE interactive submissions for it and EXECUTE
   * them for a freshly onboarded external (agent) party. NOT custody: the
   * external party's namespace is its own key, so execution still requires the
   * party's own signature — the user can build unsigned transactions but never
   * sign them.
   */
  async grantUserRights(userId: string, party: string): Promise<void> {
    await this.request<unknown>(
      "POST",
      `/v2/users/${encodeURIComponent(userId)}/rights`,
      {
        userId,
        rights: [
          // One right is enough. CanActAs also authorizes reads: Canton's
          // canReadAs accepts an act-as claim (Claims.scala), so the ACS reads
          // behind balance/pending/input selection keep working. Without
          // CanActAs, /v2/interactive-submission/execute returns HTTP 403 (a
          // CanReadAs-only attempt once broke claim/pay). A second CanReadAs
          // per party only halved how many parties fit under a participant's
          // max-rights-per-user, which is the default 1000 on most nodes.
          { kind: { CanActAs: { value: { party } } } },
        ],
      }
    );
  }

  /**
   * ONE PASS over the completion stream for a submissionId. No waiting, no
   * retry — the caller decides how patient to be.
   *
   * Exists so "what did this submission do" has ONE reading of the completion
   * record. `pollCompletionUpdateId` below is that reading plus patience, and
   * the after-the-fact resolver in the facilitator is the same reading with
   * none. Two copies of this three-way discrimination (settled / rejected /
   * not there yet) is exactly the divergence that keeps producing money bugs
   * in this repo.
   */
  async findCompletion(
    userId: string,
    party: string,
    submissionId: string,
    beginExclusive: number
  ): Promise<
    | { kind: "settled"; updateId: string }
    | { kind: "rejected"; message: string }
    | { kind: "absent" }
  > {
    for (const v of await this.readCompletions(userId, party, beginExclusive)) {
      if (v.submissionId !== submissionId) continue;
      if (!v.status || v.status.code === 0) {
        return { kind: "settled", updateId: v.updateId ?? "" };
      }
      return {
        kind: "rejected",
        message: v.status.message || `status ${v.status.code}`,
      };
    }
    return { kind: "absent" };
  }

  /**
   * Poll the completion stream for the updateId of an interactive submission.
   * /execute is async (returns {}); the updateId lands on the completion keyed
   * by submissionId. Throws SUBMISSION_FAILED if that completion carries a
   * non-zero status code.
   */
  async pollCompletionUpdateId(
    userId: string,
    party: string,
    submissionId: string,
    beginExclusive: number
  ): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const found = await this.findCompletion(
        userId,
        party,
        submissionId,
        beginExclusive
      );
      if (found.kind === "settled") return found.updateId;
      if (found.kind === "rejected") {
        throw new CantonError(
          `interactive submission rejected: ${found.message}`,
          "SUBMISSION_FAILED"
        );
      }
      await new Promise((r) => setTimeout(r, 600));
    }
    throw new CantonError(
      "no completion for submissionId within timeout",
      "INVALID_RESPONSE"
    );
  }

  /**
   * ONE PASS over the completion stream: every completion for `commandId`
   * after `beginExclusive`, accepted and rejected, in ledger order.
   *
   * This is how a submitter learns what an attempt with a lost answer did.
   * Unlike readCompletions it THROWS when the stream could not be read (token,
   * non-2xx, no body), so "the read failed" is never confused with "no
   * completion yet". An empty result means only that nothing for this command
   * has been published so far.
   */
  async findCommandCompletions(
    userId: string,
    party: string,
    commandId: string,
    beginExclusive: number
  ): Promise<CommandCompletion[]> {
    const out: CommandCompletion[] = [];
    for (const v of await this.readCompletionsStrict(userId, party, beginExclusive)) {
      if (v.commandId !== commandId) continue;
      const c: CommandCompletion = {};
      if (v.submissionId !== undefined) c.submissionId = v.submissionId;
      if (v.updateId) c.updateId = v.updateId;
      if (typeof v.offset === "number") c.offset = v.offset;
      if (v.status && v.status.code !== undefined && v.status.code !== 0) {
        c.rejection = v.status.message || `status ${v.status.code}`;
      }
      out.push(c);
    }
    return out;
  }

  /**
   * The completion stream from `beginExclusive`, failing loudly.
   *
   * The endpoint is a live stream: it does not close at the ledger end, so the
   * read always ends on our own deadline or size cap, usually in the middle of
   * an element. Only the elements that arrived whole are returned — the cut one
   * is dropped rather than letting it spoil the parse of everything before it.
   */
  private async readCompletionsStrict(
    userId: string,
    party: string,
    beginExclusive: number
  ): Promise<
    Array<{
      commandId?: string;
      submissionId?: string;
      updateId?: string;
      offset?: number;
      status?: { code?: number; message?: string };
    }>
  > {
    const tok =
      typeof this.opts.token === "string" ? this.opts.token : await this.opts.token();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    let buf = "";
    try {
      let res: Response;
      try {
        res = await this.fetchFn(`${this.opts.participantUrl}/v2/commands/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
          body: JSON.stringify({ userId, parties: [party], beginExclusive }),
          signal: controller.signal,
        });
      } catch (err) {
        throw new CantonError(
          `POST /v2/commands/completions failed: ${err instanceof Error ? err.message : String(err)}`,
          "TRANSPORT_ERROR"
        );
      }
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        throw new CantonError(
          `POST /v2/commands/completions returned HTTP ${res.status}`,
          "HTTP_ERROR",
          res.status,
          text.slice(0, 1024)
        );
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          if (buf.length > 500_000) break;
        }
      } catch {
        /* our deadline — the normal end of a live stream */
      }
    } finally {
      clearTimeout(timer);
    }
    return completeArrayElements(buf)
      .map((raw) => {
        try {
          return (JSON.parse(raw) as { completionResponse?: { Completion?: { value?: unknown } } })
            .completionResponse?.Completion?.value;
        } catch {
          return undefined;
        }
      })
      .filter(
        (v): v is {
          commandId?: string;
          submissionId?: string;
          updateId?: string;
          offset?: number;
          status?: { code?: number; message?: string };
        } => !!v && typeof v === "object"
      );
  }

  private async readCompletions(
    userId: string,
    party: string,
    beginExclusive: number
  ): Promise<
    Array<{
      commandId?: string;
      submissionId?: string;
      updateId?: string;
      offset?: number;
      status?: { code?: number; message?: string };
    }>
  > {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const tok =
        typeof this.opts.token === "string"
          ? this.opts.token
          : await this.opts.token();
      const res = await this.fetchFn(
        `${this.opts.participantUrl}/v2/commands/completions`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
          body: JSON.stringify({ userId, parties: [party], beginExclusive }),
          signal: controller.signal,
        }
      );
      if (!res.ok || !res.body) return [];
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          if (buf.length > 500_000) break;
        }
      } catch {
        /* aborted by timeout — parse what we have */
      }
      let str = buf.trim();
      if (!str.startsWith("[")) return [];
      if (!str.endsWith("]")) str = str.replace(/,\s*$/, "") + "]";
      const arr = JSON.parse(str) as Array<{
        completionResponse?: { Completion?: { value?: unknown } };
      }>;
      return arr
        .map((c) => c.completionResponse?.Completion?.value)
        .filter(
          (v): v is {
            commandId?: string;
            submissionId?: string;
            updateId?: string;
            offset?: number;
            status?: { code?: number; message?: string };
          } => !!v
        );
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const tok =
        typeof this.opts.token === "string"
          ? this.opts.token
          : await this.opts.token();
      const init: RequestInit = {
        method,
        headers: {
          Authorization: `Bearer ${tok}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      const res = await this.fetchFn(`${this.opts.participantUrl}${path}`, init);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new CantonError(
          `${method} ${path} returned HTTP ${res.status}`,
          "HTTP_ERROR",
          res.status,
          text.slice(0, 1024)
        );
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof CantonError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new CantonError(
          `${method} ${path} aborted after ${this.timeoutMs}ms`,
          "TIMEOUT"
        );
      }
      throw new CantonError(
        `${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
        "TRANSPORT_ERROR"
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
