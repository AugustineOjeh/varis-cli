import { type Command, notBuiltYet } from "../lib/command.ts";

export const logout: Command = {
  name: "logout",
  summary: "Sign this machine out of Varis",
  usage: `Usage: varis logout

  Revokes this machine's token and deletes it. Other machines stay signed in.`,
  run: notBuiltYet("logout", "B5"),
};
