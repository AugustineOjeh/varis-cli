// varis init: sets up varis.json in the current project, or changes it.
//
// Connects the project to an owner and writes varis.json. It asks at most
// one question, which owner, and only when there is more than one. The base
// URLs are set by flags, not prompts: --base-url for production and
// --test-base-url for varis test. Re-running it keeps the services list and
// every value not given, so it is also how any setting changes later.
//
// Also leaves a note for coding agents: a marked block in AGENTS.md pointing
// at the SDK's instructions, and the @AGENTS.md import in CLAUDE.md.
//
// Order matters: everything is checked, and every question answered, before
// anything is written. A cancelled prompt or a bad flag leaves the project
// exactly as it was.

import { parseArgs } from "node:util";
import {
  ensureClaudeImport,
  type FileChange,
  upsertAgentsBlock,
} from "../lib/agent-instructions.ts";
import { apiRequest, type ApiRequestFn } from "../lib/api.ts";
import {
  baseUrlProblem,
  normaliseBaseUrl,
  testBaseUrlProblem,
} from "../lib/base-url.ts";
import type { Command } from "../lib/command.ts";
import { apiOrigin, ENDPOINTS_DOCS_URL, type Env } from "../lib/constants.ts";
import {
  type CredentialsLocation,
  defaultLocation,
  readToken,
} from "../lib/credentials.ts";
import {
  type Manifest,
  MANIFEST_FILE,
  readManifest,
  writeManifest,
} from "../lib/manifest.ts";
import type { Output } from "../lib/output.ts";
import { type Prompter, terminalPrompter } from "../lib/prompt.ts";
import { dim, failure, success } from "../lib/style.ts";
import { loginDeps, runLogin } from "./login.ts";

type Owner = { id: string; name: string; role: string };

export type InitDeps = {
  cwd: string;
  env: Env;
  credentials: CredentialsLocation;
  request: ApiRequestFn;
  prompter: Prompter;
  /** Runs varis login. Returns its exit code. */
  signIn: (output: Output) => Promise<number>;
};

/** The real dependencies, with any overridden: publish shares its own. */
export const initDeps = (overrides: Partial<InitDeps> = {}): InitDeps => ({
  ...defaultDeps(),
  ...overrides,
});

const defaultDeps = (): InitDeps => {
  const env = process.env;
  const credentials = defaultLocation();
  return {
    cwd: process.cwd(),
    env,
    credentials,
    request: apiRequest,
    prompter: terminalPrompter(),
    signIn: (output) =>
      runLogin([], output, loginDeps({ env, credentials, request: apiRequest })),
  };
};

type Flags = { owner?: string; baseUrl?: string; testBaseUrl?: string };

