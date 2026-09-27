# Installs the Varis CLI on Windows.
#
#   irm https://raw.githubusercontent.com/AugustineOjeh/varis-cli/main/install.ps1 | iex
#
# What it does, in order:
#   1. Downloads the Windows archive from the GitHub release, and the
#      release's SHA256SUMS.
#   2. Checks the archive against its checksum, and stops if they differ.
#   3. Unpacks varis.exe into %USERPROFILE%\.varis\bin, replacing any older
#      copy.
#   4. Adds that folder to your user PATH, once.
#
# Nothing needs administrator rights, and nothing outside your user profile
# changes.
#
# Settings, all optional, as environment variables before running it:
#   $env:VARIS_VERSION = "0.2.0"      Install this version instead of the latest.
#   $env:VARIS_INSTALL_DIR = "<dir>"  Install here instead of ~\.varis\bin.
#   $env:VARIS_NO_MODIFY_PATH = "1"   Don't change your PATH.
#
# `varis upgrade` and `varis dracarys` recognise this install by its
# folder, so keep the default unless you have a reason not to.
#
# Written for Windows PowerShell 5.1, which every Windows 10 and 11 machine
# has, and runs unchanged on PowerShell 7.

$ErrorActionPreference = "Stop"

# Everything runs inside this script block, called on the last line. If the
# download of this script stops halfway, that line never runs, so a partial
# script does nothing.
$installVaris = {
  $repository = "AugustineOjeh/varis-cli"
  $issues = "https://github.com/$repository/issues"

  function Fail([string] $message) {
    Write-Host "Error: $message" -ForegroundColor Red
    # `exit` would close the window when run through `irm | iex`, so this
    # throws, which stops the script and leaves the window open.
    throw "varis wasn't installed."
  }

  # PowerShell 5.1 may default to old TLS versions GitHub refuses.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  # The progress bar makes downloads many times slower in PowerShell 5.1.
  $ProgressPreference = "SilentlyContinue"

  # The only Windows build is x64. Windows 11 on ARM runs it through its
  # built-in x64 emulation.
  $arch = $env:PROCESSOR_ARCHITECTURE
  if ($arch -ne "AMD64" -and $arch -ne "ARM64") {
    Fail "varis doesn't support $arch Windows. It runs on 64-bit Windows."
  }

  $installDir = if ($env:VARIS_INSTALL_DIR) { $env:VARIS_INSTALL_DIR } else { Join-Path $HOME ".varis\bin" }
  $archive = "varis-windows-x64.zip"

  # A pinned version comes from its own tag. The latest comes through
  # GitHub's /latest/ redirect, which never points at a pre-release.
  if ($env:VARIS_VERSION) {
    $version = $env:VARIS_VERSION.TrimStart("v")
    $base = "https://github.com/$repository/releases/download/v$version"
    Write-Host "Installing varis $version for Windows."
  } else {
    $base = "https://github.com/$repository/releases/latest/download"
    Write-Host "Installing the latest varis for Windows."
  }

  $work = Join-Path ([IO.Path]::GetTempPath()) ("varis-install-" + [Guid]::NewGuid())
  New-Item -ItemType Directory -Path $work | Out-Null

  try {
    foreach ($file in @($archive, "SHA256SUMS")) {
      try {
        Invoke-WebRequest -UseBasicParsing -Uri "$base/$file" -OutFile (Join-Path $work $file)
      } catch {
        Fail "Couldn't download $base/$file. Check your connection, and that the version exists."
      }
    }

    # Compares the archive's SHA-256 with its line in SHA256SUMS. A
    # mismatch means a corrupted or tampered download.
    $line = Get-Content (Join-Path $work "SHA256SUMS") | Where-Object { $_ -match "\s$([regex]::Escape($archive))$" } | Select-Object -First 1
    if (-not $line) { Fail "SHA256SUMS has no entry for $archive. Please report this: $issues" }
    $expected = ($line -split "\s+")[0].ToLowerInvariant()
    $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $work $archive)).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
      Fail "The download's checksum doesn't match the release's, so nothing was installed. Try again; if it keeps failing, please report it: $issues"
    }

    Expand-Archive -Path (Join-Path $work $archive) -DestinationPath $work -Force
    $downloaded = Join-Path $work "varis.exe"
    if (-not (Test-Path $downloaded)) { Fail "The archive didn't contain varis.exe. Please report this: $issues" }

    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    $target = Join-Path $installDir "varis.exe"
    try {
      Move-Item -Path $downloaded -Destination $target -Force
    } catch {
      Fail "Couldn't replace $target. If varis is running, close it, then run this again."
    }
  } finally {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
  }

  $installed = & $target --version
  if ($LASTEXITCODE -ne 0) {
    Fail "varis was installed to $installDir but won't run on this machine. Please report this: $issues"
  }

  Write-Host ""
  Write-Host "Installed varis $installed to $target." -ForegroundColor Green

  # Added to the user PATH, which needs no administrator rights, and to
  # this window's PATH, so varis works here straight away.
  #
  # Read and written through the registry, not
  # [Environment]::SetEnvironmentVariable: that one expands every
  # %VARIABLE% in the PATH and writes the result back, which permanently
  # breaks entries other programs defined that way.
  $environment = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
  $userPath = $environment.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $entries = @($userPath -split ";" | Where-Object { $_ })
  if ($entries -contains $installDir) {
    Write-Host "Run varis to get started."
  } elseif ($env:VARIS_NO_MODIFY_PATH -eq "1") {
    Write-Host "Add $installDir to your PATH to run varis from anywhere."
  } else {
    $environment.SetValue("Path", (($entries + $installDir) -join ";"), [Microsoft.Win32.RegistryValueKind]::ExpandString)
    # A registry write doesn't tell running programs the PATH changed.
    # Setting and clearing a throwaway variable this way does, so windows
    # opened from now on see the new PATH.
    [Environment]::SetEnvironmentVariable("VARIS_INSTALLER_REFRESH", "1", "User")
    [Environment]::SetEnvironmentVariable("VARIS_INSTALLER_REFRESH", $null, "User")
    $env:Path = "$installDir;$env:Path"
    Write-Host "Added $installDir to your PATH. Run varis to get started; other open windows need restarting first."
  }
  $environment.Close()
}

& $installVaris
