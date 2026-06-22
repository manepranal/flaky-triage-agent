#!/bin/bash
# Flaky Triage Agent — flake scoreboard.
#
# "How many tests are flaky, and which ones do I work on?" — answered in one line.
# Prints a COUNT (X flaky · Y needs re-run · Z real-bug · W env) and a ranked, worst-first
# list of the flaky tests to fix, each with file:line + a probable cause and bolt Pattern #.
#
# Pass ONE report for a snapshot, or SEVERAL (or a folder of them) to aggregate a real
# per-test flake rate ("flaky 70% · 7/10").
#
# Usage:
#   ./worklist.sh results.json                       → one run
#   ./worklist.sh run1.json run2.json run3.json      → aggregate 3 runs → true flake rate
#   ./worklist.sh ./reports-dir                       → every report in a folder
#
# Generate a report first:  npx playwright test … --reporter=json > results.json

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if ! command -v node &>/dev/null; then
  echo "ERROR: 'node' not found — needed to parse JSON reports. Install node@20."
  exit 1
fi
if [ $# -eq 0 ]; then
  echo "usage: ./worklist.sh <report.json | dir> [more reports...]"
  echo "  (one report = snapshot; several = aggregated per-test flake rate)"
  exit 1
fi

node "$SCRIPT_DIR/parse-report.mjs" --worklist "$@"
