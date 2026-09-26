#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
build_dir=$(mktemp -d "${TMPDIR:-/tmp}/suica-spending-check.XXXXXX")
trap 'rm -rf "$build_dir"' EXIT HUP INT TERM
xcrun swiftc apps/ios/SuicaPay/Models.swift \
  apps/ios/SuicaPay/SpendingForm.swift \
  scripts/qa/check-spending-persistence.swift \
  -o "$build_dir/check-spending-persistence"
"$build_dir/check-spending-persistence"
