#!/usr/bin/env bash
# verify-install.sh — pack, install into a throwaway prefix, and EXECUTE every bin.
#
# Why this exists as a script rather than only as a test: `npm install -g` into a prefix is
# the thing a reviewer on another machine actually does, and the failure it guards against
# (tsc emits bin files at 0664, npm packs whatever modes it is handed, the installed bin will
# not exec) is invisible to `tsc`, invisible to `npm pack`, and invisible to every test that
# imports from src/. Run it before publishing; `test/install.test.ts` drives this same script,
# so the suite cannot pass on a path the operator does not walk.
#
# Usage:
#   scripts/verify-install.sh                      # build, pack, install, run the six bins
#   scripts/verify-install.sh --from registry      # install @zeroxcyril/dot@<version> from npm
#   scripts/verify-install.sh --keep               # leave the temp prefix for inspection
#   scripts/verify-install.sh --prefix DIR         # install into DIR (created if absent)
#   DOT_INSTALL_JSON=1 scripts/verify-install.sh   # machine-readable summary lines
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
FROM=tarball
KEEP=0
PREFIX=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) FROM="${2:?--from needs tarball|registry}"; shift 2 ;;
    --from=*) FROM="${1#--from=}"; shift ;;
    --keep) KEEP=1; shift ;;
    --prefix) PREFIX="${2:?--prefix needs a directory}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
case "$FROM" in tarball|registry) : ;; *) echo "--from must be tarball or registry (got $FROM)" >&2; exit 2 ;; esac

BINS=(dot dot-analyze dot-watch dot-mcp dot-limits dot-calibrate)
VERSION=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync("package.json","utf8")).version)')
FAILED=()
[[ -n "$PREFIX" ]] || PREFIX=$(mktemp -d "${TMPDIR:-/tmp}/dot-install-XXXXXX")
mkdir -p "$PREFIX"
cleanup() { [[ "$KEEP" == 1 ]] || command rm -rf "$PREFIX"; }
trap cleanup EXIT

npm_run() { npm "$@" --no-audit --no-fund --silent; }

if [[ "$FROM" == "tarball" ]]; then
  echo "step 1/4  build (the tarball packs dist/, so a stale dist tests stale bytes)"
  npm_run run build
  echo "step 2/4  npm pack"
  TARBALL=$(npm_run pack | tail -1)
  [[ -f "$TARBALL" ]] || { echo "FAIL: npm pack produced no file ($TARBALL)"; exit 1; }
  TARGET="./$TARBALL"
else
  echo "step 1/4  skipping build/pack — installing the published package"
  TARBALL=""
  TARGET="@zeroxcyril/dot@${VERSION}"
fi

echo "step 3/4  npm install -g into $PREFIX (from $TARGET)"
npm_config_prefix="$PREFIX" npm_run install -g "$TARGET"

echo "step 4/4  execute every bin with --version"
for b in "${BINS[@]}"; do
  path="$PREFIX/bin/$b"
  if [[ ! -e "$path" ]]; then
    FAILED+=("$b: not linked into $PREFIX/bin")
    echo "  ✗ $b — missing"
    continue
  fi
  # Execute it. Existence is not the claim; a 0664 bin exists and will not run.
  if ! out=$("$path" --version 2>&1); then
    FAILED+=("$b: --version exited nonzero: $out")
    echo "  ✗ $b — exited nonzero"
    continue
  fi
  got=$(echo "$out" | tr -d '[:space:]')
  if [[ "$got" != "$VERSION" ]]; then
    FAILED+=("$b: reported $got, manifest says $VERSION")
    echo "  ✗ $b — reported $got"
    continue
  fi
  mode=$(stat -c '%a' "$path" 2>/dev/null || echo '?')
  echo "  ✓ $b — $got (mode $mode)"
done

# The entry file's mode is what npm actually execs through the shebang.
GLOBAL_ROOT=$(npm_config_prefix="$PREFIX" npm root --global)
ENTRY="$GLOBAL_ROOT/@zeroxcyril/dot/dist/cli/index.js"
if [[ -f "$ENTRY" ]]; then
  ENTRY_MODE=$(stat -c '%a' "$ENTRY")
  echo "entry point $ENTRY mode $ENTRY_MODE"
  case "$ENTRY_MODE" in
    *5|*7) : ;;
    *) FAILED+=("entry point is not executable ($ENTRY_MODE)") ;;
  esac
else
  # Loudly, not conditionally: this path is where a silently-vacuous test used to live.
  FAILED+=("installed entry point missing at $ENTRY — the install layout changed and this script stopped measuring it")
fi

if [[ -n "${DOT_INSTALL_JSON:-}" ]]; then
  echo "JSON prefix=$PREFIX"
  echo "JSON tarball=${TARBALL:-}"
  echo "JSON version=$VERSION"
fi

if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo "FAIL — ${#FAILED[@]} problem(s):"
  for f in "${FAILED[@]}"; do echo "  - $f"; done
  exit 1
fi
echo "OK — ${#BINS[@]}/${#BINS[@]} bins executed and reported $VERSION; prefix ${PREFIX}$([[ $KEEP == 1 ]] && echo ' (kept)')"
