import { type Command, notBuiltYet } from "../lib/command.ts";

export const build: Command = {
  name: "build",
  summary: "Update varis.json from the services defined in your code",
  usage: `Usage: varis build

  Detects the project's language and runs its Varis generator, which reads
  every define call and rewrites the services list in varis.json.`,
  run: notBuiltYet("build", "B7"),
};
