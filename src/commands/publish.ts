import { type Command, notBuiltYet } from "../lib/command.ts";

export const publish: Command = {
  name: "publish",
  summary: "Build, then publish every service in varis.json",
  usage: `Usage: varis publish [service_slug]

  Runs varis init and varis login first if needed, then varis build, then
  publishes each service and reports created, updated, unchanged, or the
  error. Give a service slug to publish only that service.`,
  run: notBuiltYet("publish", "B8"),
};
