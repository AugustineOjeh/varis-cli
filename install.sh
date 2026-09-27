#!/bin/sh
# Installs the Varis CLI on macOS or Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/AugustineOjeh/varis-cli/main/install.sh | sh
#
# What it does, in order:
#   1. Works out this machine's platform: macOS or Linux, on Apple silicon,
#      ARM, or x64.
#   2. Downloads that platform's archive from the GitHub release, and the
#      release's SHA256SUMS.
#   3. Checks the archive against its checksum, and stops if they differ.
#   4. Unpacks varis into ~/.varis/bin, replacing any older copy.
#   5. Adds ~/.varis/bin to your PATH in your shell's startup file, once.
#
# Nothing needs root, and nothing outside your home folder changes.
#
# Settings, all optional, as environment variables before `sh`:
#   VARIS_VERSION=0.2.0      Install this version instead of the latest.
#   VARIS_INSTALL_DIR=<dir>  Install here instead of ~/.varis/bin.
#   VARIS_NO_MODIFY_PATH=1   Don't touch any shell startup file.
#
# `varis upgrade` and `varis dracarys` recognise this install by its
# folder, so keep the default unless you have a reason not to.
#
# Plain POSIX sh, not bash: some systems' sh isn't bash, and this runs
# before anything else is installed.

set -eu

REPOSITORY="AugustineOjeh/varis-cli"

# Everything runs inside main, called on the last line. If the download of
# this script stops halfway, sh never reaches that line, so a partial script
# runs nothing.
main() {
  install_dir="${VARIS_INSTALL_DIR:-$HOME/.varis/bin}"

  need tar
  need gzip
  need uname
  need mktemp
  if ! has curl && ! has wget; then
    fail "curl or wget is needed to download varis. Install one, then run this again."
  fi

  target="$(detect_target)"
  archive="varis-$target.tar.gz"

  # A pinned version comes from its own tag. The latest comes through
  # GitHub's /latest/ redirect, which never points at a pre-release.
  if [ -n "${VARIS_VERSION:-}" ]; then
    version="${VARIS_VERSION#v}"
    base="https://github.com/$REPOSITORY/releases/download/v$version"
    say "Installing varis $version for $target."
  else
    base="https://github.com/$REPOSITORY/releases/latest/download"
    say "Installing the latest varis for $target."
  fi

  work="$(mktemp -d)"
  # Clean up the download however the script ends.
  trap 'rm -rf "$work"' EXIT

  download "$base/$archive" "$work/$archive"
  download "$base/SHA256SUMS" "$work/SHA256SUMS"
  verify_checksum "$work" "$archive"

  tar -xzf "$work/$archive" -C "$work"
  [ -f "$work/varis" ] || fail "The archive didn't contain varis. Please report this: https://github.com/$REPOSITORY/issues"

  # Moved into place in one step, so a running varis is never left half
  # overwritten, and an older copy is simply replaced.
  mkdir -p "$install_dir"
  chmod +x "$work/varis"
  mv -f "$work/varis" "$install_dir/varis"

  installed="$("$install_dir/varis" --version 2>/dev/null)" ||
    fail "varis was installed to $install_dir but won't run on this machine. Please report this, with the output of uname -a: https://github.com/$REPOSITORY/issues"

  say ""
  say "Installed varis $installed to $install_dir/varis."
  add_to_path "$install_dir"
}

