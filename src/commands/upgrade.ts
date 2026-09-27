import { type Command, notBuiltYet } from "../lib/command.ts";

export const upgrade: Command = {
  name: "upgrade",
  summary: "Upgrade the Varis CLI to the latest stable version",
  usage: `Usage: varis upgrade

  Upgrades through whatever installed the CLI: Homebrew, Scoop, or the
  install script. Prints the version before and after.`,
  run: notBuiltYet("upgrade", "C6"),
};
