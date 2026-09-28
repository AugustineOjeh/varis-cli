#!/usr/bin/env bash
# Writes the Scoop manifest for one release to stdout.
#
#   scripts/scoop-manifest.sh 0.2.1 path/to/SHA256SUMS >bucket/varis.json
#
# Run by .github/workflows/release.yml, which commits the result to the
# AugustineOjeh/scoop-bucket repository, so developers on Windows can run:
#
#   scoop bucket add varis https://github.com/AugustineOjeh/scoop-bucket
#   scoop install varis/varis
#
# The manifest points at the Windows archive, pinned by its SHA-256 from the
# release's SHA256SUMS, so Scoop refuses a download that doesn't match.
# Scoop unpacks it and puts a shim for varis.exe on the PATH.
#
# There is one Windows build, for x64. The arm64 entry points at it too,
# because Windows 11 on ARM runs x64 programs through its built-in
# emulation, and Scoop's docs don't say what it does when arm64 is missing.
#
# No checkver or autoupdate: this script, run on every release, is what
# keeps the manifest current.

set -euo pipefail

if [ $# -ne 2 ]; then
  echo "Usage: $0 <version> <SHA256SUMS file>" >&2
  exit 2
fi

version="$1"
sums="$2"
url="https://github.com/AugustineOjeh/varis-cli/releases/download/v$version/varis-windows-x64.zip"

# Read before writing anything. A failure inside the heredoc below would only
# end a subshell, and cat would still succeed, writing a manifest without a
# hash.
line="$(grep ' varis-windows-x64.zip$' "$sums")" || {
  echo "SHA256SUMS has no entry for varis-windows-x64.zip" >&2
  exit 1
}
hash="${line%% *}"

cat <<EOF
{
  "version": "$version",
  "description": "Publish services that AI agents discover and pay to call.",
  "homepage": "https://github.com/AugustineOjeh/varis-cli",
  "license": "MIT",
  "architecture": {
    "64bit": {
      "url": "$url",
      "hash": "$hash"
    },
    "arm64": {
      "url": "$url",
      "hash": "$hash"
    }
  },
  "bin": "varis.exe"
}
EOF
