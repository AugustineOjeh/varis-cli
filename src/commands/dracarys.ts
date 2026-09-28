// varis dracarys: burns Varis off this machine.
//
// After the developer types "dracarys" (or passes --goddamnit), in order:
//   1. Signs this machine out, revoking its token on the server: exactly
//      varis logout.
//   2. Cleans the current project: deletes varis.json, and takes out the
//      Varis block varis init added to AGENTS.md. If AGENTS.md held nothing
//      else, it goes, and so does CLAUDE.md's @AGENTS.md import, which
//      would point at nothing.
//   3. Deletes the config folder that held the credentials file.
//   4. Uninstalls the CLI through whatever installed it: Homebrew, Scoop, or
//      the install script (its folder and its PATH line). Last, because it
//      removes the program that's running.
//
// What it never touches: the Varis account and its services, which live on
// the server, and any other project's varis.json. It acts on the current
// folder only, rather than searching the disk: a search could find and
// delete tracked files in projects the developer forgot about, or that
// aren't theirs.
//
// Everything that applies is listed and confirmed before anything changes.
// Signed out, outside a project, or running from source, those steps are
// skipped and the list says so.

import { access, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  BLOCK_BEGIN,
  removeAgentsBlock,
  removeClaudeImport,
} from "../lib/agent-instructions.ts";
import { apiRequest, type ApiRequestFn } from "../lib/api.ts";
import type { Command } from "../lib/command.ts";
import type { Env } from "../lib/constants.ts";
import {
  credentialsPath,
  type CredentialsLocation,
  defaultLocation,
  readCredentials,
} from "../lib/credentials.ts";
import { runCommandShown } from "../lib/generator.ts";
import { type Channel, detectChannel } from "../lib/install-channel.ts";
import { MANIFEST_FILE } from "../lib/manifest.ts";
import type { Output } from "../lib/output.ts";
import { type Prompter, terminalPrompter } from "../lib/prompt.ts";
import { bold, dim, failure, success, yellow } from "../lib/style.ts";
import {
  removePathLines,
  shellProfiles,
  startDetachedPowerShell,
  type WindowsCleanup,
  windowsCleanupScript,
} from "../lib/uninstall.ts";
import { runLogout } from "./logout.ts";
import { resolvedExecPath } from "./upgrade.ts";

export type DracarysDeps = {
  cwd: string;
  home: string;
  env: Env;
  platform: NodeJS.Platform;
  /** The running binary, symlinks resolved. */
  binary: string;
  pid: number;
  credentials: CredentialsLocation;
  request: ApiRequestFn;
  prompter: Prompter;
  /** Runs Homebrew with its output shown. */
  runShown: (command: string[]) => Promise<number | "missing">;
  /** Hands the rest of a Windows uninstall to a script that outlives varis. */
  startDetached: (script: string) => void;
};

const defaultDeps = (): DracarysDeps => ({
  cwd: process.cwd(),
  home: os.homedir(),
  env: process.env,
  platform: process.platform,
  binary: resolvedExecPath(),
  pid: process.pid,
  credentials: defaultLocation(),
  request: apiRequest,
  prompter: terminalPrompter(),
  runShown: runCommandShown,
  startDetached: startDetachedPowerShell,
});

/** What this run will do, worked out before asking. */
type Plan = {
  signedIn: boolean;
  manifest: boolean;
  agentsBlock: boolean;
  configDir: string;
  channel: Channel;
};

export async function runDracarys(
  args: string[],
  output: Output,
  deps: DracarysDeps = defaultDeps(),
): Promise<number> {
  let confirmed: boolean;
  try {
    const { values } = parseArgs({
      args,
      options: { goddamnit: { type: "boolean" } },
      strict: true,
      allowPositionals: false,
    });
    confirmed = values.goddamnit === true;
  } catch (error) {
    output.err(`${error instanceof Error ? error.message : error} Run varis dracarys --help.`);
    return 2;
  }

  const plan = await makePlan(deps);
  describePlan(plan, deps, output);

  if (!confirmed) {
    if (!deps.prompter.interactive) {
      output.err(failure(output, "Nothing was changed. Without a terminal to confirm in, pass --goddamnit."));
      return 1;
    }
    const answer = await deps.prompter.input("Type dracarys to confirm");
    if (answer?.trim().toLowerCase() !== "dracarys") {
      output.err("Cancelled. Nothing was changed.");
      return 1;
    }
  }
  output.err("");

  let ok = true;

  // 1. Sign out, exactly as varis logout does, messages included.
  if (plan.signedIn) {
    await runLogout([], output, { credentials: deps.credentials, request: deps.request });
  }

  // 2. The current project.
  if (plan.manifest) {
    await rm(path.join(deps.cwd, MANIFEST_FILE), { force: true });
    output.out(success(output, `Deleted ${MANIFEST_FILE}.`));
  }
  if (plan.agentsBlock) {
    const agents = await removeAgentsBlock(deps.cwd);
    if (agents === "deleted") {
      output.out(success(output, "Deleted AGENTS.md, which held only the Varis block."));
      const claude = await removeClaudeImport(deps.cwd);
      if (claude === "deleted") output.out(success(output, "Deleted CLAUDE.md, which held only @AGENTS.md."));
      if (claude === "removed") output.out(success(output, "Removed @AGENTS.md from CLAUDE.md."));
    } else if (agents === "removed") {
      output.out(success(output, "Removed the Varis block from AGENTS.md."));
    }
  }

  // 3. The config folder, now empty of credentials.
  await rm(plan.configDir, { recursive: true, force: true });
  output.out(success(output, `Deleted ${plan.configDir}.`));

  // 4. The CLI itself, last.
  ok = (await uninstall(plan.channel, deps, output)) && ok;

  output.out("");
  output.out(
    ok
      ? bold(output, `"Dracarys." Varis is gone from this machine.`)
      : yellow(output, "Varis is mostly gone from this machine. The step above that failed says what's left."),
  );
  return ok ? 0 : 1;
}

