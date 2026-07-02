#!/usr/bin/env bash
# Sync runtime sources FROM sessions-api (the current pipeline home) into this repo.
# Until the publish-pipeline home decision (design 011 O9, due S6), sessions-api/runtimes/
# is the source of truth and this repo is its faithful, provenance-stamped mirror — this
# script is the ONLY way content lands here, so drift is mechanical to detect (re-run it;
# a clean tree means no drift). Directory names here drop the legacy v3- prefixes; package
# names are @oc/runtime-<name>; lockfile "name"/"version" fields are regenerated, so the
# sync copies src/ + tsconfig and PRESERVES this repo's package.json/package-lock.json.
set -euo pipefail
SRC="${1:?usage: sync-from-sessions-api.sh <path-to-sessions-api>}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SHA="$(git -C "$SRC" rev-parse HEAD)"

declare -a MAP=("adapter-core:adapter-core" "v3-claude:claude" "v3-codex:codex" "v3-pi:pi")
for m in "${MAP[@]}"; do
  from="${m%%:*}"; to="${m##*:}"
  rm -rf "$HERE/$to/src"
  cp -R "$SRC/runtimes/$from/src" "$HERE/$to/src"
  cp "$SRC/runtimes/$from/tsconfig.json" "$HERE/$to/tsconfig.json"
done

echo "synced from sessions-api@$SHA"
echo "commit with:  git add -A && git commit -m 'sync: sessions-api@${SHA:0:10}'"