function parseFlags(args: string[]): Flags | { error: string } {
  try {
    const { values } = parseArgs({
      args,
      options: {
        owner: { type: "string" },
        "base-url": { type: "string" },
        "test-base-url": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    });
    return {
      owner: values.owner,
      baseUrl: values["base-url"],
      testBaseUrl: values["test-base-url"],
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

const label = (output: Output, owner: Owner) =>
  `${owner.name} ${dim(output, `(${owner.id})`)}`;

export async function runInit(
  args: string[],
  output: Output,
  deps: InitDeps = defaultDeps(),
): Promise<number> {
  const flags = parseFlags(args);
  if ("error" in flags) {
    output.err(`${flags.error} Run varis init --help.`);
    return 2;
  }

  // Checked first, so a typo fails before a sign-in or a prompt.
  if (flags.baseUrl !== undefined) {
    const problem = baseUrlProblem(flags.baseUrl);
    if (problem) {
      output.err(failure(output, `--base-url ${problem}.`));
      return 1;
    }
  }
  if (flags.testBaseUrl !== undefined) {
    const problem = testBaseUrlProblem(flags.testBaseUrl);
    if (problem) {
      output.err(failure(output, `--test-base-url ${problem}.`));
      return 1;
    }
  }

  const found = await readManifest(deps.cwd);
  if (found.status === "invalid") {
    output.err(
      failure(
        output,
        `${MANIFEST_FILE} in this folder can't be read: ${found.reason}. Fix or delete it, then run varis init again.`,
      ),
    );
    return 1;
  }
  const existing: Manifest = found.status === "found" ? found.manifest : {};

  // Signed in to this server, or sign in now.
  const token = await readToken(apiOrigin(deps.env), deps.credentials);
  if (token.status !== "signed_in") {
    output.err("You need to sign in first.");
    output.err("");
    const signedIn = await deps.signIn(output);
    if (signedIn !== 0) return signedIn;
    output.err("");
  }

  const listed = await deps.request<{ owners: Owner[] }>("GET", "/v1/me/owners", {
    auth: "device",
    env: deps.env,
    credentials: deps.credentials,
  });
  if (!listed.ok) {
    output.err(failure(output, `Couldn't load your owners. ${listed.error.message}`));
    return 1;
  }
  const owners = listed.body.owners;
  if (owners.length === 0) {
    output.err(failure(output, "Your account doesn't belong to any owner yet."));
    return 1;
  }

  const owner = await chooseOwner(owners, flags, existing, output, deps.prompter);
  if (owner === null) return 1;

  const baseUrl = flags.baseUrl !== undefined
    ? normaliseBaseUrl(flags.baseUrl)
    : existing.base_url;
  const testBaseUrl = flags.testBaseUrl !== undefined
    ? normaliseBaseUrl(flags.testBaseUrl)
    : existing.test_base_url;

  // Every answer is in. Only now does anything change on disk.
  const written = await writeManifest(deps.cwd, {
    ...existing,
    owner_id: owner.id,
    ...(baseUrl !== undefined && { base_url: baseUrl }),
    ...(testBaseUrl !== undefined && { test_base_url: testBaseUrl }),
    services: existing.services ?? [],
  });
  const agents = await upsertAgentsBlock(deps.cwd);
  const claude = await ensureClaudeImport(deps.cwd);

  output.out(
    success(
      output,
      written === "unchanged"
        ? `${MANIFEST_FILE} is already up to date.`
        : `${found.status === "found" ? "Updated" : "Created"} ${MANIFEST_FILE}.`,
    ),
  );
  const notSet = dim(output, "not set");
  output.out(`  Owner:          ${label(output, owner)}`);
  output.out(`  Base URL:       ${baseUrl ?? notSet}`);
  output.out(`  Test base URL:  ${testBaseUrl ?? notSet}`);
  const touched = [
    describe("AGENTS.md", agents),
    describe("CLAUDE.md", claude),
  ].filter(Boolean);
  if (touched.length > 0) output.out(`  ${touched.join(", ")}.`);

  output.out("");
  if (baseUrl === undefined || testBaseUrl === undefined) {
    output.out("Set where your services live, and where to test them:");
    output.out("");
    output.out(
      `  varis init --base-url ${baseUrl ?? "<BASE_URL>"} --test-base-url ${testBaseUrl ?? "<TEST_BASE_URL>"}`,
    );
    output.out("");
  }
  output.out(
    "Each service sets a path, joined to base_url when you publish and to test_base_url when you run varis test, or a full endpoint_url, used as written.",
  );
  output.out(`Learn more: ${ENDPOINTS_DOCS_URL}`);
  output.out("");
  output.out("Next: define a service with the Varis SDK, then run varis publish.");
  return 0;
}

function describe(file: string, change: FileChange): string | null {
  if (change === "created") return `created ${file}`;
  if (change === "updated") return `updated ${file}`;
  return null;
}

/**
 * The owner to write, or null after saying why there isn't one. In order:
 * the --owner flag; the only owner; a choice from the list; the existing
 * owner_id when nothing can be asked.
 */
async function chooseOwner(
  owners: Owner[],
  flags: Flags,
  existing: Manifest,
  output: Output,
  prompter: Prompter,
): Promise<Owner | null> {
  const listOwners = () => {
    for (const o of owners) output.err(`  ${label(output, o)}`);
  };

  if (flags.owner !== undefined) {
    const match = owners.find((o) => o.id === flags.owner);
    if (!match) {
      output.err(
        failure(output, `You don't belong to an owner with the ID ${flags.owner}. Yours:`),
      );
      listOwners();
      return null;
    }
    return match;
  }

  if (owners.length === 1) return owners[0]!;

  if (prompter.interactive) {
    const current = owners.findIndex((o) => o.id === existing.owner_id);
    const chosen = await prompter.select(
      "Which owner does this project publish for?",
      owners.map((o) => ({ label: o.name, hint: `(${o.id})`, value: o })),
      current === -1 ? 0 : current,
    );
    if (chosen === null) {
      output.err("Cancelled. Nothing was changed.");
      return null;
    }
    return chosen;
  }

  const current = owners.find((o) => o.id === existing.owner_id);
  if (current) return current;

  output.err(
    failure(output, "You belong to several owners. Choose one with --owner <id>:"),
  );
  listOwners();
  return null;
}

export const init: Command = {
  name: "init",
  summary: "Set up varis.json in this project",
  usage: `Usage: varis init [--owner <id>] [--base-url <url>] [--test-base-url <url>]

  Sets up varis.json in this folder and connects it to your owner. Signs you
  in first if needed. Run it again to change any setting; it keeps your
  services and every setting you don't give.

  Also adds a short note for coding agents to AGENTS.md, and makes sure
  CLAUDE.md reads it. Only the text between Varis's markers is ever changed.

  --owner <id>             Use this owner instead of choosing from a list.
                           Only asked when you belong to more than one.
  --base-url <url>         Your production address, over https. Each
                           service's path is joined to it when you publish.
  --test-base-url <url>    Where varis test calls, such as
                           http://localhost:3000. Never sent when you publish.

  Learn more: ${ENDPOINTS_DOCS_URL}`,
  run: (args, output) => runInit(args, output),
};
