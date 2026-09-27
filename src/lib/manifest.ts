// varis.json: the project's service manifest, committed with its code.
//
// varis init writes owner_id, base_url, and test_base_url. varis build owns
// services, and varis publish sends only services, so test_base_url never
// leaves the machine. Any
// other key is kept exactly as found, so a newer CLI's fields survive an
// older one's write. It never holds a token.

import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const MANIFEST_FILE = "varis.json";

export type Manifest = {
  owner_id?: string;
  base_url?: string;
  test_base_url?: string;
  services?: unknown[];
  [key: string]: unknown;
};

export type ManifestResult =
  | { status: "found"; manifest: Manifest }
  | { status: "missing" }
  | { status: "invalid"; reason: string };

export function manifestPath(projectDir: string): string {
  return path.join(projectDir, MANIFEST_FILE);
}

export async function readManifest(projectDir: string): Promise<ManifestResult> {
  let text: string;
  try {
    text = await readFile(manifestPath(projectDir), "utf8");
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ENOENT") {
      return { status: "missing" };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: "invalid", reason: "it isn't valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { status: "invalid", reason: "it isn't a JSON object" };
  }
  return { status: "found", manifest: parsed as Manifest };
}

/**
 * Writes varis.json with owner_id and base_url first and services last, the
 * same order the generator keeps, so a git diff shows only real changes.
 * Two-space indent and a trailing newline, like the generator's output.
 */
export async function writeManifest(
  projectDir: string,
  manifest: Manifest,
): Promise<"written" | "unchanged"> {
  const text = manifestText(manifest);
  const file = manifestPath(projectDir);

  const current = await readFile(file, "utf8").catch(() => null);
  if (current === text) return "unchanged";

  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, text);
  await rename(temporary, file);
  return "written";
}

/** The exact text writeManifest writes for `manifest`. */
export function manifestText(manifest: Manifest): string {
  const { owner_id, base_url, test_base_url, services, ...rest } = manifest;
  const ordered: Manifest = {
    ...(owner_id !== undefined && { owner_id }),
    ...(base_url !== undefined && { base_url }),
    ...(test_base_url !== undefined && { test_base_url }),
    ...rest,
    services: services ?? [],
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
