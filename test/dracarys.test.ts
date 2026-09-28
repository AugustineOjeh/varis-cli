// Tests for varis dracarys. Each run happens in a throwaway home folder and
// project, set up the way login, init, and the install script leave them,
// then checked file by file afterwards.

import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DracarysDeps, runDracarys } from "../src/commands/dracarys.ts";
import {
  ensureClaudeImport,
  removeAgentsBlock,
  upsertAgentsBlock,
} from "../src/lib/agent-instructions.ts";
import type { ApiRequestFn } from "../src/lib/api.ts";
import { VARIS_API_ORIGIN } from "../src/lib/constants.ts";
import { type CredentialsLocation, credentialsPath, saveToken } from "../src/lib/credentials.ts";
import type { Output } from "../src/lib/output.ts";
import type { Prompter } from "../src/lib/prompt.ts";
import {
  encodePowerShell,
  PATH_MARKER,
  removePathLines,
  windowsCleanupScript,
  windowsLauncher,
} from "../src/lib/uninstall.ts";

const TOKEN = `var_dt_${"a".repeat(40)}`;

let home: string;
let project: string;
let credentials: CredentialsLocation;
let binary: string;

const exists = (file: string) => access(file).then(() => true, () => false);

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "varis-dracarys-home-"));
  project = await mkdtemp(path.join(os.tmpdir(), "varis-dracarys-project-"));
  credentials = { env: {}, platform: "darwin", home };

  // What varis login leaves.
  await saveToken(VARIS_API_ORIGIN, TOKEN, credentials);
  // What the install script leaves: the binary, and a marked PATH line.
  binary = path.join(home, ".varis", "bin", "varis");
  await mkdir(path.dirname(binary), { recursive: true });
  await writeFile(binary, "binary");
  await writeFile(
    path.join(home, ".zshrc"),
    `alias ll="ls -l"\n\n${PATH_MARKER}\nexport PATH="${home}/.varis/bin:$PATH"\n`,
  );
  // What varis init leaves in a new project.
  await writeFile(path.join(project, "varis.json"), "{}\n");
  await upsertAgentsBlock(project);
  await ensureClaudeImport(project);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
});

function prompter(interactive: boolean, answer: string | null = null): Prompter {
  return { interactive, select: async () => null, input: async () => answer };
}

async function run(args: string[], overrides: Partial<DracarysDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const output: Output = { out: (t) => out.push(t), err: (t) => err.push(t), status: () => {}, styled: false };
  const requests: { path: string; bearer?: string }[] = [];
  const shown: string[][] = [];
  const detached: string[] = [];
  const deps: DracarysDeps = {
    cwd: project,
    home,
    env: {},
    platform: "darwin",
    binary,
    pid: 4242,
    credentials,
    request: (async (_method, apiPath, options) => {
      requests.push({ path: apiPath, bearer: options.bearer });
      return { ok: true, status: 200, body: {} };
    }) as ApiRequestFn,
    prompter: prompter(false),
    runShown: async (command) => {
      shown.push(command);
      return 0;
    },
    startDetached: (script) => detached.push(script),
    ...overrides,
  };
  const code = await runDracarys(args, output, deps);
  return { code, out: out.join("\n"), err: err.join("\n"), requests, shown, detached };
}

