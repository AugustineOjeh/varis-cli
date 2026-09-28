// Finding, downloading, and checking a published release of the CLI, for
// varis upgrade on an install-script copy.
//
// It does what install.sh and install.ps1 do, in TypeScript: find the
// latest version, download this platform's archive and the release's
// SHA256SUMS, check one against the other, and unpack the binary. Keep the
// three in step: the asset names come from .github/workflows/release.yml.

import { createHash } from "node:crypto";
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { REPOSITORY_URL } from "./constants.ts";
import type { Runner } from "./generator.ts";

/**
 * The latest full release's version, such as "0.2.1", or null when there's
 * no full release yet.
 *
 * Read from where GitHub's /releases/latest redirects (.../tag/v0.2.1),
 * not from the GitHub API: the API allows 60 unauthenticated requests an
 * hour per IP address, which a shared office or CI network can use up.
 * /releases/latest never points at a pre-release.
 */
export async function latestVersion(fetchFn: typeof fetch): Promise<string | null> {
  const response = await fetchFn(`${REPOSITORY_URL}/releases/latest`, {
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  const location = response.headers.get("location");
  if (response.status < 300 || response.status >= 400 || !location) return null;
  const match = /\/releases\/tag\/v([^/?#]+)$/.exec(location);
  return match ? match[1]! : null;
}

/**
 * The release asset for this platform, or null where there's no build.
 * Windows on ARM gets the x64 build, which it runs through emulation.
 */
export function releaseAsset(
  platform: NodeJS.Platform,
  arch: string,
): { archive: string; binary: string } | null {
  if (platform === "win32") {
    return { archive: "varis-windows-x64.zip", binary: "varis.exe" };
  }
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : null;
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
  if (!os || !cpu) return null;
  return { archive: `varis-${os}-${cpu}.tar.gz`, binary: "varis" };
}

/**
 * Compares two versions: negative when a is older, 0 when equal, positive
 * when a is newer. Semantic versioning: 0.2.1-rc.1 comes before 0.2.1.
 */
export function compareVersions(a: string, b: string): number {
  const [aCore = "", aPre] = a.split("-", 2) as [string, string | undefined];
  const [bCore = "", bPre] = b.split("-", 2) as [string, string | undefined];
  const aParts = aCore.split(".").map(Number);
  const bParts = bCore.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const difference = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (difference !== 0) return difference;
  }
  // Same x.y.z: a pre-release comes before the release itself.
  if (aPre === undefined || bPre === undefined) {
    return aPre === bPre ? 0 : aPre === undefined ? 1 : -1;
  }
  return aPre.localeCompare(bPre, "en", { numeric: true });
}

export type Downloaded =
  | { ok: true; binary: string }
  | { ok: false; reason: string };

/**
 * Downloads `archive` for `version` into `dir`, checks it against the
 * release's SHA256SUMS, and unpacks it with the system's tar (built into
 * macOS, Linux, and Windows 10 and later, where it reads zip files too).
 * Returns the unpacked binary's path. Nothing is unpacked from an archive
 * whose checksum doesn't match.
 */
export async function downloadRelease(
  version: string,
  asset: { archive: string; binary: string },
  dir: string,
  deps: { fetch: typeof fetch; run: Runner },
): Promise<Downloaded> {
  const base = `${REPOSITORY_URL}/releases/download/v${version}`;

  const get = async (name: string): Promise<Buffer | null> => {
    try {
      const response = await deps.fetch(`${base}/${name}`, {
        signal: AbortSignal.timeout(300_000),
      });
      return response.ok ? Buffer.from(await response.arrayBuffer()) : null;
    } catch {
      return null;
    }
  };

  const [archive, sums] = await Promise.all([get(asset.archive), get("SHA256SUMS")]);
  if (!archive || !sums) {
    return { ok: false, reason: `Couldn't download varis ${version}. Check your connection, then try again.` };
  }

  const line = sums.toString("utf8").split("\n").find((l) => l.trimEnd().endsWith(` ${asset.archive}`));
  const expected = line?.split(/\s+/)[0];
  if (!expected) {
    return { ok: false, reason: `The release's SHA256SUMS has no entry for ${asset.archive}.` };
  }
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== expected) {
    return {
      ok: false,
      reason: "The download's checksum doesn't match the release's, so nothing was changed. Try again.",
    };
  }

  const archivePath = path.join(dir, asset.archive);
  await writeFile(archivePath, archive);
  const unpacked = await deps.run(["tar", "-xf", archivePath, "-C", dir], dir);
  if (unpacked.status === "missing") {
    return { ok: false, reason: "tar is needed to unpack the download, and it isn't installed." };
  }
  if (unpacked.code !== 0) {
    return { ok: false, reason: `Couldn't unpack ${asset.archive}: ${unpacked.stderr.trim()}` };
  }

  const binary = path.join(dir, asset.binary);
  try {
    await stat(binary);
  } catch {
    return { ok: false, reason: `${asset.archive} didn't contain ${asset.binary}.` };
  }
  return { ok: true, binary };
}
