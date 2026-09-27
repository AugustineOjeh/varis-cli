// varis build: rewrites the services list in varis.json from the code.
//
// Finds the project's language, runs its generator, and reports the result:
// the services built, or every problem with its file and line. The CLI
// never reads source code itself; see src/lib/generator.ts.

import type { Command } from "../lib/command.ts";
import { type Env, SDK_ISSUES_URL } from "../lib/constants.ts";
import {
  detectLanguage,
  type GeneratorOutcome,
  generatorCommand,
  LANGUAGES,
  readOutcome,
  runCommand,
  type Runner,
} from "../lib/generator.ts";
import { MANIFEST_FILE, readManifest } from "../lib/manifest.ts";
import type { Output } from "../lib/output.ts";
import { dim, failure, red, success, yellow } from "../lib/style.ts";
import { VERSION } from "../lib/version.ts";

export type BuildDeps = { cwd: string; env: Env; run: Runner };

const defaultDeps = (): BuildDeps => ({
  cwd: process.cwd(),
  env: process.env,
  run: runCommand,
});

/**
 * The build, for varis build and for varis publish, which builds first.
 * Returns the outcome after reporting it, or null when it couldn't run.
 */
export async function buildProject(
  output: Output,
  deps: BuildDeps,
): Promise<GeneratorOutcome | null> {
  const manifest = await readManifest(deps.cwd);
  if (manifest.status === "missing") {
    output.err(failure(output, `No ${MANIFEST_FILE} in this folder. Run varis init first.`));
    return null;
  }
  if (manifest.status === "invalid") {
    output.err(
      failure(output, `${MANIFEST_FILE} can't be read: ${manifest.reason}. Fix it, or run varis init.`),
    );
    return null;
  }

  const language = await detectLanguage(deps.cwd);
  if (!language) {
    output.err(failure(output, "varis build doesn't recognise this project's language."));
    output.err(`It looks for: ${LANGUAGES.map((l) => `${l.marker} (${l.name})`).join(", ")}.`);
    output.err(
      `For another language, write the services in ${MANIFEST_FILE} by hand, then run varis publish.`,
    );
    return null;
  }

  output.status(`Reading your service definitions (${language.name})…`);
  const ran = await deps.run(generatorCommand(language, deps.env), deps.cwd);

  if (ran.status === "missing") {
    output.err(
      failure(
        output,
        `varis build runs ${ran.program} for a ${language.name} project, and it isn't installed. Install Node.js from https://nodejs.org, then try again.`,
      ),
    );
    return null;
  }

  const outcome = readOutcome(ran.code, ran.stdout, ran.stderr);
  report(outcome, output);
  return outcome;
}

function report(outcome: GeneratorOutcome, output: Output): void {
  switch (outcome.kind) {
    case "built": {
      const count = outcome.services.length;
      output.out(
        success(
          output,
          count === 0
            ? `Built ${MANIFEST_FILE}: no services defined yet.`
            : `Built ${MANIFEST_FILE}: ${count} service${count === 1 ? "" : "s"}.`,
        ),
      );
      for (const slug of outcome.services) output.out(`  ${slug}`);
      for (const warning of outcome.warnings) {
        output.err(yellow(output, `Warning: ${warning}`));
      }
      return;
    }

    case "problems": {
      const count = outcome.problems.length;
      output.err(
        failure(
          output,
          `${count} problem${count === 1 ? "" : "s"} to fix. ${MANIFEST_FILE} wasn't changed.`,
        ),
      );
      for (const problem of outcome.problems) {
        const where = problem.line > 0 ? `${problem.file}:${problem.line}` : problem.file;
        output.err("");
        output.err(`  ${red(output, where || MANIFEST_FILE)}`);
        for (const line of problem.message.split("\n")) output.err(`    ${line}`);
      }
      return;
    }

    case "crashed":
      output.err(failure(output, "The Varis generator crashed. This is a bug in Varis, not your code."));
      output.err(dim(output, outcome.message));
      output.err(`Report it with the output above: ${SDK_ISSUES_URL}/new (CLI ${VERSION})`);
      return;

    case "unexpected":
      output.err(
        failure(output, `The Varis generator failed without saying why (exit ${outcome.code}).`),
      );
      if (outcome.output) output.err(dim(output, outcome.output));
      output.err(
        "If it mentions a download or network problem, check your connection and try again.",
      );
      return;
  }
}

export async function runBuild(
  args: string[],
  output: Output,
  deps: BuildDeps = defaultDeps(),
): Promise<number> {
  if (args.length > 0) {
    output.err(`Unknown option: ${args[0]}. Run varis build --help.`);
    return 2;
  }
  const outcome = await buildProject(output, deps);
  return outcome?.kind === "built" ? 0 : 1;
}

export const build: Command = {
  name: "build",
  summary: "Update varis.json from the services defined in your code",
  usage: `Usage: varis build

  Finds your project's language and runs its Varis generator, which reads
  every define call and rewrites the services list in varis.json. Nothing in
  varis.json changes unless every service builds.

  Supported: ${LANGUAGES.map((l) => `${l.name} (found by ${l.marker})`).join(", ")}.
  For another language, write the services in varis.json by hand.`,
  run: (args, output) => runBuild(args, output),
};
