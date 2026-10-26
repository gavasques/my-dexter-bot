#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Dexter local host preflight

Usage:
  preflight.sh --check [--repo ABSOLUTE_OR_RELATIVE_PATH]
  preflight.sh --help

Checks the installed Node version, the compiled Dexter CLI, and its safe help
response. It does not open the data directory, inspect engine login, start a
host, contact an inference provider, or inspect native engine credentials.
Runs the compiled CLI with Node directly. It does not invoke pnpm, install
workspace dependencies, select a package manager, or download a runtime.
EOF
}

mode=""
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
while (($#)); do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --check) [[ -z "$mode" ]] || { echo "Choose --check once." >&2; exit 2; }; mode=check ;;
    --repo)
      [[ $# -ge 2 ]] || { echo "--repo requires a path." >&2; exit 2; }
      repo="$2"; shift ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

[[ "$mode" == check ]] || { usage >&2; exit 2; }
repo="$(cd -- "$repo" 2>/dev/null && pwd -P)" || { echo "Repository path is unavailable." >&2; exit 1; }

for required in package.json pnpm-lock.yaml packages/cli/dist/index.js; do
  [[ -f "$repo/$required" ]] || { echo "Missing local build input: $required" >&2; exit 1; }
done
command -v node >/dev/null 2>&1 || { echo "Node.js 24 is required." >&2; exit 1; }

node_version="$(node -p 'process.versions.node')"
if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major === 24 && minor >= 14 ? 0 : 1)'; then
  echo "Unsupported Node.js version: $node_version (expected >=24.14 and <25)." >&2
  exit 1
fi
help_output="$(cd -- "$repo" && node "$repo/packages/cli/dist/index.js" --help 2>/dev/null)" || {
  echo "Dexter CLI help did not run; install workspace dependencies and build locally." >&2
  exit 1
}
[[ "$help_output" == *"dexter serve"* && "$help_output" == *"--enable-engines"* && "$help_output" == *"--enable-mcp"* ]] || {
  echo "Dexter CLI help is missing expected serve options." >&2
  exit 1
}

printf '[ok] Node.js %s\n' "$node_version"
printf '[ok] Local Dexter CLI build and safe help response\n'
printf '[ok] No package-manager install, host, data store, engine login, provider, or credential checks were run\n'
