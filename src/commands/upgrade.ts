// varis upgrade: moves this copy of the CLI to the latest full release.
//
// It upgrades through whatever installed it, because a package manager
// keeps its own record of what it installed, and replacing its binary
// underneath it leaves that record wrong:
//   Homebrew  runs `brew upgrade usevaris/tap/varis`.
//   Scoop     runs `scoop update`, which refreshes the bucket, then
//             `scoop update varis`.
//   Script    a copy in ~/.varis/bin replaces itself: it downloads the
//             latest release's archive for this platform, checks it
//             against SHA256SUMS, unpacks it, and swaps it in.
// It checks the latest version first, so an up-to-date copy doesn't wake a
// package manager for nothing. Pre-releases are never offered.
//
// HOW A RUNNING PROGRAM REPLACES ITSELF
// On macOS and Linux, a file can be replaced while it runs: the new binary
// is written next to the old one, then renamed over it in one step. The
// running process keeps the old file's contents until it exits, and any
// later run gets the new one. Nothing is ever left half-written.
//
// Windows won't let a running program's file be replaced or deleted, but
// it can be renamed. So varis.exe is renamed to varis.exe.old, the new one
// moved into its place, and the old file deleted by the next run of varis
// (see removeLeftoverUpgrade, called from src/cli.ts).

import { realpathSync } from "node:fs";
import { chmod, mkdtemp, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Command } from "../lib/command.ts";
import { runCommand, runCommandShown, type Runner } from "../lib/generator.ts";
import { type Channel, detectChannel } from "../lib/install-channel.ts";
import { reportLines } from "../lib/issues.ts";
import type { Output } from "../lib/output.ts";
import { compareVersions, downloadRelease, latestVersion, releaseAsset } from "../lib/release.ts";
import { dim, failure, success } from "../lib/style.ts";
import { VERSION } from "../lib/version.ts";

/** Where Windows parks the replaced binary until the next run deletes it. */
export const LEFTOVER_SUFFIX = ".old";

export type UpgradeDeps = {
  /** The running binary, symlinks resolved. */
  binary: string;
  home: string;
  platform: NodeJS.Platform;
  arch: string;
  /** This copy's version. */
  version: string;
  fetch: typeof fetch;
  /** Runs a command quietly, capturing its output. */
  run: Runner;
  /**
   * Runs a package manager with its output shown as it goes, since an
   * upgrade can take a while. Returns its exit code, or "missing" when the
   * program isn't installed.
   */
  runShown: (command: string[]) => Promise<number | "missing">;
};

const defaultDeps = (): UpgradeDeps => ({
  binary: resolvedExecPath(),
  home: os.homedir(),
  platform: process.platform,
  arch: process.arch,
  version: VERSION,
  fetch,
  run: runCommand,
  runShown: runCommandShown,
});

