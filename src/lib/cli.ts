import { build } from "../commands/build.ts";
import { init } from "../commands/init.ts";
import { login } from "../commands/login.ts";
import { logout } from "../commands/logout.ts";
import { publish } from "../commands/publish.ts";
import { test } from "../commands/test.ts";
import type { Command } from "./command.ts";
import type { Output } from "./output.ts";
import { reportLines } from "./issues.ts";
import { VERSION } from "./version.ts";

/**
 * The six commands, in the order a new developer meets them. Any new command
 * needs a scope decision first (see project.md in the varis repository).
 */
export const COMMANDS: readonly Command[] = [
  login,
  init,
  build,
  publish,
  test,
  logout,
];

const HELP_FLAGS = new Set(["-h", "--help"]);
const VERSION_FLAGS = new Set(["-v", "--version"]);

export function helpText(): string {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  const commands = COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`)
    .join("\n");

  return `varis ${VERSION}: publish services that AI agents pay for.

Usage: varis <command> [options]

Commands:
${commands}

Options:
  -h, --help     Show help. After a command, show that command's help.
  -v, --version  Show the version.

New here? Run varis publish in your project; it walks you through the rest.`;
}

/**
 * Runs the CLI for `argv`, the arguments after `varis`, and returns the exit
 * code. The entry point (src/cli.ts) is the only caller that touches the
 * process; everything here writes through `output`.
 */
export async function runCli(argv: string[], output: Output): Promise<number> {
  const [first, ...rest] = argv;

  if (first === undefined || HELP_FLAGS.has(first)) {
    output.out(helpText());
    return 0;
  }

  if (VERSION_FLAGS.has(first)) {
    output.out(VERSION);
    return 0;
  }

  const command = COMMANDS.find((c) => c.name === first);
  if (!command) {
    output.err(`Unknown command: ${first}\n`);
    output.err(helpText());
    return 2;
  }

  if (rest.some((arg) => HELP_FLAGS.has(arg))) {
    output.out(command.usage);
    return 0;
  }

  try {
    return await command.run(rest, output);
  } catch (error) {
    // A command reports expected failures itself and returns 1. Reaching here
    // is a bug, so say so plainly rather than leaking a stack trace, and hand
    // the developer a report that already carries what we need.
    const message = error instanceof Error ? error.message : String(error);
    output.err(`varis ${command.name} crashed: ${message}`);
    output.err("This is a bug in the Varis CLI.");
    for (const line of reportLines({
      command: ["varis", command.name, ...rest].join(" "),
      error: message,
    })) {
      output.err(line);
    }
    return 2;
  }
}
