// Tests for varis test. Most run a whole test call for real: a provider
// server on a spare port, the real loopback key listener, and a verifier
// that checks the signature the way @usevaris/sdk's verifyRequest does.
// Only the listener's port differs from production, so parallel test files
// don't collide on 47823.

import { verify } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTest, type TestDeps } from "../src/commands/test.ts";
import type { Output } from "../src/lib/output.ts";
import {
  createTestSigner,
  LISTENER_PATH,
  listenForKeyRequests,
  signedString,
  TEST_KEY_ID,
  TEST_REQUEST_ID_PREFIX,
} from "../src/lib/test-signing.ts";

const WEATHER = {
  slug: "weather",
  endpoint_url: "https://api.example.com/v1/weather",
  method: "GET",
  input_schema: {
    type: "object",
    properties: { city: { type: "string" }, days: { type: "integer" } },
    required: ["city"],
  },
  output_schema: {
    type: "object",
    properties: { temp_c: { type: "number" } },
    required: ["temp_c"],
  },
};

const SUMMARISE = {
  slug: "summarise",
  endpoint_url: "https://api.example.com/v1/summarise",
  method: "POST",
  input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  output_schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
};

const PING = {
  slug: "ping",
  endpoint_url: "https://api.example.com/ping",
  method: "GET",
  input_schema: { type: "object", properties: {} },
  output_schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
};

/** A free port, found by letting the OS pick one and releasing it. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

type Seen = { method: string; url: string; headers: IncomingMessage["headers"]; body: string };

/**
 * What the provider's handler does with a verified request. Returns the
 * status and JSON body to answer with.
 */
type Handler = (seen: Seen) => { status: number; body: unknown; headers?: Record<string, string> };

/**
 * A provider server. With `verifies`, it checks each request as the SDK
 * does: the test key ID must come with a test request ID, the public key is
 * fetched from the listener for that request ID, and the signature must
 * cover the timestamp, method, path and query, and body. A request that
 * fails gets a 401, as a handler calling verifyRequest would send.
 */
function provider(keyPort: number, handler: Handler, verifies = true) {
  const seen: Seen[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const current: Seen = {
      method: request.method!,
      url: request.url!,
      headers: request.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    };
    seen.push(current);

    if (verifies && !(await verifies_(current, keyPort))) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorised" }));
      return;
    }

    const answer = handler(current);
    response.writeHead(answer.status, { "Content-Type": "application/json", ...answer.headers });
    response.end(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body));
  });
  return { server, seen };
}

/** The SDK's verifyRequest, cut down to the test-key path. */
async function verifies_(seen: Seen, keyPort: number): Promise<boolean> {
  const keyId = seen.headers["x-varis-key-id"];
  const requestId = String(seen.headers["x-varis-request-id"] ?? "");
  if (keyId !== TEST_KEY_ID || !requestId.startsWith(TEST_REQUEST_ID_PREFIX)) return false;

  const answer = await fetch(
    `http://127.0.0.1:${keyPort}${LISTENER_PATH}?request_id=${encodeURIComponent(requestId)}`,
  );
  if (!answer.ok) return false;
  const key = (await answer.json()) as { kid: string; public_key_pem: string };
  if (key.kid !== TEST_KEY_ID) return false;

  const message = signedString(String(seen.headers["x-varis-timestamp"]), {
    method: seen.method as "GET" | "POST",
    pathAndQuery: seen.url,
    rawBody: seen.body,
  });
  return verify(
    null,
    Buffer.from(message),
    key.public_key_pem,
    Buffer.from(String(seen.headers["x-varis-signature"]), "base64"),
  );
}

let project: string;
let keyPort: number;
const servers: Server[] = [];

beforeEach(async () => {
  project = await mkdtemp(path.join(os.tmpdir(), "varis-cli-test-"));
  keyPort = await freePort();
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) => new Promise<void>((done) => {
        s.closeAllConnections();
        s.close(() => done());
      }),
    ),
  );
  await rm(project, { recursive: true, force: true });
});

