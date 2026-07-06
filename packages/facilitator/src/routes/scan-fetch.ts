/**
 * Shared, robust Scan raw-fetch helper extracted VERBATIM (same semantics) from
 * the `scanFetchRetry` / `getDso` closures inside routes/wallet.ts.
 *
 * The agent-wallet relay's registry/DSO resolves bypass `ScanClient` (they hit
 * registry endpoints `ScanClient` does not model), so they carry their OWN
 * bounded retry + multi-SV failover: the public SV Scan sheds load with
 * transient 503s, and a single upstream 503 must NOT surface as a hard failure
 * for an idempotent registry read. These reads are idempotent registry/DSO-state
 * lookups, so retry + failing over to another SV's Scan is safe.
 *
 * This module exposes the same logic as a reusable factory so a SECOND raw-Scan
 * caller (the Design A escrow settle path's execute-transfer choice-context
 * resolve) gets the EXACT same multi-SV robustness instead of the e2e shim's
 * single-Scan `fetch(SCAN_URL + path)` — which was the source of the shim's
 * single-Scan 503 flakiness. wallet.ts keeps its own in-file copy (left
 * untouched to avoid any regression on the proven money path); the two are
 * behaviourally identical and covered by the same kind of fetch-stub tests.
 */

/** Distinct, trailing-slash-stripped Scan bases: primary first, then fallbacks,
 *  de-duplicated and order-preserving (identical to wallet.ts `scanBases`). */
export function scanBases(scanUrl: string, fallbackUrls?: string[]): string[] {
  return [
    scanUrl.replace(/\/$/, ""),
    ...(fallbackUrls ?? []).map((u) => u.replace(/\/$/, "")),
  ].filter((u, i, a) => u && a.indexOf(u) === i);
}

/**
 * Build a `scanFetchRetry(path, init)` bound to a primary Scan base + optional
 * SV fallbacks. Per base: up to 4 attempts (the original + 3 retries) on a
 * transient fault (network throw, 429, or any 5xx) with jittered exponential
 * backoff; a real non-2xx (404/400) is returned IMMEDIATELY for the caller to
 * handle; a transient-exhausted base falls over to the next SV. When every base
 * is exhausted the last response is returned (so the caller's `!r.ok` throws the
 * upstream status), or the last transport error is rethrown if there was no
 * response at all. Byte-for-byte the same control flow as wallet.ts.
 *
 * `fetchImpl` is injectable purely for deterministic unit tests; production
 * passes nothing and the global `fetch` is used (matching wallet.ts, whose
 * tests stub the global).
 */
export function makeScanFetchRetry(
  scanUrl: string,
  fallbackUrls?: string[],
  fetchImpl: typeof globalThis.fetch = globalThis.fetch
): (path: string, init: RequestInit) => Promise<Response> {
  return async (path: string, init: RequestInit): Promise<Response> => {
    let lastErr: unknown;
    let lastRes: Response | undefined;
    for (const base of scanBases(scanUrl, fallbackUrls)) {
      for (let attempt = 0; ; attempt++) {
        let res: Response | undefined;
        try {
          res = await fetchImpl(`${base}${path}`, init);
        } catch (err) {
          lastErr = err; // network/transport fault — transient
        }
        if (res?.ok) return res;
        const transient = !res || res.status === 429 || res.status >= 500;
        if (res) lastRes = res;
        if (transient && attempt < 3) {
          await new Promise((r) =>
            setTimeout(r, 400 * 2 ** attempt + Math.floor(Math.random() * 150))
          );
          continue;
        }
        if (!transient && res) return res; // real non-2xx → caller decides
        break; // transient exhausted on this base → next SV (if any)
      }
    }
    if (lastRes) return lastRes; // let the caller's !r.ok throw the upstream status
    throw lastErr ?? new Error("scan fetch failed");
  };
}

/**
 * Build a memoizing `getDso()` over a scanFetchRetry. Reads
 * `/api/scan/v0/dso-party-id` once and caches the party id for the closure's
 * lifetime (the DSO is stable). Mirrors wallet.ts `getDso`.
 */
export function makeGetDso(
  scanFetchRetry: (path: string, init: RequestInit) => Promise<Response>
): () => Promise<string> {
  let dsoCache: string | undefined;
  return async (): Promise<string> => {
    if (dsoCache) return dsoCache;
    const r = await scanFetchRetry("/api/scan/v0/dso-party-id", {
      headers: { Accept: "application/json" },
    });
    if (!r.ok) throw new Error(`dso-party-id HTTP ${r.status}`);
    dsoCache = ((await r.json()) as { dso_party_id: string }).dso_party_id;
    return dsoCache;
  };
}
