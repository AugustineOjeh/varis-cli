// Signing `varis test` requests, and proving to the developer's own server
// that they came from this CLI.
//
// THE PROBLEM
// Every Varis service calls `varis.verifyRequest(request)` before it does
// anything, and rejects requests Varis didn't sign. A real request is signed
// by the Varis gateway with a private key only Varis holds. `varis test`
// calls the developer's server directly, before the service is published, so
// it can't get the gateway's signature. Yet the test should still run the
// developer's verification exactly as production would, because a test that
// skipped verification wouldn't prove the handler works.
//
// THE MECHANISM
// For each test run, this file:
//   1. makes a brand-new Ed25519 key pair, used for this one request and
//      then thrown away;
//   2. signs the request with the private half, over exactly the string the
//      gateway signs: `${timestamp}.${method}.${pathAndQuery}.${rawBody}`;
//   3. sends it with the key ID `varis-test` and a request ID prefixed
//      `var_tst_req_`;
//   4. meanwhile listens on one fixed loopback address,
//      http://127.0.0.1:47823/varis-test-key, and hands out the public half,
//      but only when asked for the request ID it just sent.
//
// When the SDK's verifyRequest sees the `varis-test` key ID, it fetches the
// public key from that loopback address and checks the signature with it.
// See packages/sdk/src/verify.ts in the varis-ts repository.
//
// WHY THIS IS SAFE
// The fixed loopback address is the whole guarantee. 127.0.0.1 always means
// "this same machine", so only a program on the provider's own machine can
// answer there. On the developer's laptop, that's this CLI, during a test.
// On a production server, nothing listens there, so a test request can
// never verify, whatever an attacker sends and wherever they send it from.
//
// Two tempting alternatives were rejected:
//   - Letting the request say where to fetch the key from. An attacker would
//     point it at their own server, serve their own key, and forge requests
//     that verify anywhere.
//   - Accepting requests whose Host is localhost. The Host header is written
//     by the caller, so anyone could claim to be local.
//
// WHERE IT CAN'T WORK
// The server and this CLI must share a loopback. They don't when the server
// runs in a Docker container and the CLI on the host, or with
// `wrangler dev --remote`, which runs on Cloudflare's machines. Then the SDK
// can't reach this listener, the signature can't be checked, and the test
// fails with a 401. It fails safe: nothing is ever accepted that shouldn't
// be. src/commands/test.ts explains the likely cause when that happens.
//
// KEEP IN STEP WITH THE SDK
// TEST_KEY_ID, TEST_REQUEST_ID_PREFIX, and the listener's host, port, and
// path must match packages/sdk/src/constants.ts in varis-ts exactly.

import {
  generateKeyPairSync,
  type KeyObject,
  randomUUID,
  sign,
} from "node:crypto";
import { createServer, type Server } from "node:http";

/** The key ID on every test request. The SDK routes on it. */
export const TEST_KEY_ID = "varis-test";

/**
 * Every test request ID starts with this. Gateway request IDs start with
 * `var_req_`, so providers can tell a test apart in their logs, and the SDK
 * rejects a request whose key ID and request ID prefix disagree.
 */
export const TEST_REQUEST_ID_PREFIX = "var_tst_req_";

/**
 * Where the listener serves the public key. Loopback only (never 0.0.0.0),
 * so nothing off this machine can reach it. The port is fixed because the
 * SDK has to know it in advance: the address can't travel with the request,
 * or an attacker could change it.
 */
export const LISTENER_HOST = "127.0.0.1";
export const LISTENER_PORT = 47823;
export const LISTENER_PATH = "/varis-test-key";

/** Everything needed to sign and vouch for one test request. */
export type TestSigner = {
  requestId: string;
  /** The public key, as the listener serves it: SPKI PEM. */
  publicKeyPem: string;
  /** The signature headers for the exact bytes about to be sent. */
  sign: (request: SignedRequest) => Record<string, string>;
};

export type SignedRequest = {
  method: "GET" | "POST";
  /** The path and query exactly as sent, for example "/v1/weather?city=Lagos". */
  pathAndQuery: string;
  /** The exact body bytes sent. Empty for GET. */
  rawBody: string;
};

/**
 * The string the signature covers. Identical to the gateway's
 * (lib/crypto/signing.ts in the varis repository), so a test exercises the
 * same verification a real call does.
 */
export function signedString(timestamp: string, request: SignedRequest): string {
  return `${timestamp}.${request.method}.${request.pathAndQuery}.${request.rawBody}`;
}

/**
 * A fresh key pair and request ID for one test. Nothing is written to disk;
 * when the test ends, the private key is gone.
 */
export function createTestSigner(): TestSigner {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const requestId = `${TEST_REQUEST_ID_PREFIX}${randomUUID()}`;

  return {
    requestId,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    sign: (request) => signHeaders(privateKey, requestId, request),
  };
}

function signHeaders(
  privateKey: KeyObject,
  requestId: string,
  request: SignedRequest,
): Record<string, string> {
  // Whole seconds, as the gateway sends. The SDK rejects a timestamp more
  // than 300 seconds from its own clock.
  const timestamp = Math.floor(Date.now() / 1000).toString();
  // Ed25519 takes no separate digest algorithm, hence null.
  const signature = sign(
    null,
    Buffer.from(signedString(timestamp, request)),
    privateKey,
  ).toString("base64");

  return {
    "X-Varis-Timestamp": timestamp,
    "X-Varis-Signature": signature,
    "X-Varis-Key-Id": TEST_KEY_ID,
    "X-Varis-Request-Id": requestId,
  };
}

/**
 * A running listener. Always close it: an open listener keeps the process
 * alive and holds the port for the next test.
 */
export type TestKeyListener = {
  /** How many times the key was fetched, so a failure can say whether the server asked. */
  fetches: () => number;
  close: () => Promise<void>;
};

export type ListenResult =
  | { ok: true; listener: TestKeyListener }
  /** The port is taken, most likely by another varis test still running. */
  | { ok: false; reason: "port_in_use" | "failed"; message: string };

/**
 * Serves `signer`'s public key at the fixed loopback address, for its
 * request ID only. Every other path or request ID gets a 404, so the
 * listener confirms exactly one request and nothing else.
 */
export function listenForKeyRequests(
  signer: TestSigner,
  port = LISTENER_PORT,
): Promise<ListenResult> {
  let fetches = 0;

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${LISTENER_HOST}`);
    const asked = url.searchParams.get("request_id");

    if (
      request.method !== "GET" || url.pathname !== LISTENER_PATH ||
      asked !== signer.requestId
    ) {
      response.writeHead(404, { "Content-Type": "text/plain" }).end("unknown");
      return;
    }

    fetches++;
    response
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ kid: TEST_KEY_ID, public_key_pem: signer.publicKeyPem }));
  });

  return new Promise((resolve) => {
    server.once("error", (error: Error & { code?: string }) => {
      resolve(
        error.code === "EADDRINUSE"
          ? {
            ok: false,
            reason: "port_in_use",
            message:
              `Port ${port} on ${LISTENER_HOST} is in use, probably by another varis test still running. Wait for it to finish, then try again.`,
          }
          : { ok: false, reason: "failed", message: error.message },
      );
    });

    server.listen(port, LISTENER_HOST, () => {
      resolve({
        ok: true,
        listener: {
          fetches: () => fetches,
          close: () =>
            new Promise<void>((done) => {
              // Drop idle keep-alive connections too, so close resolves now
              // rather than when the server's connection times out.
              server.closeAllConnections?.();
              server.close(() => done());
            }),
        },
      });
    });
  });
}
