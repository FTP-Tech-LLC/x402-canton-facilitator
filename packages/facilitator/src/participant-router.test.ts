import { describe, it, expect, vi } from "vitest";
import { createParticipantRouter, participantId } from "./participant-router.js";

const node = (hosted: Set<string>, fail: false | Error = false) => ({
  getPartyDetails: vi.fn(async (party: string) => {
    if (fail) throw fail;
    return hosted.has(party) ? { isLocal: true } : { isLocal: false };
  }),
});
const unreachable = () => Object.assign(new Error("participant unreachable"), { code: "TRANSPORT_ERROR" });

describe("participant router", () => {
  it("routes a party to the participant that hosts it, primary first", async () => {
    const A = node(new Set(["old::1220a", "both::1220c"]));
    const B = node(new Set(["moved::1220b", "both::1220c"]));
    const r = createParticipantRouter({
      primary: { name: "primary", id: "https://b", client: B, userId: "b-user" },
      secondary: { name: "secondary", id: "https://a", client: A, userId: "a-user" },
    });
    expect((await r.forParty("moved::1220b")).userId).toBe("b-user");
    expect((await r.forParty("old::1220a")).userId).toBe("a-user");
    expect((await r.forParty("both::1220c")).name).toBe("primary");
  });

  it("a stranger resolves to the primary (the call fails there, as it always did) and reports not hosted", async () => {
    const r = createParticipantRouter({
      primary: { name: "primary", id: "https://b", client: node(new Set()), userId: "b" },
      secondary: { name: "secondary", id: "https://a", client: node(new Set()), userId: "a" },
    });
    expect((await r.forParty("stranger::1220")).name).toBe("primary");
    expect(await r.hosts("stranger::1220")).toBe(false);
  });

  it("remembers hosting, so a caller sweeping parties is not one lookup per request", async () => {
    const A = node(new Set(["old::1220a"]));
    const B = node(new Set());
    let t = 0;
    const r = createParticipantRouter({
      primary: { name: "primary", id: "https://b", client: B, userId: "b" },
      secondary: { name: "secondary", id: "https://a", client: A, userId: "a" },
      ttlMs: 1000,
      now: () => t,
    });
    await r.forParty("old::1220a");
    await r.forParty("old::1220a");
    expect(B.getPartyDetails).toHaveBeenCalledTimes(1);
    t = 2000; // after the TTL the participants are asked again
    await r.forParty("old::1220a");
    expect(B.getPartyDetails).toHaveBeenCalledTimes(2);
  });

  it("a failed lookup is not remembered and falls back to the primary; hosting is then unknown", async () => {
    let t = 0;
    const B = node(new Set(), unreachable());
    const A = node(new Set(), unreachable());
    const r = createParticipantRouter({
      primary: { name: "primary", id: "https://b", client: B, userId: "b" },
      secondary: { name: "secondary", id: "https://a", client: A, userId: "a" },
      unavailableMs: 10,
      now: () => t,
    });
    expect((await r.forParty("x::1220")).name).toBe("primary");
    t = 20;
    expect(await r.hosts("x::1220")).toBeUndefined();
    t = 40;
    await r.forParty("x::1220");
    expect(B.getPartyDetails).toHaveBeenCalledTimes(3); // forParty, hosts, forParty: nothing cached
  });

  it("never asks the secondary when the primary cannot answer, so a blip cannot split a co-hosted party", async () => {
    // A co-hosted payer would otherwise go to the primary for one request and
    // to the secondary for a concurrent one, and the same signed transaction
    // could be relayed through both.
    const A = node(new Set(["both::1220c"]));
    const r = createParticipantRouter({
      primary: { name: "primary", id: "https://b", client: node(new Set(), unreachable()), userId: "b" },
      secondary: { name: "secondary", id: "https://a", client: A, userId: "a" },
    });
    expect((await r.forParty("both::1220c")).name).toBe("primary");
    expect(A.getPartyDetails).not.toHaveBeenCalled();
  });

  it("keeps the last answer when a later lookup fails, instead of moving the party", async () => {
    let t = 0;
    let primaryDown = false;
    const B = {
      getPartyDetails: vi.fn(async () => {
        if (primaryDown) throw unreachable();
        return { isLocal: false };
      }),
    };
    const A = node(new Set(["old::1220a"]));
    const r = createParticipantRouter({
      primary: { name: "primary", id: "https://b", client: B, userId: "b" },
      secondary: { name: "secondary", id: "https://a", client: A, userId: "a" },
      ttlMs: 1000,
      now: () => t,
    });
    expect((await r.forParty("old::1220a")).name).toBe("secondary");
    t = 2000;
    primaryDown = true;
    expect((await r.forParty("old::1220a")).name).toBe("secondary");
    expect(await r.hosts("old::1220a")).toBe(true);
  });

  it("a hung lookup times out quickly, and the hung participant is not asked again for a while", async () => {
    let t = 0;
    const hung = { getPartyDetails: vi.fn(() => new Promise<never>(() => {})) };
    const B = node(new Set());
    const r = createParticipantRouter({
      primary: { name: "primary", id: "https://b", client: B, userId: "b" },
      secondary: { name: "secondary", id: "https://a", client: hung, userId: "a" },
      lookupTimeoutMs: 20,
      unavailableMs: 1000,
      now: () => t,
    });
    expect(await r.hosts("foreign::1220")).toBeUndefined();
    expect(hung.getPartyDetails).toHaveBeenCalledTimes(1);
    expect(await r.hosts("another::1220")).toBeUndefined();
    expect(hung.getPartyDetails).toHaveBeenCalledTimes(1); // skipped inside the window
    t = 2000;
    await r.hosts("third::1220");
    expect(hung.getPartyDetails).toHaveBeenCalledTimes(2); // asked again after it
  });

  it("a refusal about one party does not bench the participant for everyone", async () => {
    const refused = Object.assign(new Error("HTTP 400"), { code: "HTTP_ERROR", status: 400 });
    const A = {
      getPartyDetails: vi.fn(async (party: string) => {
        if (party === "odd::1220") throw refused;
        return { isLocal: party === "old::1220a" };
      }),
    };
    const r = createParticipantRouter({
      primary: { name: "primary", id: "https://b", client: node(new Set()), userId: "b" },
      secondary: { name: "secondary", id: "https://a", client: A, userId: "a" },
    });
    expect(await r.hosts("odd::1220")).toBeUndefined();
    expect((await r.forParty("old::1220a")).name).toBe("secondary");
  });

  it("finds a configured participant by its id, and nothing for an id no longer configured", () => {
    const r = createParticipantRouter({
      primary: { name: "primary", id: "https://b", client: node(new Set()), userId: "b" },
      secondary: { name: "secondary", id: "https://a", client: node(new Set()), userId: "a" },
    });
    expect(r.byId("https://a")?.name).toBe("secondary");
    expect(r.byId("https://b")?.name).toBe("primary");
    expect(r.byId("https://gone")).toBeUndefined();
  });

  it("with a single participant it is exactly the old behaviour: no lookup on the hot path", async () => {
    const only = node(new Set(["agent::1220a"]));
    const r = createParticipantRouter({ primary: { name: "primary", id: "https://b", client: only, userId: "u" } });
    expect((await r.forParty("agent::1220a")).name).toBe("primary");
    expect((await r.forParty("elsewhere::1220b")).name).toBe("primary");
    expect(only.getPartyDetails).not.toHaveBeenCalled();
    expect(await r.hosts("elsewhere::1220b")).toBe(false);
    expect(r.secondary).toBeUndefined();
  });
});

describe("participantId", () => {
  it("names one participant one way however its URL is spelled", () => {
    expect(participantId("https://Ledger.Example.com:443/")).toBe("https://ledger.example.com");
    expect(participantId("https://ledger.example.com")).toBe("https://ledger.example.com");
    expect(participantId("http://participant:7575/api/json//")).toBe("http://participant:7575/api/json");
  });
});
