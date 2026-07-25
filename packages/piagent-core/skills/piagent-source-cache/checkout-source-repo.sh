#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <repo-ref> [--path-only] [--force-update]"
}

if [[ $# -lt 1 ]]; then
  usage
  exit 2
fi

REPO_REF="$1"
shift

PATH_ONLY=false
FORCE_UPDATE=false
for arg in "$@"; do
  case "$arg" in
    --path-only)
      PATH_ONLY=true
      ;;
    --force-update)
      FORCE_UPDATE=true
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

parse_repo_ref() {
  local ref="$1"
  local host=""
  local rest=""

  case "$ref" in
    http://*|https://*)
      local no_proto="${ref#*://}"
      host="${no_proto%%/*}"
      rest="${no_proto#*/}"
      ;;
    git@*:*)
      local no_user="${ref#git@}"
      host="${no_user%%:*}"
      rest="${no_user#*:}"
      ;;
    *.*/*/*)
      host="${ref%%/*}"
      rest="${ref#*/}"
      ;;
    */*)
      host="github.com"
      rest="$ref"
      ;;
    *)
      echo "Unsupported repository reference: $ref" >&2
      return 1
      ;;
  esac

  rest="${rest%.git}"
  IFS="/" read -r owner repo _extra <<< "$rest"

  if [[ -z "${host:-}" || -z "${owner:-}" || -z "${repo:-}" ]]; then
    echo "Could not parse repository reference: $ref" >&2
    return 1
  fi

  if [[ ! "$host" =~ ^[A-Za-z0-9._-]+$ || ! "$owner" =~ ^[A-Za-z0-9._-]+$ || ! "$repo" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "Repository reference contains unsupported characters: $ref" >&2
    return 1
  fi

  printf '%s\t%s\t%s\n' "$host" "$owner" "$repo"
}

IFS=$'\t' read -r HOST OWNER REPO <<< "$(parse_repo_ref "$REPO_REF")"

if [[ -n "${PIAGENT_CHECKOUT_CACHE:-}" ]]; then
  CACHE_ROOT="$PIAGENT_CHECKOUT_CACHE"
elif [[ -n "${XDG_CACHE_HOME:-}" ]]; then
  CACHE_ROOT="$XDG_CACHE_HOME/piagent-platform/checkouts"
elif [[ -n "${HOME:-}" ]]; then
  CACHE_ROOT="$HOME/.cache/piagent-platform/checkouts"
else
  echo "HOME or PIAGENT_CHECKOUT_CACHE is required" >&2
  exit 1
fi

TARGET="$CACHE_ROOT/$HOST/$OWNER/$REPO"
STAMP_FILE="$TARGET/.piagent-last-fetch"
FETCH_INTERVAL_SECONDS="${PIAGENT_CHECKOUT_FETCH_INTERVAL_SECONDS:-300}"
CLONE_URL="https://$HOST/$OWNER/$REPO.git"

if [[ ! -d "$TARGET/.git" ]]; then
  mkdir -p "$(dirname "$TARGET")"
  git clone --filter=blob:none -- "$CLONE_URL" "$TARGET" >/dev/null
  date +%s > "$STAMP_FILE"
else
  NOW_SECONDS="$(date +%s)"
  LAST_FETCH_SECONDS=0
  if [[ -f "$STAMP_FILE" ]]; then
    LAST_FETCH_SECONDS="$(tr -cd '0-9' < "$STAMP_FILE" || true)"
    LAST_FETCH_SECONDS="${LAST_FETCH_SECONDS:-0}"
  fi

  SHOULD_FETCH=false
  if [[ "$FORCE_UPDATE" == true ]]; then
    SHOULD_FETCH=true
  elif (( NOW_SECONDS - LAST_FETCH_SECONDS >= FETCH_INTERVAL_SECONDS )); then
    SHOULD_FETCH=true
  fi

  if [[ "$SHOULD_FETCH" == true ]]; then
    CLEAN_WORKTREE=false
    if git -C "$TARGET" diff --quiet --ignore-submodules -- && git -C "$TARGET" diff --cached --quiet --ignore-submodules --; then
      CLEAN_WORKTREE=true
    fi

    git -C "$TARGET" fetch --filter=blob:none --prune origin >/dev/null

    if [[ "$CLEAN_WORKTREE" == true ]] && git -C "$TARGET" rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
      git -C "$TARGET" merge --ff-only '@{u}' >/dev/null || true
    fi

    date +%s > "$STAMP_FILE"
  fi
fi

if [[ "$PATH_ONLY" == true ]]; then
  printf '%s\n' "$TARGET"
else
  echo "Source cache ready:"
  echo "  ref: $REPO_REF"
  echo "  url: $CLONE_URL"
  echo "  path: $TARGET"
fi
