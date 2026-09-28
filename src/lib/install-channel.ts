// How this copy of varis was installed, worked out from where its binary
// lives. varis upgrade and varis dracarys both depend on it: each channel
// upgrades and uninstalls its own way, and going around a package manager
// breaks it (Homebrew or Scoop would still list a version that's no longer
// there).
//
// The channels, and the folders that give them away:
//   homebrew  .../Cellar/varis/<version>/bin/varis. Homebrew links
//             /opt/homebrew/bin/varis (or /usr/local/bin/varis, or
//             /home/linuxbrew/.linuxbrew/bin/varis) to that, so the caller
//             resolves symlinks before asking.
//   scoop     ...\scoop\apps\varis\<version or current>\varis.exe. Scoop's
//             shim starts the real binary, which is what runs.
//   script    ~/.varis/bin/varis, where install.sh and install.ps1 put it.
//   source    Node running src/cli.ts: someone working on the CLI itself.
//   unknown   Anywhere else, such as a binary downloaded by hand or
//             installed with VARIS_INSTALL_DIR.

import path from "node:path";

export type Channel =
  | { kind: "homebrew"; binary: string }
  | { kind: "scoop"; binary: string }
  | { kind: "script"; binary: string }
  | { kind: "source" }
  | { kind: "unknown"; binary: string };

/**
 * `binary` is the running executable with symlinks resolved; `home` is the
 * user's home folder. Pure, so tests can pass any platform's paths.
 */
export function detectChannel(
  binary: string,
  home: string,
  platform: NodeJS.Platform,
): Channel {
  const windows = platform === "win32";
  // One separator and, on Windows, one case, so the checks below read the
  // same on every platform. Windows paths are case-insensitive.
  const normalise = (value: string) => {
    const slashes = value.replaceAll("\\", "/");
    return windows ? slashes.toLowerCase() : slashes;
  };
  const file = normalise(binary);
  const name = file.slice(file.lastIndexOf("/") + 1);

  // The CLI run from source is Node (or Bun) running a TypeScript file, so
  // the executable is the runtime, not varis.
  if (/^(node|bun)(\.exe)?$/.test(name)) return { kind: "source" };

  if (file.includes("/cellar/varis/") || file.includes("/Cellar/varis/")) {
    return { kind: "homebrew", binary };
  }
  if (file.includes("/scoop/apps/varis/")) return { kind: "scoop", binary };

  const scriptDir = normalise(path.join(home, ".varis", "bin"));
  if (file.slice(0, file.lastIndexOf("/")) === scriptDir) {
    return { kind: "script", binary };
  }

  return { kind: "unknown", binary };
}
