// Undoing an install, for varis dracarys.
//
// install.sh adds one marked line to a shell startup file; install.ps1
// adds one entry to the Windows user PATH. These helpers take them back out,
// touching nothing else in those files.
//
// WINDOWS CAN'T DELETE A RUNNING PROGRAM
// While varis.exe runs, Windows won't delete it, and Scoop's uninstall
// fails on it the same way. So on Windows, dracarys hands the last steps
// to a small PowerShell script started in the background: it waits for
// varis to exit, then uninstalls through Scoop or deletes the install
// folder and its PATH entry. By the time the developer reads the final
// message, it's already waiting.
//
// That script must outlive varis, and a child process can't be trusted to:
// on Windows, children can sit in a job object that kills them when the
// parent exits, and a compiled Bun binary's detached spawn doesn't escape
// it (0.3.2 and 0.3.3 lost the script this way, before it logged a line).
// So varis doesn't start the script itself. It asks Windows to, through
// WMI's Win32_Process.Create: the new process belongs to the WMI service,
// not to varis, so nothing ties its life to ours.

import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Env } from "./constants.ts";

/** The comment install.sh writes above the PATH line it adds. */
export const PATH_MARKER = "# Added by the Varis installer";

/** Every startup file install.sh might have added its PATH line to. */
export function shellProfiles(home: string, env: Env): string[] {
  return [
    path.join(env.ZDOTDIR?.trim() || home, ".zshrc"),
    path.join(home, ".bash_profile"),
    path.join(home, ".bashrc"),
    path.join(home, ".profile"),
    path.join(home, ".config", "fish", "config.fish"),
  ];
}

/**
 * Removes install.sh's PATH line, its marker, and the blank line before
 * them, from each startup file that has them. Only a line that mentions
 * varis is removed after a marker, so a hand-edited file loses nothing
 * else. Returns the files changed.
 */
export async function removePathLines(files: string[]): Promise<string[]> {
  const changed: string[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    const kept: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === PATH_MARKER && lines[i + 1]?.includes(".varis")) {
        // install.sh writes a blank line first; take it back out too.
        if (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
        i++;
        continue;
      }
      kept.push(lines[i]!);
    }
    const next = kept.join("\n");
    if (next !== text) {
      await writeFile(file, next);
      changed.push(file);
    }
  }
  return changed;
}

/** What the background PowerShell script finishes after varis exits. */
export type WindowsCleanup =
  | { kind: "scoop" }
  /** The install folder, such as C:\Users\Ada\.varis\bin. */
  | { kind: "script"; installDir: string };

/**
 * The PowerShell script that waits for process `pid` (this varis) to exit,
 * then finishes the uninstall. Paths are quoted for PowerShell's single
 * quotes, which only need ' doubled.
 */
export function windowsCleanupScript(pid: number, cleanup: WindowsCleanup): string {
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const lines = [
    // Runs hidden, so it keeps a record of what it did, for when something
    // is left behind: %TEMP%\varis-dracarys.log.
    `Start-Transcript -Path (Join-Path $env:TEMP "${DRACARYS_LOG}") -Force | Out-Null`,
    `$ErrorActionPreference = "Continue"`,
    `Wait-Process -Id ${pid} -Timeout 120 -ErrorAction SilentlyContinue`,
  ];

  if (cleanup.kind === "scoop") {
    lines.push("scoop uninstall varis", "scoop bucket rm varis");
  } else {
    // The same registry route install.ps1 takes, so %VARIABLE% entries in
    // the PATH survive, then the throwaway variable that tells running
    // programs the PATH changed.
    lines.push(
      `$dir = ${quote(cleanup.installDir)}`,
      `$environment = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)`,
      `$current = $environment.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)`,
      `$kept = @($current -split ";" | Where-Object { $_ -and $_ -ne $dir })`,
      `$environment.SetValue("Path", ($kept -join ";"), [Microsoft.Win32.RegistryValueKind]::ExpandString)`,
      `$environment.Close()`,
      `[Environment]::SetEnvironmentVariable("VARIS_INSTALLER_REFRESH", "1", "User")`,
      `[Environment]::SetEnvironmentVariable("VARIS_INSTALLER_REFRESH", $null, "User")`,
      // ~\.varis, the folder install.ps1 made around bin.
      `Remove-Item -Recurse -Force (Split-Path -Parent $dir)`,
    );
  }
  lines.push("Stop-Transcript | Out-Null");
  return lines.join("\n");
}

/** Where the background script's transcript goes, in %TEMP%. */
export const DRACARYS_LOG = "varis-dracarys.log";

/**
 * The script as PowerShell's -EncodedCommand takes it: base64 of its
 * UTF-16LE bytes. Passing a multi-line script with quotes as a plain
 * -Command argument goes through Windows' command-line quoting rules, which
 * can mangle it; an encoded command is letters, digits, +, / and =, which
 * survive any quoting.
 */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/** The PowerShell command line that runs `script`, hidden. */
function hiddenPowerShell(script: string): string {
  return `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ${encodePowerShell(script)}`;
}

/**
 * The short PowerShell command varis runs, and waits for, to have Windows
 * start `script` independently of varis. Win32_Process.Create answers with
 * 0 once the process is running; any other value is a failure code. The
 * command line is base64 and fixed flags, with no quote in it, so it's safe
 * inside the single quotes.
 */
export function windowsLauncher(script: string): string {
  return [
    `$started = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${hiddenPowerShell(script)}' }`,
    `exit $started.ReturnValue`,
  ].join("\n");
}

/**
 * Starts `script` in a hidden PowerShell that outlives this process, and
 * throws if Windows didn't start it. Returns as soon as it's running: the
 * script itself is waiting for varis to exit.
 */
export function startDetachedPowerShell(script: string): void {
  const launched = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowerShell(windowsLauncher(script))],
    { stdio: "ignore", windowsHide: true, timeout: 60_000 },
  );
  if (launched.error) throw launched.error;
  if (launched.status !== 0) {
    throw new Error(`Windows didn't start the uninstall script (Win32_Process.Create returned ${launched.status}).`);
  }
}
