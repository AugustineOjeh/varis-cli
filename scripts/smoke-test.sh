#!/usr/bin/env bash
# Smoke-tests one compiled varis binary on the machine it's built for.
#
#   scripts/smoke-test.sh dist/varis-linux-x64/varis
#
# Run by .github/workflows/build.yml on every platform we ship, in bash
# (Git Bash on Windows). It proves three things:
#
#   1. The binary runs with no Node.js available. Developers must not need
#      Node to publish, so every check runs with PATH cut down to the
#      system's basic tools, and the script first confirms node isn't on it.
#   2. The command list is intact: --help names every command, and
#      --version answers.
#   3. The bundled dependencies work. varis test validates input with Ajv
#      and ajv-formats, which are bundled into the binary; a format check
#      failing with the right message proves both made it in. The check
#      stops before any network call, because an invalid input is never sent.

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <path to the varis binary>" >&2
  exit 2
fi

# An absolute path, because the checks below run from a temporary folder.
binary="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"

# Only the system's own tools. GitHub's runners install Node under
# /usr/local, /opt, or a tool cache, never in /usr/bin or /bin.
clean_path="/usr/bin:/bin"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

if env PATH="$clean_path" sh -c 'command -v node' >/dev/null 2>&1; then
  fail "node is reachable on $clean_path, so this run can't prove the binary works without it"
fi

# Runs the binary with no Node.js in reach.
varis() {
  env PATH="$clean_path" "$binary" "$@"
}

echo "--- varis --version"
varis --version

echo "--- varis --help"
help="$(varis --help)"
for command in login init build publish test logout upgrade dracarys; do
  grep -q "^  $command " <<<"$help" || fail "--help doesn't list $command"
done
echo "lists all eight commands"

echo "--- varis test, with an input that breaks the schema"
project="$(mktemp -d)"
trap 'rm -rf "$project"' EXIT
cd "$project"

# A service whose input needs a valid email. The URLs are never called.
cat >varis.json <<'EOF'
{
  "owner_id": "var_ownr_smoketest00000",
  "test_base_url": "http://localhost:3000",
  "services": [
    {
      "slug": "smoke",
      "endpoint_url": "https://api.example.com/smoke",
      "method": "POST",
      "input_schema": {
        "type": "object",
        "properties": { "email": { "type": "string", "format": "email" } },
        "required": ["email"]
      },
      "output_schema": { "type": "object" }
    }
  ]
}
EOF
# From a file, because quoting JSON on the command line differs on Windows.
echo '{"email":"not an email"}' >input.json

set +e
output="$(varis test smoke --input-file input.json 2>&1)"
code=$?
set -e
echo "$output"

[ "$code" -eq 1 ] || fail "expected exit code 1, got $code"
grep -q 'must match format "email"' <<<"$output" ||
  fail "Ajv's email format check didn't run: ajv-formats may be missing from the binary"

echo "--- passed"
