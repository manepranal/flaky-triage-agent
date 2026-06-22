#!/bin/bash
# Flaky Triage Agent
# Triages a failed/flaky E2E run: real bug vs flake (which kind) vs env/infra, with the
# evidence, a confidence level, and the concrete fix (citing the bolt Pattern #).
#
# Usage:
#   ./run.sh                                   → interactive
#   ./run.sh "test-results/results.json"       → triage a Playwright JSON report
#   ./run.sh "playwright-report/"              → triage a results directory
#   ./run.sh "playwright/orgs/org-pill.spec.ts"→ smell-scan a spec + offer a re-run
#   ./run.sh "RV2-69010-org-pill-clickable-e2e"→ the changed test files on that branch

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BOLT_DIR="/Users/pranalmane/bolt"

cd "$SCRIPT_DIR"

if ! command -v claude &>/dev/null; then
  echo "ERROR: 'claude' CLI not found. Install it with:"
  echo "  npm install -g @anthropic-ai/claude-code"
  exit 1
fi

if [ ! -d "$BOLT_DIR/.git" ]; then
  echo "WARNING: bolt repo not found at '$BOLT_DIR'."
  echo "Report/path inputs still work; branch mode and re-runs need the repo."
fi

chmod +x "$SCRIPT_DIR/triage.sh" "$SCRIPT_DIR/rerun.sh" 2>/dev/null

if [ -n "$1" ]; then
  claude "Input: $1"
else
  claude
fi