describe("varis dracarys", () => {
  it("burns everything an install-script setup left, and nothing else", async () => {
    const result = await run(["--goddamnit"]);

    expect(result.code).toBe(0);
    // Signed out on the server, with the stored token.
    expect(result.requests).toEqual([{ path: "/v1/cli/logout", bearer: TOKEN }]);
    // The project: varis.json, and the AGENTS.md and CLAUDE.md init made.
    expect(await exists(path.join(project, "varis.json"))).toBe(false);
    expect(await exists(path.join(project, "AGENTS.md"))).toBe(false);
    expect(await exists(path.join(project, "CLAUDE.md"))).toBe(false);
    // The config folder and the install.
    expect(await exists(path.dirname(credentialsPath(credentials)))).toBe(false);
    expect(await exists(path.join(home, ".varis"))).toBe(false);
    // The PATH line and its marker, with the developer's own lines kept.
    expect(await readFile(path.join(home, ".zshrc"), "utf8")).toBe(`alias ll="ls -l"\n`);
    expect(result.out).toContain("Varis is gone from this machine");
  });

  it("keeps what the developer wrote in AGENTS.md, and CLAUDE.md's import of it", async () => {
    await writeFile(path.join(project, "AGENTS.md"), "# My project\n\nUse tabs.\n");
    await upsertAgentsBlock(project);

    const result = await run(["--goddamnit"]);

    expect(result.code).toBe(0);
    expect(await readFile(path.join(project, "AGENTS.md"), "utf8")).toBe("# My project\n\nUse tabs.\n");
    expect(await readFile(path.join(project, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
  });

  it("lists the plan and changes nothing without a terminal or --goddamnit", async () => {
    const result = await run([]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("This will:");
    expect(result.err).toContain("pass --goddamnit");
    expect(result.requests).toHaveLength(0);
    expect(await exists(path.join(project, "varis.json"))).toBe(true);
    expect(await exists(binary)).toBe(true);
  });

  it("goes ahead only when dracarys is typed", async () => {
    const wrong = await run([], { prompter: prompter(true, "yes") });
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain("Cancelled. Nothing was changed.");
    expect(await exists(binary)).toBe(true);

    const right = await run([], { prompter: prompter(true, " Dracarys ") });
    expect(right.code).toBe(0);
    expect(await exists(binary)).toBe(false);
  });

  it("skips what doesn't apply: signed out, and outside a project", async () => {
    await rm(path.dirname(credentialsPath(credentials)), { recursive: true });
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), "varis-dracarys-elsewhere-"));

    const result = await run(["--goddamnit"], { cwd: elsewhere });
    await rm(elsewhere, { recursive: true, force: true });

    expect(result.code).toBe(0);
    expect(result.err).toContain("sign out: skipped");
    expect(result.err).toContain("isn't a Varis project");
    expect(result.requests).toHaveLength(0);
    expect(await exists(path.join(home, ".varis"))).toBe(false);
  });

  it("uninstalls a Homebrew copy with brew, and removes the tap", async () => {
    const result = await run(["--goddamnit"], { binary: "/opt/homebrew/Cellar/varis/0.3.0/bin/varis" });

    expect(result.code).toBe(0);
    expect(result.shown).toEqual([
      ["brew", "uninstall", "usevaris/tap/varis"],
      ["brew", "untap", "usevaris/tap"],
    ]);
  });

  it("reports a failed Homebrew uninstall", async () => {
    const result = await run(["--goddamnit"], {
      binary: "/opt/homebrew/Cellar/varis/0.3.0/bin/varis",
      runShown: async () => 1,
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain("brew uninstall usevaris/tap/varis didn't finish");
  });

  it("hands a Scoop uninstall to a script that waits for varis to exit", async () => {
    const result = await run(["--goddamnit"], {
      platform: "win32",
      home: "C:\\Users\\Ada",
      binary: "C:\\Users\\Ada\\scoop\\apps\\varis\\current\\varis.exe",
    });

    expect(result.code).toBe(0);
    expect(result.detached).toHaveLength(1);
    expect(result.detached[0]).toContain("Wait-Process -Id 4242");
    expect(result.detached[0]).toContain("scoop uninstall varis");
  });

  it("hands a Windows install-script uninstall to the same kind of script", async () => {
    const result = await run(["--goddamnit"], {
      platform: "win32",
      home: "C:\\Users\\Ada",
      binary: "C:\\Users\\Ada\\.varis\\bin\\varis.exe",
    });

    expect(result.code).toBe(0);
    expect(result.detached[0]).toContain("$dir = 'C:\\Users\\Ada\\.varis\\bin'");
    expect(result.detached[0]).toContain("Remove-Item -Recurse -Force");
    expect(result.out).toContain("C:\\Users\\Ada\\.varis and its PATH entry go");
  });

  it("uninstalls nothing when running from source", async () => {
    const result = await run(["--goddamnit"], { binary: "/usr/local/bin/node" });

    expect(result.code).toBe(0);
    expect(result.err).toContain("uninstall: skipped");
    expect(result.shown).toHaveLength(0);
    expect(result.detached).toHaveLength(0);
  });

  it("rejects an unknown option", async () => {
    expect((await run(["--yes"])).code).toBe(2);
  });
});

describe("removePathLines", () => {
  it("removes only the marked line that mentions varis", async () => {
    const file = path.join(home, ".bashrc");
    const untouched = `${PATH_MARKER}\nexport PATH="/somewhere/else:$PATH"\n`;
    await writeFile(file, untouched);

    expect(await removePathLines([file, path.join(home, "missing")])).toEqual([]);
    expect(await readFile(file, "utf8")).toBe(untouched);
  });
});

describe("removeAgentsBlock", () => {
  it("removes a block in the middle, keeping both sides", async () => {
    const block = await readFile(path.join(project, "AGENTS.md"), "utf8");
    const middle = block.slice(block.indexOf("<!--"));
    await writeFile(path.join(project, "AGENTS.md"), `# Top\n\n${middle}\n## Bottom\n`);

    expect(await removeAgentsBlock(project)).toBe("removed");
    expect(await readFile(path.join(project, "AGENTS.md"), "utf8")).toBe("# Top\n\n## Bottom\n");
  });
});

describe("encodePowerShell", () => {
  it("encodes the script as base64 UTF-16LE, which PowerShell decodes back exactly", () => {
    const script = windowsCleanupScript(7, { kind: "scoop" });
    const encoded = encodePowerShell(script);

    expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe(script);
  });
});

describe("windowsLauncher", () => {
  it("has Windows start the script hidden, through WMI, and reports whether it did", () => {
    const script = windowsCleanupScript(7, { kind: "scoop" });
    const launcher = windowsLauncher(script);

    expect(launcher).toContain("Invoke-CimMethod -ClassName Win32_Process -MethodName Create");
    expect(launcher).toContain(`-WindowStyle Hidden -EncodedCommand ${encodePowerShell(script)}'`);
    expect(launcher).toContain("exit $started.ReturnValue");
    // The command line sits in single quotes, so it must not contain one.
    const commandLine = launcher.slice(launcher.indexOf("'") + 1, launcher.lastIndexOf("'"));
    expect(commandLine).not.toContain("'");
  });
});

describe("windowsCleanupScript", () => {
  it("keeps a transcript, and waits for varis before doing anything", () => {
    const lines = windowsCleanupScript(7, { kind: "scoop" }).split("\n");
    expect(lines[0]).toContain("Start-Transcript");
    expect(lines[0]).toContain("varis-dracarys.log");
    expect(lines.findIndex((l) => l.startsWith("Wait-Process -Id 7"))).toBeLessThan(
      lines.indexOf("scoop uninstall varis"),
    );
    expect(lines[lines.length - 1]).toBe("Stop-Transcript | Out-Null");
  });

  it("quotes a path with an apostrophe for PowerShell", () => {
    const script = windowsCleanupScript(1, { kind: "script", installDir: "C:\\Users\\O'Brien\\.varis\\bin" });
    expect(script).toContain("$dir = 'C:\\Users\\O''Brien\\.varis\\bin'");
  });
});
