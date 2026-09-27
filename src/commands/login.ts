import { type Command, notBuiltYet } from "../lib/command.ts";

export const login: Command = {
  name: "login",
  summary: "Sign in to Varis on this machine",
  usage: `Usage: varis login

  Opens a browser to approve this machine, then stores a token for it in your
  user config directory. One sign-in covers every project on this machine.`,
  run: notBuiltYet("login", "B4"),
};
