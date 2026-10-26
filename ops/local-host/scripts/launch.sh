#!/usr/bin/env bash
set -euo pipefail
umask 077

usage() {
  cat <<'EOF'
Dexter local host launcher

Usage:
  launch.sh --help
  launch.sh --check --data-dir ABSOLUTE_PRIVATE_PATH
  launch.sh --start --data-dir ABSOLUTE_PRIVATE_PATH [--enable-engines] [--enable-mcp]

--check validates the absolute data path, existing directory permissions, and
the local CLI without creating a directory or starting the host. If the final
directory is absent, it checks the existing parent and reports creation as
pending. --start is an explicit foreground launch; it creates the final data
directory with mode 0700 if absent and then execs the loopback-only CLI. It
never installs/enables a service or changes network exposure.

MCP requires --enable-engines. Engine and MCP flags are opt-in; this script does
not inspect engine login or configure upstream app credentials.
EOF
}

mode=""
data_dir=""
enable_engines=0
enable_mcp=0
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
while (($#)); do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --check|--start)
      [[ -z "$mode" ]] || { echo "Choose --check or --start once." >&2; exit 2; }
      mode="${1#--}" ;;
    --data-dir)
      [[ $# -ge 2 ]] || { echo "--data-dir requires an absolute path." >&2; exit 2; }
      data_dir="$2"; shift ;;
    --enable-engines) enable_engines=1 ;;
    --enable-mcp) enable_mcp=1 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

[[ -n "$mode" ]] || { usage >&2; exit 2; }
[[ -n "$data_dir" && "$data_dir" == /* ]] || { echo "--data-dir must be an absolute path." >&2; exit 2; }
if ((enable_mcp && !enable_engines)); then
  echo "MCP requires --enable-engines." >&2
  exit 2
fi

"$repo/ops/local-host/scripts/preflight.sh" --check --repo "$repo" >/dev/null
command -v python3 >/dev/null 2>&1 || { echo "python3 is required to validate private data-directory permissions." >&2; exit 1; }
canonical_data_dir="$(python3 -I - "$data_dir" "$mode" <<'PY'
import os
import stat
import sys

raw = sys.argv[1]
mode = sys.argv[2]
if not os.path.isabs(raw):
    raise SystemExit("Data directory must be absolute.")
if ".." in raw.split(os.sep):
    raise SystemExit("Data directory must be absolute and cannot contain '..'.")
if "\n" in raw or "\r" in raw:
    raise SystemExit("Data directory cannot contain line breaks.")
path = os.path.normpath("/" + raw.lstrip(os.sep))
if path == os.sep:
    raise SystemExit("The filesystem root cannot be used as the data directory.")

# Walk with lstat so neither a trailing slash nor a symlink in any path
# component can turn the selected directory into a different location.
parts = path.strip(os.sep).split(os.sep)
parent = os.sep
for part in parts[:-1]:
    parent = os.path.join(parent, part)
    try:
        info = os.lstat(parent)
    except OSError:
        raise SystemExit("Every data-directory parent must already exist.")
    if stat.S_ISLNK(info.st_mode):
        raise SystemExit("Symlinks are not allowed in the data-directory path.")
    if not stat.S_ISDIR(info.st_mode):
        raise SystemExit("Every data-directory parent must be a directory.")

parent_info = os.lstat(parent)
if parent_info.st_uid != os.geteuid():
    raise SystemExit("The data-directory parent must be owned by the current service user.")
if stat.S_IMODE(parent_info.st_mode) & 0o022:
    raise SystemExit("The data-directory parent must not be group- or world-writable.")

try:
    info = os.lstat(path)
except FileNotFoundError:
    if mode == "check":
        if not os.access(parent, os.W_OK | os.X_OK):
            raise SystemExit("The missing data directory's parent must be writable by the current service user.")
        print(f"[pending] Data directory will be created by --start: {path}", file=sys.stderr)
        print(path)
        raise SystemExit(0)
    try:
        os.mkdir(path, 0o700)
    except OSError:
        raise SystemExit("Could not create the private data directory.")
    info = os.lstat(path)
except OSError:
    raise SystemExit("Could not validate the data directory.")
if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
    raise SystemExit("The data-directory path must be a real directory, not a symlink or file.")
if info.st_uid != os.geteuid():
    raise SystemExit("The data directory must be owned by the current service user.")
if stat.S_IMODE(info.st_mode) != 0o700:
    raise SystemExit("The data directory must be owner-accessible and private (mode 0700).")
if mode == "check":
    print(f"[ok] Existing private data directory: {path}", file=sys.stderr)
print(path)
PY
)" || exit 1

if [[ "$mode" == check ]]; then
  printf '[ok] Data path and local CLI checked; no directory created and no host started\n'
  exit 0
fi

args=(serve --data-dir "$canonical_data_dir" --port 4317)
((enable_engines)) && args+=(--enable-engines)
((enable_mcp)) && args+=(--enable-mcp)
cd -- "$repo"
printf '[start] Dexter host process; listener remains on 127.0.0.1:4317\n' >&2
exec node "$repo/packages/cli/dist/index.js" "${args[@]}"
