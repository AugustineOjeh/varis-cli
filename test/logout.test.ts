import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type LogoutDeps, runLogout } from "../src/commands/logout.ts";
import type { ApiRequestFn, ApiResult, RequestOptions } from "../src/lib/api.ts";
import {
  type CredentialsLocation,
  credentialsPath,
  saveToken,
} from "../src/lib/credentials.ts";
import type { Output } from "../src/lib/output.ts";

const TOKEN = `var_dt_${"a".repeat(40)}`;
const LOCAL = "http://localhost:3000/api";

let home: string;
let credentials: CredentialsLocation;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "varis-cli-logout-"));
  credentials = { env: {}, platform: process.platform, home };
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function setup(answer: ApiResult<unknown>) {
  const calls: { path: string; options: RequestOptions }[] = [];
  const request = (async (_method, path, options) => {
    calls.push({ path, options });
    return answer;
  }) as ApiRequestFn;
  const out: string[] = [];
  const err: string[] = [];
  const output: Output = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    status: () => {},
    styled: false,
  };
  const deps: LogoutDeps = { credentials, request };
  return { deps, calls, out, err, output };
}

const fileExists = async () =>
  stat(credentialsPath(credentials)).then(() => true, () => false);

describe("varis logout", () => {
  it("revokes the token at the server that issued it, then deletes the file", async () => {
    await saveToken(LOCAL, TOKEN, credentials);
    const t = setup({ ok: true, status: 200, body: { signed_out: true } });

    expect(await runLogout([], t.output, t.deps)).toBe(0);

    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.path).toBe("/v1/cli/logout");
    expect(t.calls[0]!.options).toMatchObject({
      auth: "none",
      bearer: TOKEN,
      origin: LOCAL,
    });
    expect(await fileExists()).toBe(false);
    expect(t.out).toEqual(["✓ Signed out. This machine's token is revoked."]);
  });

  it("treats a token the server already refuses as signed out", async () => {
    await saveToken(LOCAL, TOKEN, credentials);
    const t = setup({
      ok: false,
      error: { kind: "rejected_token", status: 401, message: "This machine was signed out." },
    });

    expect(await runLogout([], t.output, t.deps)).toBe(0);
    expect(await fileExists()).toBe(false);
    expect(t.err).toEqual([]);
  });

  it("deletes the file even when the server can't be reached, and says the token lives on", async () => {
    await saveToken(LOCAL, TOKEN, credentials);
    const t = setup({
      ok: false,
      error: { kind: "network", message: "Couldn't reach Varis." },
    });

    expect(await runLogout([], t.output, t.deps)).toBe(0);
    expect(await fileExists()).toBe(false);
    expect(t.out).toEqual(["✓ Signed out of this machine."]);
    expect(t.err.join("\n")).toContain("stays active until it expires");
    expect(t.err.join("\n")).toContain("Settings > Devices");
  });

  it("says so when already signed out, calling nothing", async () => {
    const t = setup({ ok: true, status: 200, body: {} });
    expect(await runLogout([], t.output, t.deps)).toBe(0);
    expect(t.calls).toEqual([]);
    expect(t.out[0]).toContain("isn't signed in");
  });

  it("removes a damaged file, since it holds no token to revoke", async () => {
    const file = credentialsPath(credentials);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "garbage", { mode: 0o600 });
    const t = setup({ ok: true, status: 200, body: {} });

    expect(await runLogout([], t.output, t.deps)).toBe(0);
    expect(t.calls).toEqual([]);
    expect(await fileExists()).toBe(false);
  });

  it("rejects an unknown option", async () => {
    const t = setup({ ok: true, status: 200, body: {} });
    expect(await runLogout(["--all"], t.output, t.deps)).toBe(2);
  });
});
