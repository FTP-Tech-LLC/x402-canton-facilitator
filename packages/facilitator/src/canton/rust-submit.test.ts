import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CantonClient,
  CantonError,
  type JsCommandsBody,
  type TransactionResult,
} from "@ftptech/x402-canton-ledger";
import { provesNothingCommitted } from "../rate-limit.js";
import { FaucetPreSubmitError, FaucetService } from "./faucet.js";
import { createRustSubmit } from "./rust-submit.js";

const COMMANDS = {
  commandId: "faucet-1",
  userId: "user-1",
  actAs: ["ftp::1220aa"],
  synchronizerId: "global-domain::1220bb",
  disclosedContracts: [
    {
      templateId: "#splice-amulet:Splice.AmuletRules:AmuletRules",
      contractId: "00cc",
      createdEventBlob: "CgM=",
      synchronizerId: "global-domain::1220bb",
    },
  ],
  commands: [
    {
      ExerciseCommand: {
        templateId: "#splice-api-token-transfer-instruction-v1:M:TransferFactory",
        contractId: "00dd",
        choice: "TransferFactory_Transfer",
        choiceArgument: {
          expectedAdmin: "dso::1220ee",
          transfer: { amount: "0.2", inputHoldingCids: ["00ff"], meta: { values: {} } },
          extraArgs: { context: { values: { flag: { tag: "AV_Bool", value: true } } } },
        },
      },
    },
  ],
} as unknown as JsCommandsBody;