/** Starts a provider and returns its base URL. */
async function start(p: ReturnType<typeof provider>): Promise<string> {
  servers.push(p.server);
  await new Promise<void>((done) => p.server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(p.server.address() as AddressInfo).port}`;
}

async function manifest(testBaseUrl: string | undefined, services: object[] = [WEATHER, SUMMARISE, PING]) {
  await writeFile(
    path.join(project, "varis.json"),
    JSON.stringify({
      owner_id: "var_ownr_aaaaaaaaaaaaaa",
      base_url: "https://api.example.com",
      ...(testBaseUrl !== undefined && { test_base_url: testBaseUrl }),
      services,
    }),
  );
}

async function run(args: string[], overrides: Partial<TestDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const output: Output = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    status: () => {},
    styled: false,
  };
  const deps: TestDeps = {
    cwd: project,
    fetch,
    createSigner: createTestSigner,
    listen: (signer) => listenForKeyRequests(signer, keyPort),
    now: () => 0,
    ...overrides,
  };
  const code = await runTest(args, output, deps);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("varis test", () => {
  it("passes a GET service whose server verifies the request and answers to schema", async () => {
    const p = provider(keyPort, () => ({ status: 200, body: { temp_c: 21.5 } }));
    await manifest(await start(p));

    const result = await run(["weather", "--input", '{"city":"Lagos","days":2}']);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ temp_c: 21.5 });
    expect(result.err).toContain("weather passed");
    // The request went to test_base_url plus the endpoint's path, with the
    // input as the gateway encodes it: sorted keys, in the query string.
    expect(p.seen).toHaveLength(1);
    expect(p.seen[0]!.method).toBe("GET");
    expect(p.seen[0]!.url).toBe("/v1/weather?city=Lagos&days=2");
    expect(p.seen[0]!.body).toBe("");
    expect(p.seen[0]!.headers["content-type"]).toBeUndefined();
    expect(p.seen[0]!.headers["x-varis-request-id"]).toMatch(/^var_tst_req_/);
  });

  it("passes a POST service, signing and sending the same body bytes", async () => {
    const p = provider(keyPort, (seen) => ({
      status: 200,
      body: { summary: (JSON.parse(seen.body) as { text: string }).text.slice(0, 5) },
    }));
    await manifest(await start(p));

    const result = await run(["summarise", "--input", '{"text":"Hello, world"}']);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ summary: "Hello" });
    expect(p.seen[0]!.url).toBe("/v1/summarise");
    expect(p.seen[0]!.body).toBe('{"text":"Hello, world"}');
    expect(p.seen[0]!.headers["content-type"]).toBe("application/json");
  });

  it("sends {} to a service with no required input when no input is given", async () => {
    const p = provider(keyPort, () => ({ status: 200, body: { ok: true } }));
    await manifest(await start(p));

    const result = await run(["ping"]);

    expect(result.code).toBe(0);
    expect(p.seen[0]!.url).toBe("/ping");
  });

  it("reads the input from a file", async () => {
    const p = provider(keyPort, () => ({ status: 200, body: { temp_c: 3 } }));
    await manifest(await start(p));
    await writeFile(path.join(project, "input.json"), '{"city":"Oslo"}');

    const result = await run(["weather", "--input-file", "input.json"]);

    expect(result.code).toBe(0);
    expect(p.seen[0]!.url).toBe("/v1/weather?city=Oslo");
  });

  it("reports an output that breaks the schema, with each problem", async () => {
    const p = provider(keyPort, () => ({ status: 200, body: { temp_c: "warm", extra: 1 } }));
    await manifest(await start(p));

    const result = await run(["weather", "--input", '{"city":"Lagos"}']);

    expect(result.code).toBe(1);
    expect(result.out).toBe("");
    expect(result.err).toContain("doesn't match weather's output schema");
    expect(result.err).toContain("/temp_c  must be number");
    expect(result.err).toContain('"temp_c": "warm"');
  });

  it("reports an answer that isn't JSON", async () => {
    const p = provider(keyPort, () => ({ status: 200, body: "<html>hi</html>" }));
    await manifest(await start(p));

    const result = await run(["weather", "--input", '{"city":"Lagos"}']);

    expect(result.code).toBe(1);
    expect(result.err).toContain("not with JSON");
    expect(result.err).toContain("<html>hi</html>");
  });

  it("reports another status with its body", async () => {
    const p = provider(keyPort, () => ({ status: 500, body: { error: "database down" } }));
    await manifest(await start(p));

    const result = await run(["weather", "--input", '{"city":"Lagos"}']);

    expect(result.code).toBe(1);
    expect(result.err).toContain("answered 500");
    expect(result.err).toContain("database down");
  });

  it("reports a redirect instead of following it", async () => {
    const p = provider(keyPort, () => ({
      status: 302,
      body: {},
      headers: { Location: "https://elsewhere.example.com/" },
    }));
    await manifest(await start(p));

    const result = await run(["weather", "--input", '{"city":"Lagos"}']);

    expect(result.code).toBe(1);
    expect(result.err).toContain("redirected (302) to https://elsewhere.example.com/");
  });

  it("explains a 401 when the server never fetched the key", async () => {
    // A server that rejects without asking: no verifyRequest, an old SDK,
    // or no way to reach this machine's loopback.
    const p = provider(keyPort, () => ({ status: 401, body: { error: "unauthorised" } }), false);
    await manifest(await start(p));

    const result = await run(["weather", "--input", '{"city":"Lagos"}']);

    expect(result.code).toBe(1);
    expect(result.err).toContain("never fetched the test key");
    expect(result.err).toContain("Docker");
  });

  it("explains a 401 when the key was fetched but the signature didn't match", async () => {
    const p = provider(keyPort, () => ({ status: 200, body: { temp_c: 1 } }));
    await manifest(await start(p));

    // A signer whose signature covers a different path, as if middleware
    // had rewritten the request before verifyRequest saw it.
    const result = await run(["weather", "--input", '{"city":"Lagos"}'], {
      createSigner: () => {
        const real = createTestSigner();
        return { ...real, sign: (r) => real.sign({ ...r, pathAndQuery: "/rewritten" }) };
      },
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain("fetched the test key, but the signature didn't match");
  });

  it("stops before sending an input that breaks the schema", async () => {
    const p = provider(keyPort, () => ({ status: 200, body: { temp_c: 1 } }));
    await manifest(await start(p));

    const result = await run(["weather", "--input", '{"days":"two"}']);

    expect(result.code).toBe(1);
    expect(result.err).toContain("nothing was sent");
    expect(result.err).toContain("/city  is required");
    expect(result.err).toContain("/days  must be integer");
    expect(p.seen).toHaveLength(0);
  });

  it("names the required fields when no input is given", async () => {
    await manifest("http://127.0.0.1:1");

    const result = await run(["weather"]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("weather needs input: city");
    expect(result.err).toContain(`varis test weather --input '{"city":"…"}'`);
  });

  it("rejects input that isn't JSON", async () => {
    await manifest("http://127.0.0.1:1");

    const result = await run(["weather", "--input", "{city:Lagos}"]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("isn't valid JSON");
  });

  it("says how to set test_base_url when it's missing, and never falls back to production", async () => {
    await manifest(undefined);
    let called = false;

    const result = await run(["weather", "--input", '{"city":"Lagos"}'], {
      fetch: (async () => {
        called = true;
        throw new Error("unreachable");
      }) as typeof fetch,
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain("No test_base_url");
    expect(result.err).toContain("varis init --test-base-url http://localhost:3000");
    expect(called).toBe(false);
  });

  it("says to run varis build for an unknown slug", async () => {
    await manifest("http://127.0.0.1:1");

    const result = await run(["nope"]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("no service with the slug nope");
    expect(result.err).toContain("varis build");
  });

  it("says to run varis init when there's no varis.json", async () => {
    const result = await run(["weather"]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("Run varis init first");
  });

  it("reports a server that isn't running", async () => {
    // A port that was free a moment ago, so nothing answers.
    await manifest(`http://127.0.0.1:${await freePort()}`);

    const result = await run(["weather", "--input", '{"city":"Lagos"}']);

    expect(result.code).toBe(1);
    expect(result.err).toContain("Couldn't reach your server");
  });

  it("reports a busy listener port without sending anything", async () => {
    const p = provider(keyPort, () => ({ status: 200, body: { temp_c: 1 } }));
    await manifest(await start(p));
    const blocker = createServer();
    servers.push(blocker);
    await new Promise<void>((done) => blocker.listen(keyPort, "127.0.0.1", done));

    const result = await run(["weather", "--input", '{"city":"Lagos"}']);

    expect(result.code).toBe(1);
    expect(result.err).toContain(`Port ${keyPort}`);
    expect(p.seen).toHaveLength(0);
  });

  it("frees the listener port after every run", async () => {
    const p = provider(keyPort, () => ({ status: 500, body: {} }));
    await manifest(await start(p));

    await run(["weather", "--input", '{"city":"Lagos"}']);
    const again = await run(["weather", "--input", '{"city":"Lagos"}']);

    expect(again.err).not.toContain(`Port ${keyPort}`);
    expect(p.seen).toHaveLength(2);
  });

  it("rejects a usage mistake", async () => {
    expect((await run([])).code).toBe(2);
    expect((await run(["a", "b"])).code).toBe(2);
    expect((await run(["a", "--input", "{}", "--input-file", "x"])).code).toBe(2);
  });
});

describe("the key listener", () => {
  it("serves the key only for the request it signed", async () => {
    const signer = createTestSigner();
    const listening = await listenForKeyRequests(signer, keyPort);
    if (!listening.ok) throw new Error(listening.message);
    try {
      const base = `http://127.0.0.1:${keyPort}${LISTENER_PATH}`;
      const right = await fetch(`${base}?request_id=${signer.requestId}`);
      const wrong = await fetch(`${base}?request_id=${TEST_REQUEST_ID_PREFIX}other`);
      const elsewhere = await fetch(`http://127.0.0.1:${keyPort}/?request_id=${signer.requestId}`);

      expect(right.status).toBe(200);
      expect(await right.json()).toEqual({ kid: TEST_KEY_ID, public_key_pem: signer.publicKeyPem });
      expect(wrong.status).toBe(404);
      expect(elsewhere.status).toBe(404);
      expect(listening.listener.fetches()).toBe(1);
    } finally {
      await listening.listener.close();
    }
  });
});
