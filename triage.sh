#!/bin/bash
# Flaky Triage Agent — deterministic pre-scan.
#
# Auto-detects the input and does the cheap, reliable part so the AI brain (CLAUDE.md)
# can spend its judgment on classification:
#   • a Playwright/Jest JSON report (or a dir containing one) → parse it (parse-report.mjs):
#     list the flaky + unexpected tests with retries, per-attempt status, error, env-suspect flag.
#   • a .spec.ts / *.test.ts source file (or a dir of them) → grep for FLAKE SMELLS:
#     the patterns that *cause* intermittency (a different emphasis from the quality scan).
#
# Usage:
#   ./triage.sh <report.json | results-dir | spec.ts | dir> [more...]
#   ./triage.sh                                  → scan ./ (cwd)
#
# Exit code is always 0 (informational); the agent reads the output.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGETS=("$@")
[ ${#TARGETS[@]} -eq 0 ] && TARGETS=(".")

is_report() {
  # A file that parses as a PW/Jest report, or a dir that contains one.
  local t="$1"
  if [ -f "$t" ]; then
    case "$t" in
      *.json) grep -qlE '"suites"|"testResults"|"stats"' "$t" 2>/dev/null && return 0 ;;
    esac
    return 1
  fi
  if [ -d "$t" ]; then
    for c in results.json report.json test-results.json test-results/results.json playwright-report/results.json; do
      [ -f "$t/$c" ] && return 0
    done
    # any top-level json that looks like a report
    for f in "$t"/*.json; do
      [ -f "$f" ] || continue
      grep -qlE '"suites"|"testResults"' "$f" 2>/dev/null && return 0
    done
  fi
  return 1
}

# ── Split targets into reports vs source ──────────────────────────────────────
REPORTS=()
SRC_TARGETS=()
for t in "${TARGETS[@]}"; do
  if is_report "$t"; then REPORTS+=("$t"); else SRC_TARGETS+=("$t"); fi
done

# ── 1. Parse any reports ──────────────────────────────────────────────────────
if [ ${#REPORTS[@]} -gt 0 ]; then
  NODE_BIN="$(command -v node || true)"
  if [ -z "$NODE_BIN" ]; then
    echo "WARNING: 'node' not found — cannot parse JSON reports. Install node@20."
  else
    for r in "${REPORTS[@]}"; do
      "$NODE_BIN" "$SCRIPT_DIR/parse-report.mjs" "$r"
      echo ""
    done
  fi
fi

# ── 2. Smell-scan any source files ────────────────────────────────────────────
# Resolve source targets into a concrete .ts file list.
FILES=()
for t in "${SRC_TARGETS[@]}"; do
  if [ -f "$t" ]; then
    case "$t" in *.ts|*.tsx) FILES+=("$t");; esac
  elif [ -d "$t" ]; then
    while IFS= read -r f; do FILES+=("$f"); done < <(find "$t" -type f \( -name '*.spec.ts' -o -name '*.test.ts' -o -name '*.ts' \) ! -path '*/node_modules/*' ! -path '*/.git/*')
  fi
done

if [ ${#FILES[@]} -gt 0 ]; then
  echo "=== Flake-smell scan: ${#FILES[@]} source file(s) ==="
  echo "(Smells are CAUSES of intermittency — a floor for the agent's judgment, not a verdict.)"
  echo ""

  TOTAL=0
  rule() {
    local label="$1"; shift
    local sev="$1"; shift
    local pattern="$1"; shift
    local hits n=0
    hits=$(grep -rnE "$pattern" "${FILES[@]}" 2>/dev/null)
    [ -n "$hits" ] && n=$(printf '%s\n' "$hits" | grep -c .)
    if [ "$n" -gt 0 ]; then
      TOTAL=$((TOTAL + n))
      printf '  [%-6s] %3d  %s\n' "$sev" "$n" "$label"
      printf '%s\n' "$hits" | sed 's/^/             /'
      echo ""
    fi
  }

  # ── HIGH — the top flake causes ─────────────────────────────────────────────
  rule "Hard wait waitForTimeout() — sleep too short under env load (#5)" HIGH \
    "\.waitForTimeout\("
  rule "waitForLoadState('networkidle') — yada websockets never idle → hang (#5)" HIGH \
    "waitForLoadState\([[:space:]]*['\"]networkidle"
  rule "Non-web-first expect(await ...) — no auto-retry → render race (#4)" HIGH \
    "expect\(await[[:space:]].*\.(isVisible|isHidden|isEnabled|isDisabled|isChecked|textContent|innerText|count)\("
  rule "Manual waitForSelector (action auto-waits; masks real race) (#5)" HIGH \
    "\.waitForSelector\("

  # ── MEDIUM — conditional flow, positional & fixed data ──────────────────────
  rule "Conditional flow on volatile state: if (await ...) — hidden flakiness (#10)" MEDIUM \
    "if[[:space:]]*\([[:space:]]*await[[:space:]]"
  rule "Positional locator .first()/.nth() — row order not deterministic (#3)" MEDIUM \
    "\.(first|nth)\("
  rule "Hardcoded UUID — fixed test data → data-state race / isolation break (#6)" MEDIUM \
    "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
  rule "Nondeterministic data: Math.random()/Date.now() in spec — flapping asserts" MEDIUM \
    "(Math\.random\(|Date\.now\()"
  rule "describe.serial / serial mode — one failure cascades, order-coupled (#7)" MEDIUM \
    "describe\.serial|mode:[[:space:]]*['\"]serial"

  # ── LOW — corroborating signals ─────────────────────────────────────────────
  rule "force: true — clicks mid-animation, bypasses stability wait (#5)" LOW \
    "force:[[:space:]]*true"
  rule "Manual sleep via setTimeout/Promise — replace with state wait (#5)" LOW \
    "setTimeout\(|new Promise.*setTimeout"

  echo "=== Flake smells: $TOTAL ==="
  echo "(A flake verdict should usually map to one of these in the failing spec; if it can't, lower confidence.)"
fi

if [ ${#REPORTS[@]} -eq 0 ] && [ ${#FILES[@]} -eq 0 ]; then
  echo "triage: nothing to scan in: ${TARGETS[*]}"
  echo "Pass a Playwright JSON report, a results dir, or a .spec.ts file."
fi
exit 0
