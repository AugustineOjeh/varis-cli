// Facts about the machine the CLI runs on, for varis login.

import { spawn } from "node:child_process";
import os from "node:os";
import type { Env } from "./constants.ts";

/**
 * What to call this machine on the approval page and in the dashboard's
 * Devices list. The hostname, except in cloud editors, where the hostname is
 * a random string and the environment names the workspace instead.
 *
 * Never blank: the server rejects a blank name, and the developer can't fix
 * a hostname they didn't choose. A long one is fine; the server truncates it.
 */
export function deviceName(env: Env = process.env, hostname = os.hostname()): string {
  if (env.CODESPACE_NAME) return `GitHub Codespaces: ${env.CODESPACE_NAME}`;
  if (env.REPL_SLUG) {
    return `Replit: ${env.REPL_OWNER ? `${env.REPL_OWNER}/` : ""}${env.REPL_SLUG}`;
  }
  if (env.GITPOD_WORKSPACE_ID) return `Gitpod: ${env.GITPOD_WORKSPACE_ID}`;
  return hostname.trim() || "Unknown device";
}

/**
 * Whether a browser opened here would appear in front of the developer.
 * False over SSH, in CI, in cloud editors, and on Linux with no display:
 * there the command prints the link and the developer opens it wherever
 * they are.
 */
export function canOpenBrowser(
  env: Env = process.env,
  platform: typeof process.platform = process.platform,
): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT) return false;
  if (env.CI) return false;
  if (env.CODESPACES || env.REPL_ID || env.GITPOD_WORKSPACE_ID) return false;
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    // WSL can hand a link to the Windows browser.
    return Boolean(env.WSL_DISTRO_NAME);
  }
  return true;
}

/**
 * Opens `url` in the default browser, and doesn't wait for it. Never throws:
 * the link is always printed too, so a browser that fails to open costs
 * nothing.
 */
export function openBrowser(
  url: string,
  platform: typeof process.platform = process.platform,
  env: Env = process.env,
): void {
  const [command, args] = platform === "darwin"
    ? ["open", [url]]
    : platform === "win32"
    // rundll32 takes the URL as one argument, where `start` would re-parse
    // its & and ? characters through cmd.exe.
    ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
    : env.WSL_DISTRO_NAME
    ? ["wslview", [url]]
    : ["xdg-open", [url]];

  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Printed link is the fallback.
  }
}
