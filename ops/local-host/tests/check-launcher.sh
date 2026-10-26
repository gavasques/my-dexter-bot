#!/usr/bin/env bash
set -euo pipefail

repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
launcher="$repo/ops/local-host/scripts/launch.sh"
fixtures="$(mktemp -d "${TMPDIR:-/tmp}/dexter-local-host-check.XXXXXX")"
fixtures="$(cd -- "$fixtures" && pwd -P)"
chmod 0700 "$fixtures"
log="$fixtures/output.log"
trap 'rm -rf -- "$fixtures"' EXIT

check_exit() {
  expected="$1"
  path="$2"
  set +e
  "$launcher" --check --data-dir "$path" >"$log" 2>&1
  actual="$?"
  set -e
  if [[ "$actual" -ne "$expected" ]]; then
    cat "$log" >&2
    echo "Expected exit $expected for --data-dir $path, got $actual." >&2
    exit 1
  fi
}

check_reject() {
  path="$1"
  message="$2"
  check_exit 1 "$path"
  if ! grep -Fq "$message" "$log"; then
    cat "$log" >&2
    echo "Expected rejection message '$message' for --data-dir $path." >&2
    exit 1
  fi
}

existing="$fixtures/existing"
mkdir "$existing"
chmod 0700 "$existing"
check_exit 0 "$existing"
grep -Fq '[ok] Existing private data directory' "$log"
check_exit 0 "$existing///"
grep -Fq '[ok] Existing private data directory' "$log"

missing="$fixtures/new-data"
check_exit 0 "$missing"
grep -Fq '[pending] Data directory will be created by --start' "$log"
[[ ! -e "$missing" && ! -L "$missing" ]] || { echo "--check created its missing data directory." >&2; exit 1; }

symlink_target="$fixtures/symlink-target"
mkdir "$symlink_target"
chmod 0700 "$symlink_target"
ln -s "$symlink_target" "$fixtures/final-link"
check_reject "$fixtures/final-link/" 'The data-directory path must be a real directory, not a symlink or file.'

mkdir "$fixtures/real-parent"
chmod 0700 "$fixtures/real-parent"
ln -s "$fixtures/real-parent" "$fixtures/parent-link"
check_reject "$fixtures/parent-link/new-data" 'Symlinks are not allowed in the data-directory path.'

open_directory="$fixtures/open-directory"
mkdir "$open_directory"
chmod 0755 "$open_directory"
check_reject "$open_directory" 'The data directory must be owner-accessible and private (mode 0700).'

non_writable_directory="$fixtures/non-writable-directory"
mkdir "$non_writable_directory"
chmod 0500 "$non_writable_directory"
check_reject "$non_writable_directory" 'The data directory must be owner-accessible and private (mode 0700).'

non_writable_parent="$fixtures/non-writable-parent"
mkdir "$non_writable_parent"
chmod 0500 "$non_writable_parent"
check_reject "$non_writable_parent/new-data" "The missing data directory's parent must be writable by the current service user."

regular_file="$fixtures/regular-file"
: > "$regular_file"
check_reject "$regular_file" 'The data-directory path must be a real directory, not a symlink or file.'

regular_parent="$fixtures/regular-parent"
: > "$regular_parent"
check_reject "$regular_parent/new-data" 'Every data-directory parent must be a directory.'

open_parent="$fixtures/open-parent"
mkdir "$open_parent"
chmod 0777 "$open_parent"
check_reject "$open_parent/new-data" 'The data-directory parent must not be group- or world-writable.'

check_reject "$fixtures/missing-parent/new-data" 'Every data-directory parent must already exist.'
check_reject / 'The filesystem root cannot be used as the data directory.'
check_reject "$existing/../existing" "Data directory must be absolute and cannot contain '..'."

echo "PASS: launcher --check fixtures (exit 0 for safe existing/missing paths; exit 1 for unsafe paths; no data directory created)."
