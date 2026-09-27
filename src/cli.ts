#!/usr/bin/env node
// The varis command. The only file that touches the process: it passes the
// arguments in, and turns the result into an exit code.

import { runCli } from "./lib/cli.ts";
import { processOutput } from "./lib/output.ts";

process.exitCode = await runCli(process.argv.slice(2), processOutput);
