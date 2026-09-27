// varis logout: signs this machine out.
//
// Revokes the token at the server that issued it, which the credentials file
// records, then deletes the file. The file goes even when the server can't
// be reached, because the developer asked for this machine to be signed out;
// the message then says the token stays active until it expires or is
// revoked from the dashboard.

import { apiRequest, type ApiRequestFn } from "../lib/api.ts";
import type { Command } from "../lib/command.ts";
import {
  type CredentialsLocation,
  defaultLocation,
  deleteToken,
  readCredentials,
} from "../lib/credentials.ts";
import type { Output } from "../lib/output.ts";
import { success, yellow } from "../lib/style.ts";

export type LogoutDeps = {
  credentials: CredentialsLocation;
  request: ApiRequestFn;
};

const defaultDeps = (): LogoutDeps => ({
  credentials: defaultLocation(),
  request: apiRequest,
});

export async function runLogout(
  args: string[],
  output: Output,
  deps: LogoutDeps = defaultDeps(),
): Promise<number> {
  if (args.length > 0) {
    output.err(`Unknown option: ${args[0]}. Run varis logout --help.`);
    return 2;
  }

  const stored = await readCredentials(deps.credentials);

  if (stored.status === "signed_out") {
    output.out("This machine isn't signed in. Nothing to do.");
    return 0;
  }

  if (stored.status === "corrupt") {
    // No token can be read out of it, so there is nothing to revoke.
    await deleteToken(deps.credentials);
    output.out(success(output, `Removed a damaged credentials file at ${stored.path}.`));
    return 0;
  }

  const { token, api } = stored.credentials;
  const revoked = await deps.request("POST", "/v1/cli/logout", {
    auth: "none",
    bearer: token,
    origin: api,
    credentials: deps.credentials,
  });

  await deleteToken(deps.credentials);

  // Signed out on the server, or the server already refuses the token
  // (revoked from the dashboard, or expired). Either way it's dead.
  if (revoked.ok || revoked.error.kind === "rejected_token") {
    output.out(success(output, "Signed out. This machine's token is revoked."));
    return 0;
  }

  output.out(success(output, "Signed out of this machine."));
  output.err(
    yellow(
      output,
      `Couldn't revoke the token on the server, so it stays active until it expires or you revoke it in the dashboard under Settings > Devices. ${revoked.error.message}`,
    ),
  );
  return 0;
}

export const logout: Command = {
  name: "logout",
  summary: "Sign this machine out of Varis",
  usage: `Usage: varis logout

  Revokes this machine's token and deletes it. Other machines stay signed in;
  sign them out from the dashboard under Settings > Devices.

  If Varis can't be reached, the token is still deleted from this machine,
  and stays active on the server until it expires or you revoke it there.`,
  run: (args, output) => runLogout(args, output),
};
