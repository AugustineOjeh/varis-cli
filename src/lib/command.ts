import type { Output } from "./output.ts";

/**
 * One `varis <command>`. Each lives in its own file under src/commands/.
 *
 * `run` returns the process exit code: 0 for success, 1 for a failure the
 * developer can fix, 2 for a crash or a usage mistake. It gets the arguments
 * after the command name, and never calls process.exit itself, so a test can
 * run it in-process.
 */
export type Command = {
  name: string;
  /** One line, shown in `varis --help`. */
  summary: string;
  /** The full text of `varis <command> --help`. */
  usage: string;
  run: (args: string[], output: Output) => Promise<number>;
};

/**
 * A command that exists in the help but isn't built yet. Replaced step by
 * step through Phase B of the CLI plan.
 */
export function notBuiltYet(name: string, step: string): Command["run"] {
  return async (_args, output) => {
    output.err(`varis ${name} isn't built yet (CLI plan ${step}).`);
    return 1;
  };
}
