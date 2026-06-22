# Flaky Triage Agent

A Claude Code agent that **triages a failed or flaky E2E run** and tells you the one thing you
actually need to know: **is this a real bug, a flake, or the environment?**

Point it at a Playwright report, a results folder, a spec, or a branch — get a per-test verdict
(REAL BUG / FLAKE / ENV), the **kind** of flake, the evidence, a confidence level, and the concrete
fix citing the bolt `Pattern #`. It can also **prove** flakiness empirically by re-running a test N
times.

Built for shared-env reality: on `team1`/`team2`/`team3`, "the test failed" is very often "the env
hiccuped" — this agent's first job is to **not** send you chasing a code fix that doesn't exist
(and not to wave away a real bug as "just flaky").

## How it differs from the other agents

| | this | `playwright-quality-agent` | `/pranal-pr-review` |
|---|---|---|---|
| Question | "this failed — what do I do?" | "how good is this code?" | "should this diff merge?" |
| Input | a **run** (report / log / re-run) | a file/folder/branch | a PR/branch diff |
| Output | per-test **verdict** + fix | a scored report card | reviewer findings + verdict |

All three read the **same** authoritative bolt pattern files, so a fix proposed here reads exactly
like what `claude[bot]` would say.

## What it decides

For every failing/flaky test:

- **REAL BUG** — deterministic, reproduces N/N, the app is wrong → offers to draft a YouTrack bug.
- **FLAKE** — intermittent → root-caused into a category (API-response race, hard wait, networkidle
  hang, selector/visibility race, page-load race, ambiguous/positional locator, isolation, fixed
  test data, token expiry, nondeterministic data, animation) → concrete fix citing `Pattern #4/#5/#8`.
- **ENV/INFRA** — 5xx / connection errors / deploy or provisioning lag → not a code fix; re-run when
  the env is healthy.

## The empirical re-run (the differentiator)

A failure is only *provably* a flake when it fails sometimes and passes others. `rerun.sh` runs a
test N times with retries off and prints a pass/fail tally:

```bash
./rerun.sh "playwright/orgs/org-pill.spec.ts -g 'should show the org pill'" 10
# → runs=10 pass=7 fail=3 passRate=70%   ← confirmed flake
```

`0/N` or `N/N` = deterministic (bug or fixed env state); anything between = flake. The repo's own
`playwright.config` + current `.env` decide which env — set that up first (team1 local feature build,
team2 pre-seeded `--no-deps`); the harness only measures.

## Prerequisites

- [Claude Code CLI](https://claude.ai/code) installed and authenticated.
- `node@20` (for report parsing and Playwright re-runs).
- `bolt` at `/Users/pranalmane/bolt` (for branch mode + re-runs; report/path inputs work anywhere).
- Reports come from Playwright's JSON reporter:
  `npx playwright test … --reporter=json > results.json` (the HTML report folder works too if it
  contains a `results.json`).

## Setup

```bash
cd ~/flaky-triage-agent
chmod +x run.sh triage.sh rerun.sh
```

## Usage

```bash
cd ~/flaky-triage-agent

# Triage a Playwright JSON report
./run.sh "/Users/pranalmane/bolt/test-results/results.json"

# Triage a results directory (finds the JSON inside)
./run.sh "/Users/pranalmane/bolt/playwright-report"

# Smell-scan a spec and offer to measure it empirically
./run.sh "/Users/pranalmane/bolt/playwright/orgs/org-pill.spec.ts"

# Triage the changed test files on a branch
./run.sh "RV2-69010-org-pill-clickable-e2e"

# Interactive (paste a terminal log straight in)
./run.sh
```

## Standalone tools (fast, no tokens)

```bash
# Deterministic pre-scan: parse a report OR smell-scan a spec (auto-detected)
./triage.sh /Users/pranalmane/bolt/test-results/results.json
./triage.sh /Users/pranalmane/bolt/playwright/orgs

# Just the report parser
node parse-report.mjs /Users/pranalmane/bolt/test-results/results.json
node parse-report.mjs --stats results.json     # one-line tally

# Empirically measure flakiness
./rerun.sh "playwright/orgs/org-pill.spec.ts" 10
```

## What you get back

```
## Flaky Triage — test-results/results.json

Triaged 3 failing/flaky test(s) · env: team1.

### Verdict summary
| Test                     | Verdict  | Category          | Confidence | Action |
| should show the org pill | FLAKE    | API-response race | High | wait for response (#8) |
| should archive the org   | REAL BUG | wrong status code | High | draft bug |
| should load the board    | ENV      | team1 500         | High | re-run when healthy |

### Flakes
- should show the org pill — org-pill.spec.ts:42
  Signal: marked flaky (attempt 1 timeout on getByTestId('org-pill'), passed retry 1).
  Root cause: assertion before GET /orgs returned — no response wait (#8).
  Re-run: 7/10 pass on team1 → confirmed.
  Fix: <copy-paste snippet>
...
```

Then it offers to apply the source fixes, re-run to confirm, or draft a bug — none auto-done for the
outward-facing actions.

## Project structure

```
flaky-triage-agent/
├── CLAUDE.md         ← the brain: input resolution, taxonomy, decision tree, output
├── triage.sh         ← deterministic pre-scan (report-parse OR flake-smell scan)
├── parse-report.mjs  ← Playwright/Jest JSON report parser (zero deps)
├── rerun.sh          ← empirical re-run harness (N× → flake rate)
├── run.sh            ← entry point
└── README.md         ← this file
```

It only edits files when you approve a fix, never commits, and never calls YouTrack on its own
(consistent with the saved preferences the other agents follow).
