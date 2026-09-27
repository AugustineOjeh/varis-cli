import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PublishDeps, runPublish } from "../src/commands/publish.ts";
import type { ApiError, ApiRequestFn, ApiResult, RequestOptions } from "../src/lib/api.ts";
import { VARIS_API_ORIGIN } from "../src/lib/constants.ts";
import { type CredentialsLocation, saveToken } from "../src/lib/credentials.ts";
import type { Runner } from "../src/lib/generator.ts";
import type { Output } from "../src/lib/output.ts";

const TOKEN = `var_dt_${"a".repeat(40)}`;
const OWNER = "var_ownr_aaaaaaaaaaaaaa";
const WEATHER = { slug: "weather", endpoint_url: "https://api.example.com/weather", price_cents: 3 };
const NEWS = { slug: "news", endpoint_url: "https://api.example.com/news", price_cents: 0 };

let project: string;
let home: string;
let credentials: CredentialsLocation;

beforeEach(async () => {
  project = await mkdtemp(path.join(os.tmpdir(), "varis-cli-publish-"));
  home = await mkdtemp(path.join(os.tmpdir(), "varis-cli-home-"));
  credentials = { env: {}, platform: process.platform, home };
  await saveToken(VARIS_API_ORIGIN, TOKEN, credentials);
  await writeFile(path.join(project, "package.json"), "{}");
});

afterEach(async () => {
  await rm(project, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

async function initialised(extra: object = {}) {
  await writeFile(
    path.join(project, "varis.json"),
    JSON.stringify({ owner_id: OWNER, services: [], ...extra }),
  );
}

/** A generator that writes `services` into varis.json, as the real one does. */
function generator(services: object[], code = 0): Runner {
  return async (_command, cwd) => {
    if (code !== 0) {
      return {
        status: "ran",
        code,
        stdout: "",
        stderr: JSON.stringify({ file: "src/a.ts", line: 3, message: "Bad." }),
      };
    }
    const file = path.join(cwd, "varis.json");
    const manifest = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...manifest, services }));
    return {
      status: "ran",
      code: 0,
      stdout: JSON.stringify({ services: services.map((s: any) => s.slug), warnings: [] }),
      stderr: "",
    };
  };
}

/** A server that remembers what it stored, so a repeat publish is unchanged. */
function server(answers: Record<string, ApiResult<unknown>> = {}) {
  const stored = new Map<string, string>();
  const calls: { path: string; options: RequestOptions }[] = [];
  const request = (async (_method, apiPath, options) => {
    calls.push({ path: apiPath, options });
    const body = options.body as { slug: string };
    if (answers[body.slug]) return answers[body.slug];
    const json = JSON.stringify(body);
    const before = stored.get(body.slug);
    stored.set(body.slug, json);
    const id = `var_srvc_${body.slug}`;
    if (before === undefined) return { ok: true, status: 201, body: { id, slug: body.slug, unchanged: false } };
    return { ok: true, status: 200, body: { id, slug: body.slug, unchanged: before === json } };
  }) as ApiRequestFn;
  return { request, calls };
}

function setup(run: Runner, request: ApiRequestFn, overrides: Partial<PublishDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const output: Output = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    status: () => {},
    styled: false,
  };
  let setUps = 0;
  let signIns = 0;
  const deps: PublishDeps = {
    cwd: project,
    env: {},
    credentials,
    request,
    prompter: { interactive: false, select: async () => null, input: async () => null },
    run,
    setUp: async () => {
      setUps++;
      await initialised();
      return 0;
    },
    signIn: async () => {
      signIns++;
      await saveToken(VARIS_API_ORIGIN, TOKEN, credentials);
      return 0;
    },
    ...overrides,
  };
  return { deps, output, out, err, counts: () => ({ setUps, signIns }) };
}