/** Path handling for the platform being cleaned, so tests can pass Windows paths anywhere. */
const pathFor = (platform: NodeJS.Platform) => (platform === "win32" ? path.win32 : path.posix);

async function makePlan(deps: DracarysDeps): Promise<Plan> {
  const stored = await readCredentials(deps.credentials);
  const agents = await readText(path.join(deps.cwd, "AGENTS.md"));
  return {
    // A corrupt file is removed with the config folder; there's no token
    // in it to revoke.
    signedIn: stored.status === "signed_in",
    manifest: await exists(path.join(deps.cwd, MANIFEST_FILE)),
    agentsBlock: agents?.includes(BLOCK_BEGIN) ?? false,
    configDir: path.dirname(credentialsPath(deps.credentials)),
    channel: detectChannel(deps.binary, deps.home, deps.platform),
  };
}

function describePlan(plan: Plan, deps: DracarysDeps, output: Output): void {
  const skip = (text: string) => output.err(dim(output, `  - ${text}`));
  const will = (text: string) => output.err(`  - ${text}`);

  output.err("This will:");
  if (plan.signedIn) will("sign this machine out, revoking its token");
  else skip("sign out: skipped, this machine isn't signed in");

  if (plan.manifest || plan.agentsBlock) {
    const parts = [
      plan.manifest && `delete ${MANIFEST_FILE}`,
      plan.agentsBlock && "take the Varis block out of AGENTS.md",
    ].filter(Boolean);
    will(`in ${deps.cwd}: ${parts.join(", and ")}`);
  } else {
    skip(`clean a project: skipped, ${deps.cwd} isn't a Varis project`);
  }

  will(`delete ${plan.configDir}`);

  const channel = plan.channel;
  if (channel.kind === "homebrew") will("uninstall varis with Homebrew, and remove the usevaris/tap tap");
  if (channel.kind === "scoop") will("uninstall varis with Scoop, and remove the varis bucket");
  if (channel.kind === "script") {
    const paths = pathFor(deps.platform);
    will(`delete ${paths.dirname(paths.dirname(channel.binary))}, and its PATH entry`);
  }
  if (channel.kind === "unknown") will(`delete ${channel.binary}`);
  if (channel.kind === "source") skip("uninstall: skipped, this is varis running from source");

  output.err("");
  output.err("Your Varis account and your published services are untouched.");
  output.err("");
}

async function uninstall(channel: Channel, deps: DracarysDeps, output: Output): Promise<boolean> {
  const windows = deps.platform === "win32";

  switch (channel.kind) {
    case "source":
      return true;

    case "homebrew": {
      for (const step of [["brew", "uninstall", "usevaris/tap/varis"], ["brew", "untap", "usevaris/tap"]]) {
        output.err(dim(output, `$ ${step.join(" ")}`));
        const code = await deps.runShown(step);
        if (code !== 0) {
          output.err(failure(output, `${step.join(" ")} didn't finish. Run it yourself to see why.`));
          return false;
        }
      }
      output.out(success(output, "Uninstalled varis with Homebrew."));
      return true;
    }

    case "scoop":
      // Scoop can't remove varis.exe while it runs; see src/lib/uninstall.ts.
      return handToWindows({ kind: "scoop" }, "Scoop uninstalls varis as soon as this command exits.", deps, output);

    case "script": {
      const paths = pathFor(deps.platform);
      const installDir = paths.dirname(channel.binary);
      if (windows) {
        return handToWindows(
          { kind: "script", installDir },
          `${paths.dirname(installDir)} and its PATH entry go as soon as this command exits.`,
          deps,
          output,
        );
      }
      // On macOS and Linux, a running program's file can be deleted; the
      // process keeps running until it exits.
      await rm(paths.dirname(installDir), { recursive: true, force: true });
      output.out(success(output, `Deleted ${paths.dirname(installDir)}.`));
      const profiles = await removePathLines(shellProfiles(deps.home, deps.env));
      for (const file of profiles) output.out(success(output, `Removed the Varis PATH line from ${file}.`));
      if (profiles.length > 0) output.out("Open a new terminal to drop it from your PATH.");
      return true;
    }

    case "unknown": {
      if (windows) {
        output.err(yellow(output, `Delete ${channel.binary} yourself once this command exits: Windows won't delete a running program.`));
        return true;
      }
      await rm(channel.binary, { force: true });
      output.out(success(output, `Deleted ${channel.binary}.`));
      return true;
    }
  }
}

function handToWindows(cleanup: WindowsCleanup, message: string, deps: DracarysDeps, output: Output): boolean {
  try {
    deps.startDetached(windowsCleanupScript(deps.pid, cleanup));
  } catch (error) {
    output.err(failure(output, `Couldn't start the uninstall: ${error instanceof Error ? error.message : error}`));
    return false;
  }
  output.out(success(output, message));
  return true;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

export const dracarys: Command = {
  name: "dracarys",
  summary: "Burn Varis off this machine: sign out, clean this project, uninstall",
  usage: `Usage: varis dracarys [--goddamnit]

  Lists what it will do and asks you to type dracarys to confirm, then:

    - signs this machine out, revoking its token
    - removes this project's varis.json, and the Varis block varis init
      added to AGENTS.md
    - deletes the config folder, and uninstalls the CLI through whatever
      installed it: Homebrew, Scoop, or the install script

  Your Varis account and your published services are untouched. Other
  projects on this machine keep their varis.json.

  --goddamnit  Skip the confirmation.`,
  run: (args, output) => runDracarys(args, output),
};
