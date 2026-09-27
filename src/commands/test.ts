import { type Command, notBuiltYet } from "../lib/command.ts";

export const test: Command = {
  name: "test",
  summary: "Call a published service and show what it returns",
  usage: `Usage: varis test <service_slug> [--input '<json>' | --input-file <path>]

  Calls the published service through Varis, the way an agent would, and
  prints its output, or why the call failed. Test calls are free.

  To fix a failing test, edit the definition or the endpoint, run
  varis publish <service_slug>, and test again.`,
  run: notBuiltYet("test", "B10"),
};
