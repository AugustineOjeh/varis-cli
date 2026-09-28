// Tests for varis upgrade, how it tells install channels apart, and the
// release helpers it uses. The install-script path runs for real: a fake
// release is served from memory, and a stand-in "binary" (a shell script
// that prints a version) is downloaded, checked, unpacked with tar, and
// swapped in.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runUpgrade, type UpgradeDeps } from "../src/commands/upgrade.ts";
import { REPOSITORY_URL } from "../src/lib/constants.ts";
import { runCommand } from "../src/lib/generator.ts";
import { detectChannel } from "../src/lib/install-channel.ts";
import type { Output } from "../src/lib/output.ts";
import { compareVersions, latestVersion, releaseAsset } from "../src/lib/release.ts";

describe("detectChannel", () => {
  it("recognises Homebrew on Apple silicon, Intel, and Linux", () => {
    for (const binary of [
      "/opt/homebrew/Cellar/varis/0.2.1/bin/varis",
      "/usr/local/Cellar/varis/0.2.1/bin/varis",
      "/home/linuxbrew/.linuxbrew/Cellar/varis/0.2.1/bin/varis",
    ]) {
      expect(detectChannel(binary, "/Users/ada", "darwin").kind).toBe("homebrew");
    }
  });

  it("recognises Scoop, whatever the case", () => {
    expect(
      detectChannel("C:\\Users\\Ada\\scoop\\apps\\varis\\current\\varis.exe", "C:\\Users\\Ada", "win32").kind,
    ).toBe("scoop");
    expect(
      detectChannel("C:\\Users\\Ada\\Scoop\\Apps\\Varis\\0.2.1\\varis.exe", "C:\\Users\\Ada", "win32").kind,
    ).toBe("scoop");
  });

  it("recognises the install script's folder, and only that folder", () => {
    expect(detectChannel("/Users/ada/.varis/bin/varis", "/Users/ada", "darwin").kind).toBe("script");
    expect(
      detectChannel("C:\\Users\\Ada\\.varis\\bin\\varis.exe", "C:\\Users\\Ada", "win32").kind,
    ).toBe("script");
    expect(detectChannel("/Users/ada/.varis/bin/sub/varis", "/Users/ada", "darwin").kind).toBe("unknown");
    expect(detectChannel("/usr/local/bin/varis", "/Users/ada", "darwin").kind).toBe("unknown");
  });

  it("recognises the CLI running from source", () => {
    expect(detectChannel("/usr/local/bin/node", "/Users/ada", "darwin").kind).toBe("source");
    expect(detectChannel("C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\Ada", "win32").kind).toBe("source");
  });
});

describe("compareVersions", () => {
  it("orders versions, with a pre-release before its release", () => {
    expect(compareVersions("0.2.1", "0.2.1")).toBe(0);
    expect(compareVersions("0.2.0", "0.2.1")).toBeLessThan(0);
    expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("0.2.1-rc.1", "0.2.1")).toBeLessThan(0);
    expect(compareVersions("0.3.0-rc.1", "0.2.1")).toBeGreaterThan(0);
    expect(compareVersions("0.2.1-rc.2", "0.2.1-rc.10")).toBeLessThan(0);
  });
});

describe("releaseAsset", () => {
  it("names each platform's archive as the release does", () => {
    expect(releaseAsset("darwin", "arm64")?.archive).toBe("varis-darwin-arm64.tar.gz");
    expect(releaseAsset("linux", "x64")?.archive).toBe("varis-linux-x64.tar.gz");
    expect(releaseAsset("win32", "arm64")).toEqual({ archive: "varis-windows-x64.zip", binary: "varis.exe" });
    expect(releaseAsset("freebsd", "x64")).toBeNull();
  });
});

describe("latestVersion", () => {
  it("reads the version from the /releases/latest redirect", async () => {
    const fetchFn = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: `${REPOSITORY_URL}/releases/tag/v0.2.1` },
      })) as typeof fetch;
    expect(await latestVersion(fetchFn)).toBe("0.2.1");
  });

  it("is null when there's no full release, which redirects to /releases", async () => {
    const fetchFn = (async () =>
      new Response(null, { status: 302, headers: { location: `${REPOSITORY_URL}/releases` } })) as typeof fetch;
    expect(await latestVersion(fetchFn)).toBeNull();
  });
});

let home: string;
let installed: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "varis-upgrade-"));
  await mkdir(path.join(home, ".varis", "bin"), { recursive: true });
  installed = path.join(home, ".varis", "bin", "varis");
  await writeFile(installed, "#!/bin/sh\necho 0.2.1\n", { mode: 0o755 });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** A release for this machine, holding a stand-in binary that prints `version`. */
