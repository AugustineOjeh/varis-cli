import { type Command, notBuiltYet } from "../lib/command.ts";

export const init: Command = {
  name: "init",
  summary: "Set up varis.json in this project",
  usage: `Usage: varis init

  Signs in if needed, asks which owner the project publishes for and its
  production base URL, and writes varis.json. Also points coding agents at
  the Varis SDK instructions from AGENTS.md.`,
  run: notBuiltYet("init", "B6"),
};
