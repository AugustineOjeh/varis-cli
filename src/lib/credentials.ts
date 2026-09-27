// The credentials file: where `varis login` keeps this machine's device token.
//
//   macOS, Linux  ~/.config/varis/credentials.toml, or $XDG_CONFIG_HOME/varis
//   Windows       %APPDATA%\varis\credentials.toml
//
// One token per API origin, so a token from a local app is never sent to
// production, and a developer can be signed in to both at once:
//
//   ["https://api.varis.my"]
//   token = "var_dt_..."
//
// The shape is fixed, so a small strict parser reads it rather than a TOML
// library. Anything that doesn't match reads as corrupt, never as a crash.
//
// The file signs in as its owner, so only they may read it: the file is 0600
// and its folder 0700. An existing file readable by anyone else is tightened
// on read. Windows keeps %APPDATA% per user, and ignores these modes.

import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Where to look, injectable so tests never touch the real home directory. */
export type CredentialsLocation = {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
};

export const defaultLocation = (): CredentialsLocation => ({
  env: process.env,
  platform: process.platform,
  home: os.homedir(),
});

export type ReadResult =
  | { status: "signed_in"; token: string }
  | { status: "signed_out" }
  | { status: "corrupt"; path: string; reason: string };

/** A device token, as issued by POST /v1/cli/device/token. */
const TOKEN_PATTERN = /^var_dt_[0-9A-Za-z]{40}$/;

const HEADER = `# Written by varis login. This file signs in as you: keep it private.
# One section per Varis API. Run varis logout to remove this machine's token.
`;

export function credentialsPath(
  location: CredentialsLocation = defaultLocation(),
): string {
  const { env, platform, home } = location;

  if (platform === "win32") {
    const appData = env.APPDATA?.trim() ||
      path.win32.join(home, "AppData", "Roaming");
    return path.win32.join(appData, "varis", "credentials.toml");
  }

  // XDG_CONFIG_HOME must be absolute to count, per the XDG spec.
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const configHome = xdg && path.isAbsolute(xdg)
    ? xdg
    : path.join(home, ".config");
  return path.join(configHome, "varis", "credentials.toml");
}

/** The token for `origin`, or why there isn't one. */
export async function readToken(
  origin: string,
  location: CredentialsLocation = defaultLocation(),
): Promise<ReadResult> {
  const file = credentialsPath(location);

  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isNotFound(error)) return { status: "signed_out" };
    throw error;
  }

  if (location.platform !== "win32") await tightenIfExposed(file);

  const parsed = parseCredentials(text);
  if (!parsed.ok) return { status: "corrupt", path: file, reason: parsed.reason };

  const token = parsed.tokens.get(origin);
  return token ? { status: "signed_in", token } : { status: "signed_out" };
}

/**
 * Stores `token` for `origin`, keeping any other origin's token. A corrupt
 * file is replaced rather than merged: the new sign-in is what the developer
 * asked for, and the old contents can't be trusted.
 */
export async function saveToken(
  origin: string,
  token: string,
  location: CredentialsLocation = defaultLocation(),
): Promise<void> {
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error("Refusing to save something that isn't a device token.");
  }

  const tokens = await existingTokens(location);
  tokens.set(origin, token);
  await writeCredentials(tokens, location);
}

/**
 * Removes `origin`'s token. Deletes the file once no tokens are left.
 * Returns false when there was nothing to remove.
 */
export async function deleteToken(
  origin: string,
  location: CredentialsLocation = defaultLocation(),
): Promise<boolean> {
  const file = credentialsPath(location);
  const tokens = await existingTokens(location);
  const removed = tokens.delete(origin);

  if (tokens.size === 0) {
    await rm(file, { force: true });
  } else if (removed) {
    await writeCredentials(tokens, location);
  }
  return removed;
}

/** The file's tokens, or none when it is missing or corrupt. */
async function existingTokens(
  location: CredentialsLocation,
): Promise<Map<string, string>> {
  try {
    const parsed = parseCredentials(
      await readFile(credentialsPath(location), "utf8"),
    );
    return parsed.ok ? parsed.tokens : new Map();
  } catch (error) {
    if (isNotFound(error)) return new Map();
    throw error;
  }
}

/**
 * Writes to a temporary file in the same folder and renames it into place,
 * so a crash mid-write never leaves a half-written file. The mode is set on
 * creation, so the token is never readable by others, even briefly.
 */
async function writeCredentials(
  tokens: Map<string, string>,
  location: CredentialsLocation,
): Promise<void> {
  const file = credentialsPath(location);
  const folder = path.dirname(file);
  const posix = location.platform !== "win32";

  await mkdir(folder, { recursive: true, mode: 0o700 });
  // mkdir leaves an existing folder's mode alone.
  if (posix) await chmod(folder, 0o700);

  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, serialiseCredentials(tokens), { mode: 0o600 });
  if (posix) await chmod(temporary, 0o600);
  await rename(temporary, file);
}

async function tightenIfExposed(file: string): Promise<void> {
  const { mode } = await stat(file);
  if ((mode & 0o077) !== 0) await chmod(file, 0o600);
}

type Parsed =
  | { ok: true; tokens: Map<string, string> }
  | { ok: false; reason: string };

/**
 * The strict reader. Accepts comments, blank lines, `["origin"]` section
 * headers, and `token = "..."` lines inside a section. Nothing else.
 */
export function parseCredentials(text: string): Parsed {
  const tokens = new Map<string, string>();
  let origin: string | null = null;
  const lines = text.split(/\r?\n/);

  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;

    const header = /^\[\s*"([^"\\]+)"\s*\]$/.exec(line);
    if (header) {
      origin = header[1]!;
      if (tokens.has(origin)) {
        return { ok: false, reason: `"${origin}" appears twice.` };
      }
      continue;
    }

    const entry = /^token\s*=\s*"([^"\\]*)"$/.exec(line);
    if (entry) {
      if (origin === null) {
        return { ok: false, reason: `line ${index + 1}: a token outside any section.` };
      }
      const token = entry[1]!;
      if (!TOKEN_PATTERN.test(token)) {
        return { ok: false, reason: `line ${index + 1}: not a device token.` };
      }
      tokens.set(origin, token);
      continue;
    }

    return { ok: false, reason: `line ${index + 1} isn't something varis wrote.` };
  }

  return { ok: true, tokens };
}

export function serialiseCredentials(tokens: Map<string, string>): string {
  const sections = [...tokens.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([origin, token]) => `["${origin}"]\ntoken = "${token}"\n`);
  return `${HEADER}\n${sections.join("\n")}`;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}
