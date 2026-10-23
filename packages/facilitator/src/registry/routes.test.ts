import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { registerRegistryRoutes } from "./routes.js";
import type { RegistryRouteServices } from "./routes.js";

const OPERATOR_TOKEN = "test-operator-token";
const AUTH = { authorization: `Bearer ${OPERATOR_TOKEN}` };

function makeServices(
  overrides: Partial<RegistryRouteServices> = {}
): RegistryRouteServices {
  return {
    merchantContract: {
      createRegistrationProposal: vi.fn(async () => ({
        proposalCid: "00proposal",
        updateId: "u-reg",
      })),
      findMerchantContract: vi.fn(async () => null),
      acceptRegistrationProposal: vi.fn(async () => ({
        merchantContractCid: "00mc",
        updateId: "u-acc",
      })),
    } as unknown as RegistryRouteServices["merchantContract"],
    scan: {
      resolveTransferKind: vi.fn(async () => "direct"),
    } as unknown as RegistryRouteServices["scan"],
    facilitatorParty: "ftp_facilitator::1220fff",
    synchronizerId: "global-domain::1220",
    userId: "facilitator-user",
    operatorToken: OPERATOR_TOKEN,
    preapproval: {
      createTransferPreapproval: vi.fn(async () => ({
        updateId: "u-preapproval",
        receiver: "merchant::1220m",
        provider: "ftp_facilitator::1220fff",
        expiresAt: "2026-09-01T00:00:00Z",
      })),
    } as unknown as RegistryRouteServices["preapproval"],
    enablePreapprovalProvider: false,
    ...overrides,
  };
}

