import { type Command, notBuiltYet } from "../lib/command.ts";

export const dracarys: Command = {
  name: "dracarys",
  summary: "Burn Varis off this machine: sign out, clean this project, uninstall",
  usage: `Usage: varis dracarys [--yes]

  Asks you to type dracarys to confirm, then:

    - signs this machine out, revoking its token
    - removes this project's varis.json, and the Varis block varis init
      added to AGENTS.md
    - uninstalls the CLI and deletes its config folder

  Your Varis account and your published services are untouched. Other
  projects on this machine keep their varis.json.

  --yes  Skip the confirmation.`,
  run: notBuiltYet("dracarys", "C7"),
};