# macOS or Linux, and the CPU, as the release names them.
detect_target() {
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Darwin) os="darwin" ;;
    Linux) os="linux" ;;
    MINGW* | MSYS* | CYGWIN*)
      fail "On Windows, install with PowerShell instead: irm https://raw.githubusercontent.com/$REPOSITORY/main/install.ps1 | iex"
      ;;
    *) fail "varis doesn't support $os yet. It runs on macOS, Linux, and Windows." ;;
  esac

  case "$arch" in
    x86_64 | amd64) arch="x64" ;;
    arm64 | aarch64) arch="arm64" ;;
    *) fail "varis doesn't support the $arch processor yet. It runs on x64 and ARM64." ;;
  esac

  # A terminal running under Rosetta on Apple silicon reports x86_64.
  # The native build is faster, so prefer it.
  if [ "$os" = "darwin" ] && [ "$arch" = "x64" ] &&
    [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
    arch="arm64"
  fi

  # The Linux builds need glibc. Alpine and other musl systems can't run
  # them, so say so now rather than fail with a cryptic error later.
  if [ "$os" = "linux" ] && ldd --version 2>&1 | grep -qi musl; then
    fail "varis doesn't support musl-based Linux, such as Alpine, yet. Use a glibc-based distribution or image, such as Debian or Ubuntu."
  fi

  echo "$os-$arch"
}

download() {
  if has curl; then
    curl --fail --silent --show-error --location --retry 3 --output "$2" "$1" ||
      fail "Couldn't download $1. Check your connection, and that the version exists."
  else
    wget --quiet --tries=3 --output-document="$2" "$1" ||
      fail "Couldn't download $1. Check your connection, and that the version exists."
  fi
}

# Compares the archive's SHA-256 with its line in SHA256SUMS. A mismatch
# means a corrupted or tampered download, so nothing is installed.
verify_checksum() {
  expected="$(grep " $2\$" "$1/SHA256SUMS" | cut -d ' ' -f 1)"
  [ -n "$expected" ] || fail "SHA256SUMS has no entry for $2. Please report this: https://github.com/$REPOSITORY/issues"

  if has sha256sum; then
    actual="$(sha256sum "$1/$2" | cut -d ' ' -f 1)"
  elif has shasum; then
    actual="$(shasum -a 256 "$1/$2" | cut -d ' ' -f 1)"
  else
    fail "sha256sum or shasum is needed to check the download. Install one, then run this again."
  fi

  [ "$actual" = "$expected" ] ||
    fail "The download's checksum doesn't match the release's, so nothing was installed. Try again; if it keeps failing, please report it: https://github.com/$REPOSITORY/issues"
}

# Adds the install folder to PATH in the shell's startup file, once. Marked,
# so running this again doesn't add a second line, and varis dracarys can
# find and remove it.
add_to_path() {
  dir="$1"

  case ":$PATH:" in
    *":$dir:"*)
      say "Run varis to get started."
      return
      ;;
  esac

  if [ "${VARIS_NO_MODIFY_PATH:-}" = "1" ]; then
    say "Add $dir to your PATH to run varis from anywhere."
    return
  fi

  shell_name="$(basename "${SHELL:-sh}")"
  line="export PATH=\"$dir:\$PATH\""
  case "$shell_name" in
    zsh) profile="${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash)
      # macOS opens login shells, which read .bash_profile; Linux terminals
      # open interactive shells, which read .bashrc.
      if [ "$(uname -s)" = "Darwin" ]; then
        profile="$HOME/.bash_profile"
      else
        profile="$HOME/.bashrc"
      fi
      ;;
    fish)
      profile="$HOME/.config/fish/config.fish"
      line="fish_add_path \"$dir\""
      ;;
    *) profile="$HOME/.profile" ;;
  esac

  if [ -f "$profile" ] && grep -q "# Added by the Varis installer" "$profile"; then
    : # Already added by an earlier install.
  else
    mkdir -p "$(dirname "$profile")"
    printf '\n# Added by the Varis installer\n%s\n' "$line" >>"$profile"
    say "Added $dir to your PATH in $profile."
  fi

  say ""
  say "To use varis now, open a new terminal, or run:"
  say ""
  say "  $line"
}

has() {
  command -v "$1" >/dev/null 2>&1
}

need() {
  has "$1" || fail "$1 is needed to install varis. Install it, then run this again."
}

say() {
  printf '%s\n' "$1"
}

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

main "$@"