async function fakeRelease(version: string, { tamper = false } = {}) {
  const asset = releaseAsset(process.platform, process.arch)!;
  const staging = await mkdtemp(path.join(os.tmpdir(), "varis-release-"));
  await writeFile(path.join(staging, "varis"), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  execFileSync("tar", ["-czf", path.join(staging, asset.archive), "-C", staging, "varis"]);
  const archive = await readFile(path.join(staging, asset.archive));
  await rm(staging, { recursive: true, force: true });

  const sum = createHash("sha256").update(tamper ? Buffer.from("something else") : archive).digest("hex");
  const files: Record<string, Buffer | string> = {
    [asset.archive]: archive,
    SHA256SUMS: `${sum}  ${asset.archive}\n`,
  };
  const requested: string[] = [];

  const fetchFn = (async (input: string | URL) => {
    const url = String(input);
    requested.push(url);
    if (url === `${REPOSITORY_URL}/releases/latest`) {
      return new Response(null, {
        status: 302,
        headers: { location: `${REPOSITORY_URL}/releases/tag/v${version}` },
      });
    }
    const prefix = `${REPOSITORY_URL}/releases/download/v${version}/`;
    const file = url.startsWith(prefix) ? files[url.slice(prefix.length)] : undefined;
    return file === undefined ? new Response("not found", { status: 404 }) : new Response(typeof file === "string" ? file : new Uint8Array(file));
  }) as typeof fetch;

  return { fetchFn, requested };
}

async function run(overrides: Partial<UpgradeDeps>) {
  const out: string[] = [];
  const err: string[] = [];
  const output: Output = { out: (t) => out.push(t), err: (t) => err.push(t), status: () => {}, styled: false };
  const shown: string[][] = [];
  const deps: UpgradeDeps = {
    binary: installed,
    home,
    platform: process.platform,
    arch: process.arch,
    version: "0.2.1",
    fetch: (async () => {
      throw new Error("no network in this test");
    }) as typeof fetch,
    run: runCommand,
    runShown: async (command) => {
      shown.push(command);
      return 0;
    },
    ...overrides,
  };
  const code = await runUpgrade([], output, deps);
  return { code, out: out.join("\n"), err: err.join("\n"), shown };
}

// Replacing a running binary by rename is the macOS and Linux path, and the
// stand-in binary is a shell script.
describe.skipIf(process.platform === "win32")("varis upgrade, installed by the script", () => {
  it("downloads, checks, and swaps in the new version, leaving nothing behind", async () => {
    const release = await fakeRelease("0.3.0");

    const result = await run({ fetch: release.fetchFn });

    expect(result.code).toBe(0);
    expect(result.out).toContain("Upgraded varis from 0.2.1 to 0.3.0");
    expect(execFileSync(installed).toString().trim()).toBe("0.3.0");
    // Only the binary remains: no archive, no working folder.
    expect(await readdir(path.dirname(installed))).toEqual(["varis"]);
  });

  it("changes nothing when the checksum doesn't match", async () => {
    const release = await fakeRelease("0.3.0", { tamper: true });

    const result = await run({ fetch: release.fetchFn });

    expect(result.code).toBe(1);
    expect(result.err).toContain("checksum doesn't match");
    expect(execFileSync(installed).toString().trim()).toBe("0.2.1");
    expect(await readdir(path.dirname(installed))).toEqual(["varis"]);
  });

  it("stops without downloading when already on the latest", async () => {
    const release = await fakeRelease("0.2.1");

    const result = await run({ fetch: release.fetchFn });

    expect(result.code).toBe(0);
    expect(result.out).toContain("varis 0.2.1 is the latest version");
    expect(release.requested).toEqual([`${REPOSITORY_URL}/releases/latest`]);
  });

  it("never moves a newer pre-release back to the latest release", async () => {
    const release = await fakeRelease("0.2.1");

    const result = await run({ fetch: release.fetchFn, version: "0.3.0-rc.1" });

    expect(result.code).toBe(0);
    expect(result.out).toContain("0.3.0-rc.1 is the latest version");
    expect(execFileSync(installed).toString().trim()).toBe("0.2.1");
  });
});

describe("varis upgrade, through a package manager", () => {
  it("runs brew upgrade for a Homebrew copy", async () => {
    const release = await fakeRelease("0.3.0");

    const result = await run({
      fetch: release.fetchFn,
      binary: "/opt/homebrew/Cellar/varis/0.2.1/bin/varis",
    });

    expect(result.code).toBe(0);
    expect(result.shown).toEqual([["brew", "upgrade", "usevaris/tap/varis"]]);
    // Nothing is downloaded by varis itself.
    expect(release.requested).toEqual([`${REPOSITORY_URL}/releases/latest`]);
  });

  it("refreshes the bucket, then updates, for a Scoop copy", async () => {
    const release = await fakeRelease("0.3.0");

    const result = await run({
      fetch: release.fetchFn,
      binary: "C:\\Users\\Ada\\scoop\\apps\\varis\\current\\varis.exe",
      home: "C:\\Users\\Ada",
      platform: "win32",
    });

    expect(result.code).toBe(0);
    expect(result.shown).toEqual([["scoop", "update"], ["scoop", "update", "varis"]]);
  });

  it("reports a failed package manager run", async () => {
    const release = await fakeRelease("0.3.0");

    const result = await run({
      fetch: release.fetchFn,
      binary: "/opt/homebrew/Cellar/varis/0.2.1/bin/varis",
      runShown: async () => 1,
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain("brew upgrade usevaris/tap/varis failed");
  });
});

describe("varis upgrade, elsewhere", () => {
  it("won't touch a copy it can't place", async () => {
    const result = await run({ binary: "/usr/local/bin/varis" });

    expect(result.code).toBe(1);
    expect(result.err).toContain("can't tell how /usr/local/bin/varis was installed");
  });

  it("says to pull the code when running from source", async () => {
    const result = await run({ binary: "/usr/local/bin/node" });

    expect(result.code).toBe(1);
    expect(result.err).toContain("running from source");
  });

  it("reports a network failure", async () => {
    const result = await run({});

    expect(result.code).toBe(1);
    expect(result.err).toContain("Couldn't check for a new version");
  });
});
