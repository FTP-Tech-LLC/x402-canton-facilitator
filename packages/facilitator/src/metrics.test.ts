import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { createMetrics } from "./metrics.js";
import { registerMetricsRoute } from "./routes/metrics.js";
import { classifySettleFailure } from "./routes/settle.js";

describe("createMetrics", () => {
  it("exposes the four required metric names and they render in the registry", async () => {
    const m = createMetrics({ collectDefault: false });
    m.recordSettle("ok");
    m.breakerOpenTotal.inc();
    m.recordRateLimited("verify");
    m.settleDuration.observe(0.42);

    const text = await m.registry.metrics();
    expect(text).toContain("x402_facilitator_settle_total");
    expect(text).toContain("x402_facilitator_breaker_open_total");
    expect(text).toContain("x402_facilitator_ratelimit_rejected_total");
    expect(text).toContain("x402_facilitator_settle_duration_seconds");
  });

  it("counts prevented doomed Sends (GS-traffic burns avoided) by outcome", async () => {
    const m = createMetrics({ collectDefault: false });
    m.recordSendOutcome("skipped_nonce_consumed");
    m.recordSendOutcome("skipped_nonce_consumed");
    m.recordSendOutcome("retry_aborted_nonce");
    const text = await m.registry.getSingleMetricAsString(
      "x402_facilitator_send_outcome_total"
    );
    expect(text).toMatch(/outcome="skipped_nonce_consumed"\} 2/);
    expect(text).toMatch(/outcome="retry_aborted_nonce"\} 1/);
  });

  it("counts committed-but-zero-funds burns (GS gas spent moving nothing) as its own outcome", async () => {
    // The gas-burn DoS signal: a TransferCommand_Send that COMMITTED (billed GS
    // traffic) but moved no CC. Distinct from the avoided-burn outcomes so an
    // operator can alert on an attacker burning facilitator gas indefinitely.
    const m = createMetrics({ collectDefault: false });
    m.recordSendOutcome("committed_zero_funds_burn");
    m.recordSendOutcome("committed_zero_funds_burn");
    const text = await m.registry.getSingleMetricAsString(
      "x402_facilitator_send_outcome_total"
    );
    expect(text).toMatch(/outcome="committed_zero_funds_burn"\} 2/);
  });

  it("labels settle_total by result", async () => {
    const m = createMetrics({ collectDefault: false });
    m.recordSettle("ok");
    m.recordSettle("ok");
    m.recordSettle("validation_failed");
    expect(
      await m.registry.getSingleMetricAsString("x402_facilitator_settle_total")
    ).toMatch(/result="ok"\} 2/);
    expect(
      await m.registry.getSingleMetricAsString("x402_facilitator_settle_total")
    ).toMatch(/result="validation_failed"\} 1/);
  });

  it("labels ratelimit_rejected_total by scope", async () => {
    const m = createMetrics({ collectDefault: false });
    m.recordRateLimited("verify");
    m.recordRateLimited("settle");
    m.recordRateLimited("settle");
    const s = await m.registry.getSingleMetricAsString(
      "x402_facilitator_ratelimit_rejected_total"
    );
    expect(s).toMatch(/scope="verify"\} 1/);
    expect(s).toMatch(/scope="settle"\} 2/);
  });

  it("two instances have independent registries (test isolation)", async () => {
    const a = createMetrics({ collectDefault: false });
    const b = createMetrics({ collectDefault: false });
    a.recordSettle("ok");
    const sa = await a.registry.getSingleMetricAsString(
      "x402_facilitator_settle_total"
    );
    const sb = await b.registry.getSingleMetricAsString(
      "x402_facilitator_settle_total"
    );
    expect(sa).toMatch(/result="ok"\} 1/);
    // b never recorded — no ok sample.
    expect(sb).not.toMatch(/result="ok"\} 1/);
  });
});

describe("GET /metrics route", () => {
  it("returns 200 with the prometheus content-type and body", async () => {
    const m = createMetrics({ collectDefault: false });
    m.recordSettle("ok");
    const app = Fastify();
    await registerMetricsRoute(app, m);
    const res = await app.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.body).toContain("x402_facilitator_settle_total");
    await app.close();
  });
});

describe("classifySettleFailure", () => {
  it("maps counter_not_ready", () => {
    expect(
      classifySettleFailure("invalid_exact_canton_counter_not_ready")
    ).toBe("counter_not_ready");
  });
  it("maps already_settled", () => {
    expect(
      classifySettleFailure("invalid_exact_canton_payment_already_settled")
    ).toBe("already_settled");
  });
  it("maps unexpected_canton_ledger_error → ledger_error", () => {
    expect(classifySettleFailure("unexpected_canton_ledger_error")).toBe(
      "ledger_error"
    );
  });
  it("maps every other reason → validation_failed", () => {
    expect(
      classifySettleFailure("invalid_exact_canton_amount_mismatch")
    ).toBe("validation_failed");
    expect(
      classifySettleFailure("invalid_exact_canton_merchant_not_registered")
    ).toBe("validation_failed");
  });
});
