#!/usr/bin/env node
// The varis command. The only file that touches the process: it passes the
// arguments in, and turns the result into an exit code.

import { removeLeftoverUpgrade } from "./commands/upgrade.ts";
import { runCli } from "./lib/cli.ts";
import { processOutput } from "./lib/output.ts";

// On Windows, varis upgrade leaves the replaced binary beside the new one,
// because a running program can't delete itself. The next run removes it.
await removeLeftoverUpgrade();

process.exitCode = await runCli(process.argv.slice(2), processOutput);