describe("varis publish", () => {
  it("builds, then publishes each service with the token and owner", async () => {
    await initialised();
    const s = server();
    const t = setup(generator([WEATHER, NEWS]), s.request);

    expect(await runPublish([], t.output, t.deps)).toBe(0);

    expect(s.calls.map((c) => c.path)).toEqual(["/v1/services", "/v1/services"]);
    expect(s.calls[0]!.options).toMatchObject({ auth: "device", owner: OWNER, body: WEATHER });
    expect(t.out).toContain("✓ weather  created (var_srvc_weather)");
    expect(t.out).toContain("✓ news  created (var_srvc_news)");
    expect(t.out.at(-1)).toBe("✓ 2 services: 2 created.");
  });

  it("reports everything unchanged the second time", async () => {
    await initialised();
    const s = server();
    const first = setup(generator([WEATHER, NEWS]), s.request);
    await runPublish([], first.output, first.deps);

    const second = setup(generator([WEATHER, NEWS]), s.request);
    expect(await runPublish([], second.output, second.deps)).toBe(0);

    expect(second.out).toContain("· weather  unchanged (var_srvc_weather)");
    expect(second.out).toContain("· news  unchanged (var_srvc_news)");
    expect(second.out.at(-1)).toBe("✓ 2 services: 2 unchanged.");
  });

  it("reports a changed service as updated", async () => {
    await initialised();
    const s = server();
    const first = setup(generator([WEATHER]), s.request);
    await runPublish([], first.output, first.deps);

    const second = setup(generator([{ ...WEATHER, price_cents: 5 }]), s.request);
    await runPublish([], second.output, second.deps);
    expect(second.out).toContain("✓ weather  updated (var_srvc_weather)");
  });

  it("publishes only the named service", async () => {
    await initialised();
    const s = server();
    const t = setup(generator([WEATHER, NEWS]), s.request);

    expect(await runPublish(["news"], t.output, t.deps)).toBe(0);
    expect(s.calls).toHaveLength(1);
    expect((s.calls[0]!.options.body as { slug: string }).slug).toBe("news");
  });

  it("names the slugs it has when the named one isn't there", async () => {
    await initialised();
    const t = setup(generator([WEATHER, NEWS]), server().request);
    expect(await runPublish(["wether"], t.output, t.deps)).toBe(1);
    expect(t.err.join("\n")).toContain("It has: weather, news.");
  });

  it("publishes nothing if the build fails", async () => {
    await initialised();
    const s = server();
    const t = setup(generator([], 1), s.request);

    expect(await runPublish([], t.output, t.deps)).toBe(1);
    expect(s.calls).toEqual([]);
    expect(t.err.join("\n")).toContain("Nothing was published.");
  });

  it("reports each failure with its details, carries on, and exits non-zero", async () => {
    await initialised();
    const s = server({
      weather: {
        ok: false,
        error: {
          kind: "request",
          status: 400,
          message: "The service definition is invalid.",
          details: [{ path: "/description", message: "must be at least 20 characters" }],
        } as ApiError,
      },
    });
    const t = setup(generator([WEATHER, NEWS]), s.request);

    expect(await runPublish([], t.output, t.deps)).toBe(1);

    const printed = t.err.join("\n");
    expect(printed).toContain("✗ weather  The service definition is invalid.");
    expect(printed).toContain("/description: must be at least 20 characters");
    expect(t.out).toContain("✓ news  created (var_srvc_news)");
    expect(t.out.at(-1)).toBe("✗ 2 services: 1 created, 1 failed.");
  });

  it("stops at a rejected sign-in rather than failing every service the same way", async () => {
    await initialised();
    const s = server({
      weather: {
        ok: false,
        error: { kind: "rejected_token", status: 401, message: "This machine was signed out. Run varis login." },
      },
    });
    const t = setup(generator([WEATHER, NEWS]), s.request);

    expect(await runPublish([], t.output, t.deps)).toBe(1);
    expect(s.calls).toHaveLength(1);
    expect(t.err.join("\n")).toContain("Stopped. 1 service wasn't sent.");
  });

  it("runs init first in a project without varis.json", async () => {
    const s = server();
    const t = setup(generator([WEATHER]), s.request);

    expect(await runPublish([], t.output, t.deps)).toBe(0);
    expect(t.counts()).toEqual({ setUps: 1, signIns: 0 });
    expect(t.err[0]).toBe("No varis.json yet. Setting up this project first.");
  });

  it("signs in first when varis.json exists but this machine isn't signed in", async () => {
    await initialised();
    await rm(home, { recursive: true, force: true });
    const t = setup(generator([WEATHER]), server().request);

    expect(await runPublish([], t.output, t.deps)).toBe(0);
    expect(t.counts()).toEqual({ setUps: 0, signIns: 1 });
  });

  it("stops if setting up fails, publishing nothing", async () => {
    const s = server();
    const t = setup(generator([WEATHER]), s.request, { setUp: async () => 1 });
    expect(await runPublish([], t.output, t.deps)).toBe(1);
    expect(s.calls).toEqual([]);
  });

  it("says so when there's nothing to publish", async () => {
    await initialised();
    const t = setup(generator([]), server().request);
    expect(await runPublish([], t.output, t.deps)).toBe(0);
    expect(t.out.at(-1)).toContain("No services to publish.");
  });

  it("rejects more than one slug, and unknown options", async () => {
    const t = setup(generator([]), server().request);
    expect(await runPublish(["a", "b"], t.output, t.deps)).toBe(2);
    expect(await runPublish(["--all"], t.output, t.deps)).toBe(2);
  });
});
