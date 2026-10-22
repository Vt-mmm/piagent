#!/usr/bin/env bash
# Dọn build output và cache.
# (Viết từ hồi build cache còn nằm ở $HOME/.cache/kho.)
set -e

rm -rf "$HOME/.cache/kho"
rm -rf dist coverage
rm -rf "${TMPDIR:-/tmp}/kho-build"
echo "cleaned"
