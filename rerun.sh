#!/bin/bash
# Flaky Triage Agent — empirical re-run harness.
#
# The only ground truth for "is this a flake?" is running it many times. This runs a
# Playwright (or Detox) test N times with retries OFF (so each run is independent) and
# prints a pass/fail tally → flake rate.
#
#   • 0/N or N/N  → deterministic (real bug or fixed env state), NOT a flake.
#   • in between  → confirmed flake; the rate is its severity.
#
# Usage:
#   ./rerun.sh "<spec path>"                         → 10× on the repo's current env
#   ./rerun.sh "<spec path>" 20                      → 20×
#   ./rerun.sh "<spec> -g 'should show the org pill'" 10        → filter to one test by title
#   ./rerun.sh "<spec>" 10 real-app                  → Detox/real-app mode
#
# The repo's own playwright.config + current .env decide WHICH env (team1/team2/…). This
# script does NOT re-point envs — set that up first (the local feature build / .env swap
# for team1, the pre-seeded-accounts + --no-deps flow for team2). It only measures.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BOLT_DIR="/Users/pranalmane/bolt"
REALAPP_DIR="/Users/pranalmane/real-app"

SPEC="${1:-}"
N="${2:-10}"
REPO_HINT="${3:-}"

if [ -z "$SPEC" ]; then
  echo "usage: ./rerun.sh \"<spec path> [-g 'test title']\" [N=10] [bolt|real-app]"
  exit 1
fi
case "$N" in *[!0-9]*) echo "N must be a number, got '$N'"; exit 1;; esac

# ── Pick the repo ─────────────────────────────────────────────────────────────
REPO="$BOLT_DIR"; KIND="bolt"
if [ "$REPO_HINT" = "real-app" ] || [[ "$SPEC" == *"/real-app/"* ]] || [[ "$SPEC" == e2e/* ]]; then
  REPO="$REALAPP_DIR"; KIND="real-app"
fi
if [ ! -d "$REPO/.git" ]; then
  echo "ERROR: $KIND repo not found at '$REPO'."
  exit 1
fi

echo "=== Empirical re-run: $N× · repo=$KIND · retries=0 ==="
echo "Spec/filter: $SPEC"
echo "Env is whatever $REPO's playwright.config + current .env point at — confirm it's the one you mean."
echo ""

TS="$(date +%Y%m%d-%H%M%S)"
OUT="/tmp/flaky-rerun-$TS.json"

if [ "$KIND" = "bolt" ]; then
  # --repeat-each runs N independent copies in one invocation; --retries=0 keeps them honest.
  # eval so an inline -g 'title' in $SPEC is passed through correctly.
  echo "→ cd $REPO && npx playwright test $SPEC --repeat-each=$N --retries=0 --reporter=json"
  ( cd "$REPO" && eval npx playwright test $SPEC --repeat-each="$N" --retries=0 --reporter=json ) > "$OUT" 2>/tmp/flaky-rerun-$TS.err
  STATUS=$?
  if [ -s "$OUT" ] && command -v node &>/dev/null; then
    echo ""
    echo "--- tally ---------------------------------------------------------------"
    node "$SCRIPT_DIR/parse-report.mjs" --stats "$OUT"
    echo "report: $OUT"
    echo ""
    echo "Detail (failing/flaky only):"
    node "$SCRIPT_DIR/parse-report.mjs" "$OUT"
  else
    echo "No JSON captured (exit $STATUS). stderr → /tmp/flaky-rerun-$TS.err"
    tail -20 "/tmp/flaky-rerun-$TS.err" 2>/dev/null
  fi
else
  # Detox: no --repeat-each; loop N times, tally exit codes. Heavy (sim per run) — keep N small.
  echo "Detox mode — running $N sequential passes (this is slow; sim build reused). "
  PASS=0; FAIL=0
  for i in $(seq 1 "$N"); do
    ( cd "$REPO" && eval detox test $SPEC --configuration ios.sim.release ) >"/tmp/flaky-rerun-$TS-$i.log" 2>&1
    if [ $? -eq 0 ]; then PASS=$((PASS+1)); echo "  run $i: PASS"; else FAIL=$((FAIL+1)); echo "  run $i: FAIL (log /tmp/flaky-rerun-$TS-$i.log)"; fi
  done
  echo ""
  echo "--- tally ---------------------------------------------------------------"
  RATE=$(( PASS * 100 / N ))
  echo "runs=$N pass=$PASS fail=$FAIL passRate=$RATE%"
fi

echo ""
echo "Interpretation: 0/$N or $N/$N = deterministic (bug or fixed env state); anything between = flake."
exit 0