describe("registerRegistryRoutes", () => {
  it("POST /v1/merchants/register creates a proposal (authenticated)", async () => {
    const app = Fastify();
    await registerRegistryRoutes(app, makeServices());
    const res = await app.inject({
      method: "POST",
      url: "/v1/merchants/register",
      headers: AUTH,
      payload: {
        merchant: "merchant::1220",
        asset: "canton-coin",
        defaultPrice: "1000000000",
        resourcePattern: "https://api.example.com/*",
        description: "Test merchant",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ proposalCid: "00proposal" });
  });

  it("POST /v1/merchants/register validates required fields (authenticated)", async () => {
    const app = Fastify();
    await registerRegistryRoutes(app, makeServices());
    const res = await app.inject({
      method: "POST",
      url: "/v1/merchants/register",
      headers: AUTH,
      payload: { merchant: "merchant::1220" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /v1/merchants/:party returns 404 when not registered (public, no auth)", async () => {
    const app = Fastify();
    await registerRegistryRoutes(app, makeServices());
    const res = await app.inject({
      method: "GET",
      url: "/v1/merchants/merchant::1220",
    });
    expect(res.statusCode).toBe(404);
  });

  it("POST /v1/merchants/:proposalCid/accept exercises AcceptRegistration (authenticated)", async () => {
    const app = Fastify();
    await registerRegistryRoutes(app, makeServices());
    const res = await app.inject({
      method: "POST",
      url: "/v1/merchants/00proposal/accept",
      headers: AUTH,
      payload: { merchant: "merchant::1220", proposalTemplateId: "tid" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ merchantContractCid: "00mc" });
  });

  // ── audit H3: operator auth on registry mutations ───────────────────────
  describe("operator authorization (audit H3)", () => {
    it("register WITHOUT an Authorization header → 401, ledger NOT touched", async () => {
      const svc = makeServices();
      const app = Fastify();
      await registerRegistryRoutes(app, svc);
      const res = await app.inject({
        method: "POST",
        url: "/v1/merchants/register",
        payload: {
          merchant: "merchant::1220",
          asset: "canton-coin",
          defaultPrice: "1000000000",
          resourcePattern: "https://api.example.com/*",
          description: "x",
        },
      });
      expect(res.statusCode).toBe(401);
      expect(svc.merchantContract.createRegistrationProposal).not.toHaveBeenCalled();
    });

    it("register with a WRONG bearer token → 401, ledger NOT touched", async () => {
      const svc = makeServices();
      const app = Fastify();
      await registerRegistryRoutes(app, svc);
      const res = await app.inject({
        method: "POST",
        url: "/v1/merchants/register",
        headers: { authorization: "Bearer not-the-token" },
        payload: {
          merchant: "merchant::1220",
          asset: "canton-coin",
          defaultPrice: "1000000000",
          resourcePattern: "https://api.example.com/*",
          description: "x",
        },
      });
      expect(res.statusCode).toBe(401);
      expect(svc.merchantContract.createRegistrationProposal).not.toHaveBeenCalled();
    });

    it("accept WITHOUT auth → 401, ledger NOT touched", async () => {
      const svc = makeServices();
      const app = Fastify();
      await registerRegistryRoutes(app, svc);
      const res = await app.inject({
        method: "POST",
        url: "/v1/merchants/00proposal/accept",
        payload: { merchant: "merchant::1220", proposalTemplateId: "tid" },
      });
      expect(res.statusCode).toBe(401);
      expect(svc.merchantContract.acceptRegistrationProposal).not.toHaveBeenCalled();
    });

    it("when NO operatorToken is configured → mutations are DISABLED (503), ledger NOT touched", async () => {
      const svc = makeServices({ operatorToken: undefined });
      const app = Fastify();
      await registerRegistryRoutes(app, svc);
      const res = await app.inject({
        method: "POST",
        url: "/v1/merchants/register",
        headers: AUTH, // even a token can't enable it when none is configured
        payload: {
          merchant: "merchant::1220",
          asset: "canton-coin",
          defaultPrice: "1000000000",
          resourcePattern: "https://api.example.com/*",
          description: "x",
        },
      });
      expect(res.statusCode).toBe(503);
      expect(svc.merchantContract.createRegistrationProposal).not.toHaveBeenCalled();
    });

    it("GET lookup stays public even when an operatorToken is configured", async () => {
      const svc = makeServices();
      const app = Fastify();
      await registerRegistryRoutes(app, svc);
      const res = await app.inject({
        method: "GET",
        url: "/v1/merchants/merchant::1220",
      });
      // 404 (not registered) — the point is it's NOT 401/503; no auth needed.
      expect(res.statusCode).toBe(404);
    });
  });

  describe("GET /v1/merchants/:party/preapproval-status", () => {
    const scanKind = (kind: string) =>
      ({
        resolveTransferKind: vi.fn(async () => kind),
      }) as unknown as RegistryRouteServices["scan"];

    describe("a registry token's preapproval is read from the ledger", () => {
      const USDCX = "decentralized-usdc-interchain-rep::12208115";
      const REG = "https://api.utilities.digitalasset.com";
      const url = (admin: string, id: string) =>
        `/v1/merchants/merchant::1220m/preapproval-status?admin=${encodeURIComponent(admin)}&id=${id}`;
      const preapproval = (over: Record<string, unknown> = {}) => ({
        contractId: "00pre",
        templateId: "#utility-registry-app-v0:Utility.Registry.App.V0.Model.TransferPreapproval:TransferPreapproval",
        createArgument: { operator: "op::1220", receiver: "merchant::1220m", instrumentAdmin: USDCX, instrumentAllowances: [], ...over },
      });
      const build = async (client: unknown, scan?: unknown) => {
        const resolveTransferKind = vi.fn(async () => "direct");
        const getTransferPreapprovalByParty = vi.fn(async () => ({ receiver: "merchant::1220m", expiresAt: "2020-01-01T00:00:00.000Z" }));
        const app = Fastify();
        await registerRegistryRoutes(
          app,
          makeServices({
            scan: (scan ?? { resolveTransferKind, getTransferPreapprovalByParty }) as unknown as RegistryRouteServices["scan"],
            tokenRegistries: { [USDCX]: REG },
            client: client as RegistryRouteServices["client"],
          })
        );
        return { app, resolveTransferKind, getTransferPreapprovalByParty };
      };

      it("a party hosted here with the registry's TransferPreapproval is preapproved, no Scan, no CC expiry", async () => {
        const queryActiveContracts = vi.fn(async () => [preapproval()]);
        const { app, resolveTransferKind, getTransferPreapprovalByParty } = await build({ queryActiveContracts });
        const res = await app.inject({ method: "GET", url: url(USDCX, "USDCx") });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body).toMatchObject({ instrumentId: { admin: USDCX, id: "USDCx" }, transferKind: "direct", hasPreapproval: true });
        expect(body.expiresAt).toBeUndefined();
        // The registry's transfer-factory cannot answer without the sender's
        // holdings, and the Canton Coin record says nothing about USDCx.
        expect(resolveTransferKind).not.toHaveBeenCalled();
        expect(getTransferPreapprovalByParty).not.toHaveBeenCalled();
        const filter = JSON.stringify((queryActiveContracts.mock.calls[0] as unknown[])[0]);
        expect(filter).toContain("merchant::1220m");
        expect(filter).toContain("Utility.Registry.App.V0.Model.TransferPreapproval");
      });

      it("no preapproval for THIS registrar is no preapproval, and the guidance names the token", async () => {
        const queryActiveContracts = vi.fn(async () => [preapproval({ instrumentAdmin: "cbtc-network::1220" })]);
        const { app } = await build({ queryActiveContracts });
        const body = (await app.inject({ method: "GET", url: url(USDCX, "USDCx") })).json();
        expect(body).toMatchObject({ transferKind: "offer", hasPreapproval: false });
        expect(body.guidance).toContain("USDCx");
        expect(body.guidance).not.toContain("Canton Coin");
      });

      it("an allowance list covers only the instruments it names", async () => {
        const named = vi.fn(async () => [preapproval({ instrumentAllowances: [{ instrumentId: { admin: USDCX, id: "USDCx" } }] })]);
        expect((await (await build({ queryActiveContracts: named })).app.inject({ method: "GET", url: url(USDCX, "USDCx") })).json().hasPreapproval).toBe(true);
        const other = vi.fn(async () => [preapproval({ instrumentAllowances: [{ instrumentId: { admin: USDCX, id: "OTHER" } }] })]);
        expect((await (await build({ queryActiveContracts: other })).app.inject({ method: "GET", url: url(USDCX, "USDCx") })).json().hasPreapproval).toBe(false);
      });

      it("the ledger read is rate limited per caller", async () => {
        const queryActiveContracts = vi.fn(async () => []);
        const { app } = await build({ queryActiveContracts });
        for (let i = 0; i < 30; i++) {
          expect((await app.inject({ method: "GET", url: url(USDCX, "USDCx") })).statusCode).toBe(200);
        }
        expect((await app.inject({ method: "GET", url: url(USDCX, "USDCx") })).statusCode).toBe(429);
        expect(queryActiveContracts).toHaveBeenCalledTimes(30);
      });

      it("reads on the participant hosting the party when two are configured", async () => {
        const onPrimary = vi.fn(async () => []);
        const onSecondary = vi.fn(async () => [preapproval()]);
        const app = Fastify();
        await registerRegistryRoutes(
          app,
          makeServices({
            scan: { resolveTransferKind: vi.fn(), getTransferPreapprovalByParty: vi.fn() } as unknown as RegistryRouteServices["scan"],
            tokenRegistries: { [USDCX]: REG },
            client: { queryActiveContracts: onPrimary } as RegistryRouteServices["client"],
            router: { forParty: async () => ({ client: { queryActiveContracts: onSecondary } }) },
          })
        );
        const body = (await app.inject({ method: "GET", url: url(USDCX, "USDCx") })).json();
        expect(body).toMatchObject({ hasPreapproval: true });
        expect(onSecondary).toHaveBeenCalled();
        expect(onPrimary).not.toHaveBeenCalled();
      });

      it("a party this participant does not host is unknown, with where to look instead", async () => {
        const queryActiveContracts = vi.fn(async () => {
          throw Object.assign(new Error("HTTP 403"), { code: "HTTP_ERROR", status: 403 });
        });
        const { app } = await build({ queryActiveContracts });
        const res = await app.inject({ method: "GET", url: url(USDCX, "USDCx") });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body).toMatchObject({ transferKind: "unknown", hasPreapproval: null });
        expect(body.note).toContain("Utility.Registry.App.V0.Model.TransferPreapproval");
      });

      it("a registry token with no registry configured here is unknown, not answered from Scan", async () => {
        const resolveTransferKind = vi.fn(async () => "direct");
        const app = Fastify();
        await registerRegistryRoutes(
          app,
          makeServices({ scan: { resolveTransferKind } as unknown as RegistryRouteServices["scan"], tokenRegistries: {} })
        );
        const res = await app.inject({ method: "GET", url: url("other-registrar::1220x", "TOK") });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ transferKind: "unknown", hasPreapproval: null });
        expect(resolveTransferKind).not.toHaveBeenCalled();
      });
    });

    it("hasPreapproval=true when transferKind=direct", async () => {
      const app = Fastify();
      await registerRegistryRoutes(app, makeServices({ scan: scanKind("direct") }));
      const res = await app.inject({
        method: "GET",
        url: "/v1/merchants/merchant::1220m/preapproval-status?admin=dso::1220",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        hasPreapproval: true,
        transferKind: "direct",
      });
    });

    it("hasPreapproval=false + guidance when transferKind=offer", async () => {
      const app = Fastify();
      await registerRegistryRoutes(app, makeServices({ scan: scanKind("offer") }));
      const res = await app.inject({
        method: "GET",
        url: "/v1/merchants/merchant::1220m/preapproval-status?admin=dso::1220",
      });
      const j = res.json() as { hasPreapproval: boolean; guidance?: string };
      expect(j.hasPreapproval).toBe(false);
      expect(j.guidance).toMatch(/TransferPreapproval/);
    });

    it("400 when ?admin is missing", async () => {
      const app = Fastify();
      await registerRegistryRoutes(app, makeServices());
      const res = await app.inject({
        method: "GET",
        url: "/v1/merchants/merchant::1220m/preapproval-status",
      });
      expect(res.statusCode).toBe(400);
    });

    it("transferKind=unknown / hasPreapproval=null when the Scan resolve throws", async () => {
      const app = Fastify();
      await registerRegistryRoutes(
        app,
        makeServices({
          scan: {
            resolveTransferKind: vi.fn(async () => {
              throw new Error("UNSUPPORTED");
            }),
          } as unknown as RegistryRouteServices["scan"],
        })
      );
      const res = await app.inject({
        method: "GET",
        url: "/v1/merchants/merchant::1220m/preapproval-status?admin=dso::1220",
      });
      expect(res.statusCode).toBe(200);
      const j = res.json() as {
        transferKind: string;
        hasPreapproval: null;
        note?: string;
      };
      expect(j).toMatchObject({ transferKind: "unknown", hasPreapproval: null });
      // null must be disambiguated from "no preapproval" for operators.
      expect(j.note).toMatch(/does NOT mean/);
    });
  });

  describe("POST /v1/merchants/:party/preapproval (Phase 2)", () => {
    it("503 when disabled (default) even with operator auth", async () => {
      const app = Fastify();
      await registerRegistryRoutes(app, makeServices()); // enable flag false
      const res = await app.inject({
        method: "POST",
        url: "/v1/merchants/merchant::1220m/preapproval",
        headers: AUTH,
        payload: {},
      });
      expect(res.statusCode).toBe(503);
      expect((res.json() as { error: string }).error).toMatch(/disabled/);
    });

    it("creates the preapproval when enabled + operator-authed", async () => {
      const create = vi.fn(async () => ({
        updateId: "u-pa",
        receiver: "merchant::1220m",
        provider: "ftp_facilitator::1220fff",
        expiresAt: "2026-09-01T00:00:00Z",
      }));
      const app = Fastify();
      await registerRegistryRoutes(
        app,
        makeServices({
          enablePreapprovalProvider: true,
          preapproval: {
            createTransferPreapproval: create,
          } as unknown as RegistryRouteServices["preapproval"],
        })
      );
      const res = await app.inject({
        method: "POST",
        url: "/v1/merchants/merchant::1220m/preapproval",
        headers: AUTH,
        payload: { expiresAt: "2026-09-01T00:00:00Z" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ updateId: "u-pa" });
      expect(create).toHaveBeenCalledWith({
        merchant: "merchant::1220m",
        expiresAt: "2026-09-01T00:00:00Z",
      });
    });

    it("401 when enabled but the operator token is missing", async () => {
      const app = Fastify();
      await registerRegistryRoutes(
        app,
        makeServices({ enablePreapprovalProvider: true })
      );
      const res = await app.inject({
        method: "POST",
        url: "/v1/merchants/merchant::1220m/preapproval",
        payload: {},
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