const dir = mkdtempSync(join(tmpdir(), "grant-sender-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let fakes = 0;
/** An executable standing in for the binary: `source` is its whole script. */
function rawFake(source: string): string {
  const bin = join(dir, `fake-${fakes++}`);
  writeFileSync(bin, `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
  return bin;
}

/** A fake that reads stdin, records what it was given, then runs `then`. */
function fake(then: string): { bin: string; seenPath: string } {
  const seenPath = join(dir, `seen-${fakes}`);
  const bin = rawFake(`
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      const seen = { input: JSON.parse(input), env: process.env, argv: process.argv.slice(2) };
      require("node:fs").writeFileSync(${JSON.stringify(seenPath)}, JSON.stringify(seen));
      ${then}
    });
  `);
  return { bin, seenPath };
}

const answering = (outcome: unknown) => fake(`console.log(${JSON.stringify(JSON.stringify(outcome))});`);

const submitThrough = (bin: string, over: { timeoutMs?: number; killGraceMs?: number } = {}) =>
  createRustSubmit({ participantUrl: "http://participant", token: "tok", bin, ...over })(COMMANDS);

const failureOf = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => {
      throw new Error("expected a failure");
    },
    (err: unknown) => err
  );

describe("createRustSubmit", () => {
  it("hands over the request on stdin, with an empty environment and no arguments", async () => {
    const { bin, seenPath } = answering({ result: "committed", updateId: "u-1", offset: 7 });
    await expect(submitThrough(bin)).resolves.toEqual({ updateId: "u-1", offset: 7, events: [] });
    expect(JSON.parse(readFileSync(seenPath, "utf8"))).toEqual({
      input: {
        participantUrl: "http://participant",
        token: "tok",
        timeoutMs: 45_000,
        commands: COMMANDS,
      },
      env: {},
      argv: [],
    });
  });

  it("asks a token provider on every submission", async () => {
    const { bin, seenPath } = answering({ result: "committed", updateId: "u-1", offset: 1 });
    const token = vi.fn(async () => "fresh-token");
    await createRustSubmit({ participantUrl: "http://participant", token, bin })(COMMANDS);
    expect(token).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(seenPath, "utf8")).input.token).toBe("fresh-token");
  });

  it("turns a participant's refusal into the CantonError the client throws", async () => {
    const { bin } = answering({ result: "http", status: 409, body: "LOCKED_CONTRACTS" });
    const err = (await failureOf(submitThrough(bin))) as CantonError;
    expect(err).toBeInstanceOf(CantonError);
    expect(err).toMatchObject({ code: "HTTP_ERROR", status: 409, responseBody: "LOCKED_CONTRACTS" });
    expect(provesNothingCommitted(err)).toBe(true);
  });

  it("keeps as much of an error body as the client does", async () => {
    const { bin } = answering({ result: "http", status: 400, body: "x".repeat(5_000) });
    const err = (await failureOf(submitThrough(bin))) as CantonError;
    expect(err.responseBody).toHaveLength(1024);
  });

  it.each([408, 429, 500, 503])("HTTP %i proves nothing", async (status) => {
    const { bin } = answering({ result: "http", status, body: "" });
    const err = await failureOf(submitThrough(bin));
    expect(err).toMatchObject({ code: "HTTP_ERROR", status });
    expect(provesNothingCommitted(err)).toBe(false);
  });

  it.each(["TIMEOUT", "TRANSPORT_ERROR", "INVALID_RESPONSE"])("%s proves nothing", async (code) => {
    const { bin } = answering({ result: "failed", code, message: "lost" });
    const err = await failureOf(submitThrough(bin));
    expect(err).toBeInstanceOf(CantonError);
    expect(err).toMatchObject({ code });
    expect(provesNothingCommitted(err)).toBe(false);
  });

  it.each([
    ["a crash", "process.exit(101);"],
    ["a crash after an answer", `console.log('{"result":"http","status":400,"body":""}'); process.exit(1);`],
    ["a signal", `process.kill(process.pid, "SIGKILL");`],
  ])("%s proves nothing", async (_, then) => {
    const err = await failureOf(submitThrough(fake(then).bin));
    expect(err).toMatchObject({ code: "TRANSPORT_ERROR" });
    expect(err).not.toBeInstanceOf(FaucetPreSubmitError);
    expect(provesNothingCommitted(err)).toBe(false);
  });

  it.each([
    ["no output", ""],
    ["garbage", `console.log("not json");`],
    ["a bare value", `console.log("7");`],
    ["a commit with no update id", `console.log('{"result":"committed"}');`],
    ["a commit with an empty update id", `console.log('{"result":"committed","updateId":""}');`],
    ["a status that is not a number", `console.log('{"result":"http","status":"400"}');`],
    ["an unknown result", `console.log('{"result":"refused"}');`],
  ])("%s proves nothing", async (_, then) => {
    const err = await failureOf(submitThrough(fake(then).bin));
    expect(err).toMatchObject({ code: "INVALID_RESPONSE" });
    expect(provesNothingCommitted(err)).toBe(false);
  });

  it("exit code 2 is the binary refusing the request: it sent nothing", async () => {
    const err = await failureOf(submitThrough(fake("process.exit(2);").bin));
    expect(err).toBeInstanceOf(FaucetPreSubmitError);
  });

  it("names the exit code and the signal of a binary that died", async () => {
    const died = (await failureOf(submitThrough(fake("process.exit(101);").bin))) as Error;
    expect(died.message).toContain("exit 101");
    const killed = await failureOf(submitThrough(fake(`process.kill(process.pid, "SIGKILL");`).bin));
    expect((killed as Error).message).toContain("signal SIGKILL");
  });

  it("kills a binary that hangs, and that proves nothing", async () => {
    const { bin } = fake("setInterval(() => undefined, 1000);");
    const err = await failureOf(submitThrough(bin, { timeoutMs: 200, killGraceMs: 200 }));
    expect(err).toMatchObject({ code: "TIMEOUT" });
    expect(provesNothingCommitted(err)).toBe(false);
  });

  it("survives a binary that exits without reading stdin", async () => {
    // Node raises EPIPE on the stdin stream. Without a listener that event is
    // an uncaught exception, here and in the facilitator: vitest fails the run.
    const bin = rawFake("process.exit(0);");
    const big = { ...COMMANDS, commandId: "x".repeat(8_000_000) };
    const submit = createRustSubmit({ participantUrl: "http://participant", token: "tok", bin });
    const err = await failureOf(submit(big));
    expect(err).toBeInstanceOf(CantonError);
    expect(provesNothingCommitted(err)).toBe(false);
  });

  it("a binary that is not there sent nothing", async () => {
    const err = await failureOf(submitThrough(join(dir, "missing")));
    expect(err).toBeInstanceOf(FaucetPreSubmitError);
  });

  it("a binary that cannot be executed sent nothing", async () => {
    const bin = join(dir, "not-executable");
    writeFileSync(bin, "", { mode: 0o644 });
    expect(await failureOf(submitThrough(bin))).toBeInstanceOf(FaucetPreSubmitError);
  });

  it("a spawn refused synchronously sent nothing", async () => {
    expect(await failureOf(submitThrough("bad\0path"))).toBeInstanceOf(FaucetPreSubmitError);
  });

  it("a token that cannot be had sent nothing, and the binary never runs", async () => {
    const { bin, seenPath } = answering({ result: "committed", updateId: "u-1", offset: 1 });
    const token = vi.fn(async () => {
      throw new Error("keycloak down");
    });
    const submit = createRustSubmit({ participantUrl: "http://participant", token, bin });
    expect(await failureOf(submit(COMMANDS))).toBeInstanceOf(FaucetPreSubmitError);
    expect(existsSync(seenPath)).toBe(false);
  });
});

const realBin = process.env.GRANT_SENDER_BIN;

describe.skipIf(!realBin)("the real binary against CantonClient", () => {
  const TOKEN = "tok-parity";
  let reply: { status: number; body: string } | "hang";
  let requests: unknown[] = [];
  let server: Server;
  let participantUrl: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        requests.push({
          method: req.method,
          url: req.url,
          authorization: req.headers.authorization,
          contentType: req.headers["content-type"],
          body: JSON.parse(body),
        });
        if (reply !== "hang") res.writeHead(reply.status).end(reply.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    participantUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const outcome = (p: Promise<TransactionResult>) =>
    p.then(
      (result) => ({ result }),
      (err: CantonError) => ({ code: err.code, status: err.status, responseBody: err.responseBody })
    );

  const both = async (url: string, timeoutMs = 5_000) => {
    requests = [];
    const client = new CantonClient({
      participantUrl: url,
      token: TOKEN,
      packageName: "canton-x402",
      timeoutMs,
    });
    const rust = createRustSubmit({ participantUrl: url, token: TOKEN, bin: realBin!, timeoutMs });
    return {
      ts: await outcome(client.submitAndWaitForTransaction(COMMANDS)),
      rust: await outcome(rust(COMMANDS)),
    };
  };

  const committed = JSON.stringify({
    transaction: {
      updateId: "1220update",
      commandId: "faucet-1",
      workflowId: "",
      effectiveAt: "2026-10-31T12:00:00Z",
      offset: 42,
      synchronizerId: "global-domain::1220bb",
      recordTime: "2026-10-31T12:00:01Z",
      traceContext: { traceparent: "00-a-b-01" },
      events: [],
    },
  });

  it("sends the same request", async () => {
    reply = { status: 200, body: committed };
    await both(participantUrl);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: "/v2/commands/submit-and-wait-for-transaction",
      authorization: `Bearer ${TOKEN}`,
      contentType: "application/json",
      body: { commands: COMMANDS },
    });
  });

  it.each([
    ["a commit", 200, committed],
    ["a commit without a transaction", 200, "{}"],
    ["UNKNOWN_INFORMEES", 400, '{"code":"UNKNOWN_INFORMEES","cause":"not known"}'],
    ["a missing contract", 404, '{"code":"CONTRACT_NOT_FOUND"}'],
    ["contention", 409, '{"code":"LOCKED_CONTRACTS"}'],
    ["rate limiting", 429, ""],
    ["a gateway error", 503, "upstream down"],
  ])("gives the same answer on %s", async (_, status, body) => {
    reply = { status, body };
    const { ts, rust } = await both(participantUrl);
    expect(rust).toEqual(ts);
  });

  it("a 200 that is not JSON proves nothing on either side", async () => {
    reply = { status: 200, body: "<html>" };
    const { ts, rust } = await both(participantUrl);
    expect(provesNothingCommitted(ts)).toBe(false);
    expect(provesNothingCommitted(rust)).toBe(false);
  });

  it("times out the same way", async () => {
    reply = "hang";
    const { ts, rust } = await both(participantUrl, 300);
    expect(ts).toMatchObject({ code: "TIMEOUT" });
    expect(rust).toEqual(ts);
  });

  it("fails the same way when nothing listens", async () => {
    const { ts, rust } = await both("http://127.0.0.1:9");
    expect(ts).toMatchObject({ code: "TRANSPORT_ERROR" });
    expect(rust).toEqual(ts);
  });

  it("refuses a command field it does not know, without sending anything", async () => {
    requests = [];
    const submit = createRustSubmit({ participantUrl, token: TOKEN, bin: realBin! });
    const err = (await failureOf(submit({ ...COMMANDS, readAs: ["other"] }))) as Error;
    expect(err).toBeInstanceOf(FaucetPreSubmitError);
    expect(err.message).toMatch(/readAs/);
    expect(err.message).not.toContain(TOKEN);
    expect(requests).toEqual([]);
  });

  it("takes the commands FaucetService really builds", async () => {
    // The field list above is a copy of what faucet.ts sends: a field added
    // there has to fail here, not on every grant in production.
    reply = { status: 200, body: committed };
    requests = [];
    const svc = new FaucetService({
      client: {
        submitAndWaitForTransaction: vi.fn(),
        queryActiveContracts: vi.fn(async () => [
          { contractId: "00amulet", createArgument: { amount: { initialAmount: "100.0" } } },
        ]),
      } as never,
      submit: createRustSubmit({ participantUrl, token: TOKEN, bin: realBin! }),
      facilitatorParty: "ftp::1220aa",
      userId: "user-1",
      synchronizerId: "global-domain::1220bb",
      amountCc: "0.2",
      getDso: async () => "dso::1220ee",
      resolveTransferFactory: async () => ({
        factoryId: "00factory",
        transferFactoryTemplateId: "#pkg:M:TransferFactory",
        choiceContextData: { values: {} },
        disclosedContracts: [],
      }),
    });
    await expect(svc.claim({ recipient: "agent::1220a" })).resolves.toMatchObject({
      updateId: "1220update",
    });
    expect(requests).toHaveLength(1);
  });
});
