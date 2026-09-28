#!/usr/bin/env bash
# Commits and pushes one updated package file: the Homebrew formula or the
# Scoop manifest. Used by .github/workflows/packages.yml.
#
#   scripts/commit-package.sh <checkout> <file> <message> <repository> <secret>
#
#   checkout    The folder the package repository is checked out in.
#   file        The file to commit, relative to that folder.
#   message     The commit message, such as "varis 0.2.1".
#   repository  The repository's name, for the error message.
#   secret      The deploy key's secret name, for the error message.
#
# Commits as the github-actions bot. A rerun for the same release finds
# nothing new and succeeds without committing.

set -euo pipefail

if [ $# -ne 5 ]; then
  echo "Usage: $0 <checkout> <file> <message> <repository> <secret>" >&2
  exit 2
fi

cd "$1"
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add "$2"

if git diff --cached --quiet; then
  echo "$4 is already up to date."
  exit 0
fi

git commit -m "$3"
git push || {
  echo "::error::Couldn't push to $4. Check that its deploy key has write access ($4, Settings, Deploy keys: it should say Read/write) and that the $5 secret holds the matching private key."
  exit 1
}
