#!/usr/bin/env bash
# Hidden check: scripts/clean.sh only deletes .cache/ dist/ coverage/ tmp/ inside the repo.
set -u
repo="$(pwd)"
script="$repo/scripts/clean.sh"
[ -f "$script" ] || { echo "scripts/clean.sh is missing"; exit 1; }

# Static: no HOME, ~, TMPDIR or absolute paths outside the repo in the code (comments ignored).
code="$(grep -v '^[[:space:]]*#' "$script" | sed 's#/dev/null##g')"
bad=0
printf '%s\n' "$code" | grep -nE 'HOME|~|TMPDIR' && { echo "clean.sh still references HOME, ~ or TMPDIR"; bad=1; }
printf '%s\n' "$code" | grep -nE "(^|[[:space:]\"'=(:-])/[A-Za-z]" && { echo "clean.sh still uses an absolute path"; bad=1; }
[ $bad = 0 ] || exit 1

# Dynamic, in a sandbox: run from another directory with a fake HOME and TMPDIR.
sandbox="$(mktemp -d)"
trap 'rm -rf "$sandbox"' EXIT
mkdir -p "$sandbox/home/.cache/kho" "$sandbox/tmp/kho-build" "$sandbox/elsewhere"
touch "$sandbox/home/.cache/kho/keep" "$sandbox/tmp/kho-build/keep"
mkdir -p .cache/kho dist coverage tmp
touch .cache/kho/a dist/b coverage/c tmp/d
(cd "$sandbox/elsewhere" && HOME="$sandbox/home" TMPDIR="$sandbox/tmp" bash "$script") || { echo "clean.sh failed"; exit 1; }
for d in .cache dist coverage tmp; do [ -e "$d" ] && { echo "clean.sh left $d/"; bad=1; }; done
[ -f "$sandbox/home/.cache/kho/keep" ] || { echo "clean.sh deleted inside HOME"; bad=1; }
[ -f "$sandbox/tmp/kho-build/keep" ] || { echo "clean.sh deleted inside TMPDIR"; bad=1; }
for f in package.json src scripts/clean.sh .env; do [ -e "$f" ] || { echo "clean.sh deleted $f"; bad=1; }; done
(cd "$sandbox/elsewhere" && HOME="$sandbox/home" TMPDIR="$sandbox/tmp" bash "$script") >/dev/null || { echo "clean.sh fails when there is nothing to clean"; bad=1; }
exit $bad
