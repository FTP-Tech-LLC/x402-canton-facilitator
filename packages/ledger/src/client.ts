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

export interface JsCommandsBody {
  commandId: string;
  userId: string;
  actAs: string[];
  readAs?: string[];
  synchronizerId?: string;
  disclosedContracts?: DisclosedContract[];
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

export class CantonClient {
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly timeoutMs: number;

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
   * POST /v2/updates/transaction-by-id
   *
   * Look up a transaction by its `updateId`, scoped to one
   * requesting party. Returns the `events[]` array (LEDGER_EFFECTS
   * shape — top-level created/archived/exercised events only;
   * children of an Exercised event are not flattened).
   *
   * Used by the CIP-56 client signer to correlate the exact
   * `TransferInstruction` cid created by a freshly-executed
   * `TransferFactory_Transfer` — ACS-scanning is unsafe because
   * the same sender may have unrelated TransferInstructions
   * outstanding from prior transfers.
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
    }>(
      args.fullEffects ? "/v2/updates/update-by-id" : "/v2/updates/transaction-by-id",
      args.fullEffects
        ? {
            // THE SAME PARTY ON THE SAME TRANSACTION SEES DIFFERENT EVENTS
            // DEPENDING ON WHICH REQUEST SHAPE ASKS. Measured on a live MainNet
            // USDCx settle, payer as the requesting party:
            //   transaction-by-id + requestingParties -> 2 events, both
            //     Created/Archived of the payer's own Holding, NO exercises
            //   update-by-id + updateFormat.filtersByParty(wildcard) -> the
            //     full ledger-effects tree, including TransferFactory_Transfer
            //     WITH its exerciseResult
            // The registry funds-moved proof lives in that exerciseResult, so
            // it needs this shape. Amulet keeps the original request byte for
            // byte: its positive signal is an archived Amulet, which the
            // narrow shape already carries, and widening the event set there
            // could only add events its heuristics might trip over — not a
            // trade worth making on the path six merchants are paid through.
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
                transactionShape: "TRANSACTION_SHAPE_LEDGER_EFFECTS",
              },
            },
          }
        : {
            updateId: args.updateId,
            requestingParties: args.requestingParties,
            transactionShape: "TRANSACTION_SHAPE_LEDGER_EFFECTS",
          }
    );
    // The two endpoints wrap the transaction differently. MEASURED, not assumed:
    //   transaction-by-id -> { transaction: { events } }
    //   update-by-id      -> { update: { Transaction: { value: { events } } } }
    const wrapped = (
      response as unknown as {
        update?: { Transaction?: { value?: { updateId?: string; offset?: number; events?: unknown[] } } };
      }
    ).update?.Transaction?.value;
    const tx = (args.fullEffects ? wrapped : response.transaction) ?? {};
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
   */
  async getEventsByContractId(args: {
    contractId: string;
    requestingParties: string[];
  }): Promise<{ created: CreatedEvent | null; archived: boolean }> {
    const filtersByParty = Object.fromEntries(
      args.requestingParties.map((p) => [
        p,
        {
          cumulative: [
            {
              identifierFilter: {
                WildcardFilter: { value: { includeCreatedEventBlob: false } },
              },
            },
          ],
        },
      ])
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
    type AcsEntry = {
      contractEntry?: {
        JsActiveContract?: { createdEvent?: CreatedEvent };
      };
      createdEvent?: CreatedEvent;
    };
    type AcsResponse = AcsEntry[] | { contractEntries?: AcsEntry[] };
    let response: AcsResponse;
    try {
      response = await this.post<AcsResponse>("/v2/state/active-contracts", {
        filter,
        verbose: false,
        activeAtOffset: end.offset,
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
    return events;
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
   * Grant a participant user CanActAs + CanReadAs on a party. Lets the relay's
   * ledger user PREPARE interactive submissions for a freshly onboarded
   * external (agent) party. NOT custody: the external party's namespace is its
   * own key, so execution still requires the party's own signature — the user
   * can build unsigned transactions but never sign them.
   */
  async grantUserRights(userId: string, party: string): Promise<void> {
    await this.request<unknown>(
      "POST",
      `/v2/users/${encodeURIComponent(userId)}/rights`,
      {
        userId,
        rights: [
          // BOTH are required. CanReadAs: read the party ACS (balance/pending,
          // input selection). CanActAs: the relay user EXECUTES the agent's
          // interactive submissions on its behalf (claim/pay) — without it
          // /v2/interactive-submission/execute returns HTTP 403. (A prior
          // CanReadAs-only attempt broke claim/pay; the earlier HTTP 400 was
          // TOO_MANY_USER_RIGHTS, a participant count cap since raised, NOT a
          // rejection of CanActAs on external parties.)
          { kind: { CanActAs: { value: { party } } } },
          { kind: { CanReadAs: { value: { party } } } },
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

  private async readCompletions(
    userId: string,
    party: string,
    beginExclusive: number
  ): Promise<
    Array<{
      submissionId?: string;
      updateId?: string;
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
            submissionId?: string;
            updateId?: string;
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