/** The running binary with symlinks resolved, falling back to the path as run. */
export function resolvedExecPath(): string {
  try {
    return realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
}

export async function runUpgrade(
  args: string[],
  output: Output,
  deps: UpgradeDeps = defaultDeps(),
): Promise<number> {
  if (args.length > 0) {
    output.err(`Unknown option: ${args[0]}. Run varis upgrade --help.`);
    return 2;
  }

  const channel = detectChannel(deps.binary, deps.home, deps.platform);
  if (channel.kind === "source") {
    output.err("This is varis running from source. Pull the latest code instead.");
    return 1;
  }
  if (channel.kind === "unknown") {
    output.err(failure(output, `varis upgrade can't tell how ${channel.binary} was installed.`));
    output.err("It upgrades copies from Homebrew, Scoop, or the install script. Reinstall with one of them:");
    output.err("");
    output.err("  https://github.com/usevaris/varis-cli#install");
    return 1;
  }

  // The latest version first, so an up-to-date copy stops here.
  let latest: string | null;
  try {
    latest = await latestVersion(deps.fetch);
  } catch {
    output.err(failure(output, "Couldn't check for a new version. Check your connection, then try again."));
    return 1;
  }
  if (latest === null) {
    output.err(failure(output, "Couldn't find the latest release of varis."));
    return 1;
  }
  if (compareVersions(deps.version, latest) >= 0) {
    output.out(success(output, `varis ${deps.version} is the latest version.`));
    return 0;
  }

  output.err(`Upgrading varis ${deps.version} to ${latest}.`);
  output.err("");

  const upgraded = channel.kind === "script"
    ? await replaceSelf(channel, latest, output, deps)
    : await upgradeThroughPackageManager(channel, output, deps);
  if (!upgraded) return 1;

  // Ask the binary now in place, so the message reports what actually
  // runs, not what was meant to. A package manager may have moved it (a
  // new Cellar folder), in which case this falls back to the version asked
  // for.
  const check = await deps.run([channel.binary, "--version"], path.dirname(channel.binary));
  const now = check.status === "ran" && check.code === 0 ? check.stdout.trim() : latest;
  output.out("");
  output.out(success(output, `Upgraded varis from ${deps.version} to ${now}.`));
  return 0;
}

async function upgradeThroughPackageManager(
  channel: Extract<Channel, { kind: "homebrew" | "scoop" }>,
  output: Output,
  deps: UpgradeDeps,
): Promise<boolean> {
  const steps = channel.kind === "homebrew"
    ? [["brew", "upgrade", "usevaris/tap/varis"]]
    : [["scoop", "update"], ["scoop", "update", "varis"]];

  for (const step of steps) {
    output.err(dim(output, `$ ${step.join(" ")}`));
    const code = await deps.runShown(step);
    if (code === "missing") {
      output.err(failure(output, `${step[0]} isn't on your PATH, though it installed varis. Run ${step.join(" ")} yourself.`));
      return false;
    }
    if (code !== 0) {
      output.err(failure(output, `${step.join(" ")} failed. Its output above says why.`));
      return false;
    }
  }
  return true;
}

async function replaceSelf(
  channel: Extract<Channel, { kind: "script" }>,
  version: string,
  output: Output,
  deps: UpgradeDeps,
): Promise<boolean> {
  const asset = releaseAsset(deps.platform, deps.arch);
  if (!asset) {
    output.err(failure(output, `There's no varis build for ${deps.platform} ${deps.arch}.`));
    return false;
  }

  const target = channel.binary;
  const dir = path.dirname(target);
  // In the same folder as the binary, so the final step is a rename within
  // one filesystem, which is atomic. A rename across filesystems isn't.
  const work = await mkdtemp(path.join(dir, ".varis-upgrade-"));

  try {
    output.status(`Downloading varis ${version}…`);
    const downloaded = await downloadRelease(version, asset, work, deps);
    output.status("");
    if (!downloaded.ok) {
      output.err(failure(output, downloaded.reason));
      return false;
    }

    try {
      if (deps.platform === "win32") {
        const parked = `${target}${LEFTOVER_SUFFIX}`;
        await rm(parked, { force: true });
        await rename(target, parked);
        try {
          await rename(downloaded.binary, target);
        } catch (error) {
          // Put the old binary back, so a failed upgrade leaves a working
          // varis.
          await rename(parked, target);
          throw error;
        }
      } else {
        await chmod(downloaded.binary, 0o755);
        await rename(downloaded.binary, target);
      }
    } catch (error) {
      output.err(failure(output, `Couldn't replace ${target}: ${error instanceof Error ? error.message : error}`));
      for (const line of reportLines({ command: "varis upgrade", error: String(error) })) output.err(line);
      return false;
    }
    return true;
  } finally {
    // Also removes the downloaded archive: nothing is left behind.
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * Deletes the binary a Windows upgrade parked beside the new one. Called
 * on every start; costs one failed delete when there's nothing to remove.
 */
export async function removeLeftoverUpgrade(binary = resolvedExecPath()): Promise<void> {
  if (process.platform !== "win32") return;
  await rm(`${binary}${LEFTOVER_SUFFIX}`, { force: true }).catch(() => {});
}

export const upgrade: Command = {
  name: "upgrade",
  summary: "Upgrade the Varis CLI to the latest stable version",
  usage: `Usage: varis upgrade

  Upgrades to the latest full release through whatever installed the CLI:
  Homebrew (brew upgrade), Scoop (scoop update), or the install script,
  which downloads the new version, checks its checksum, and replaces
  itself. Prints the version before and after. Pre-releases are never
  offered.`,
  run: (args, output) => runUpgrade(args, output),
};
