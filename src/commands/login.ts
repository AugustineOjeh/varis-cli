// varis login: signs this machine in with the device flow (RFC 8628).
//
//   1. POST /v1/cli/device/code   a device code, and a user code to show
//   2. The developer opens the link and approves, in any browser, on any
//      device. That is what makes this work over SSH and in cloud editors.
//   3. POST /v1/cli/device/token  polled until approved, denied, or expired
//   4. The token is saved, replacing any earlier one, and the earlier one is
//      revoked on the server so it doesn't linger.
//
// Everything this touches is injectable, so the tests run a whole sign-in
// in milliseconds.

import { apiRequest, type ApiRequestFn } from "../lib/api.ts";
import type { Command } from "../lib/command.ts";
import { apiOrigin, type Env } from "../lib/constants.ts";
import {
  type CredentialsLocation,
  defaultLocation,
  type ReadResult,
  readToken,
  saveToken,
} from "../lib/credentials.ts";
import { canOpenBrowser, deviceName, openBrowser } from "../lib/device.ts";
import type { Output } from "../lib/output.ts";
import { bold, dim, failure, success } from "../lib/style.ts";

type DeviceCode = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};

type DeviceToken = { access_token: string; expires_in: number };

type OwnerList = { owners: { id: string; name: string; role: string }[] };

export type LoginDeps = {
  env: Env;
  credentials: CredentialsLocation;
  request: ApiRequestFn;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  canOpenBrowser: () => boolean;
  openBrowser: (url: string) => void;
};

const defaultDeps = (): LoginDeps => ({
  env: process.env,
  credentials: defaultLocation(),
  request: apiRequest,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  canOpenBrowser: () => canOpenBrowser(),
  openBrowser: (url) => openBrowser(url),
});

/** RFC 8628's default, when the server doesn't say. */
const DEFAULT_INTERVAL_SECONDS = 5;

export async function runLogin(
  args: string[],
  output: Output,
  deps: LoginDeps = defaultDeps(),
): Promise<number> {
  const unknown = args.find((arg) => arg !== "--no-browser");
  if (unknown !== undefined) {
    output.err(`Unknown option: ${unknown}. Run varis login --help.`);
    return 2;
  }

  const origin = apiOrigin(deps.env);
  const common = { env: deps.env, credentials: deps.credentials };

  // Kept to revoke once the new sign-in succeeds.
  const previous = await readToken(origin, deps.credentials);

  const started = await deps.request<DeviceCode>(
    "POST",
    "/v1/cli/device/code",
    {
      ...common,
      auth: "none",
      body: { device_name: deviceName(deps.env) },
    },
  );
  if (!started.ok) {
    output.err(`Couldn't start signing in. ${started.error.message}`);
    return 1;
  }
  const code = started.body;

  output.err("Open this link to approve signing in:");
  output.err("");
  output.err(`  ${bold(output, code.verification_uri_complete)}`);
  output.err("");
  output.err(`Check the page shows this code: ${bold(output, code.user_code)}`);

  if (!args.includes("--no-browser") && deps.canOpenBrowser()) {
    deps.openBrowser(code.verification_uri_complete);
    output.err("Opened the link in your browser.");
  }
  output.err("");

  const deadline = deps.now() + code.expires_in * 1000;
  let interval = code.interval || DEFAULT_INTERVAL_SECONDS;
  let reportedTrouble = false;

  while (deps.now() < deadline) {
    await deps.sleep(interval * 1000);

    output.status("Checking for approval…");
    const polled = await deps.request<DeviceToken>(
      "POST",
      "/v1/cli/device/token",
      { ...common, auth: "none", body: { device_code: code.device_code } },
    );

    if (polled.ok) {
      await saveToken(origin, polled.body.access_token, deps.credentials);
      output.out(success(output, "Signed in. This machine can now publish services."));
      await revokePrevious(previous, polled.body.access_token, deps);
      await showOwners(output, deps);
      return 0;
    }

    const { error } = polled;
    const serverInterval = (error.body as { interval?: unknown } | undefined)
      ?.interval;

    switch (error.code) {
      case "authorization_pending":
        if (typeof serverInterval === "number") interval = serverInterval;
        output.status(pendingMessage(interval));
        continue;
      case "slow_down":
        // RFC 8628: add 5 seconds, unless the server says exactly how long.
        interval = typeof serverInterval === "number"
          ? serverInterval
          : interval + 5;
        output.status(pendingMessage(interval));
        continue;
      case "access_denied":
        output.err(failure(output, "The sign-in was denied. Nothing was saved."));
        return 1;
      case "expired_token":
        output.err(failure(output, "The code expired. Run varis login again."));
        return 1;
      case "invalid_grant":
        output.err(
          failure(output, "This sign-in can't be completed. Run varis login again."),
        );
        return 1;
    }

    // A network blip or a server error: keep polling until the code expires,
    // and say so once rather than on every attempt.
    if (
      error.kind === "network" || error.kind === "server" ||
      error.kind === "rate_limited"
    ) {
      if (!reportedTrouble) {
        output.err(
          `Having trouble reaching Varis; still trying. ${error.message}`,
        );
        reportedTrouble = true;
      }
      continue;
    }

    output.err(failure(output, `Signing in failed. ${error.message}`));
    return 1;
  }

  output.err(failure(output, "The code expired. Run varis login again."));
  return 1;
}

function pendingMessage(intervalSeconds: number): string {
  return `Approval still pending. Checking again in ${intervalSeconds} seconds…`;
}

/**
 * Revokes the token this sign-in replaced, so the dashboard's Devices list
 * doesn't keep a dead row for this machine. Best effort: a failure leaves an
 * unused token that expires on its own, and the new sign-in already worked.
 */
async function revokePrevious(
  previous: ReadResult,
  current: string,
  deps: LoginDeps,
): Promise<void> {
  if (previous.status !== "signed_in" || previous.token === current) return;
  await deps.request("POST", "/v1/cli/logout", {
    env: deps.env,
    credentials: deps.credentials,
    auth: "none",
    bearer: previous.token,
  });
}

/**
 * Lists the owners this sign-in can publish for, with their IDs, since two
 * owners can share a name. Best effort: the sign-in has already worked.
 */
async function showOwners(output: Output, deps: LoginDeps): Promise<void> {
  const owners = await deps.request<OwnerList>("GET", "/v1/me/owners", {
    env: deps.env,
    credentials: deps.credentials,
    auth: "device",
  });
  if (!owners.ok || owners.body.owners.length === 0) return;

  output.out("");
  output.out("You can publish for:");
  for (const owner of owners.body.owners) {
    output.out(`  ${owner.name} ${dim(output, `(${owner.id})`)}`);
  }
}

export const login: Command = {
  name: "login",
  summary: "Sign in to Varis on this machine",
  usage: `Usage: varis login [--no-browser]

  Prints a link and opens it in your browser. Approve the sign-in there, and
  this machine is signed in. One sign-in covers every project on this
  machine. Signing in again replaces it.

  Over SSH or in a cloud editor, where no browser opens here, open the link
  in any browser you're signed in to Varis with.

  --no-browser  Print the link without opening a browser.`,
  run: (args, output) => runLogin(args, output),
};
