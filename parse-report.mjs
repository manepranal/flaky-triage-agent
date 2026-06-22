#!/usr/bin/env node
// Flaky Triage Agent — Playwright/Jest report parser (zero deps, ESM).
//
// Reads a Playwright `--reporter=json` report (or a Jest/JUnit result) and prints the
// failing + flaky tests with retry counts, per-attempt status, file:line, and a trimmed
// error message. The agent (CLAUDE.md) reads this summary to seed its triage.
//
// Usage:
//   node parse-report.mjs <report.json | dir>            → human summary (default)
//   node parse-report.mjs --json   <report.json | dir>   → machine JSON to stdout
//   node parse-report.mjs --stats  <report.json | dir>   → one-line pass/fail tally (for rerun.sh)
//
// Exit code is always 0 — this is informational.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
let mode = 'human';
if (args.includes('--json')) mode = 'json';
if (args.includes('--stats')) mode = 'stats';
const target = args.find((a) => !a.startsWith('--'));

if (!target) {
  console.error('parse-report: no report path given.');
  console.error('usage: node parse-report.mjs [--json|--stats] <report.json|dir>');
  process.exit(0);
}

// ── Resolve the target to a JSON report file ──────────────────────────────────
function resolveReport(t) {
  if (!existsSync(t)) return null;
  if (statSync(t).isFile()) return t;
  // It's a directory — look for the usual Playwright JSON outputs.
  const candidates = [
    'results.json',
    'report.json',
    'test-results.json',
    join('test-results', 'results.json'),
    join('playwright-report', 'results.json'),
  ];
  for (const c of candidates) {
    const p = join(t, c);
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  // Last resort: any *.json at the top level that parses as a PW/Jest report.
  for (const f of readdirSync(t)) {
    if (!f.endsWith('.json')) continue;
    const p = join(t, f);
    try {
      const j = JSON.parse(readFileSync(p, 'utf8'));
      if (j.suites || j.testResults || j.stats) return p;
    } catch {
      /* skip */
    }
  }
  return null;
}

const reportPath = resolveReport(target);
if (!reportPath) {
  console.error(`parse-report: no JSON report found at "${target}".`);
  console.error('Generate one with:  npx playwright test … --reporter=json > results.json');
  process.exit(0);
}

let data;
try {
  data = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (e) {
  console.error(`parse-report: could not parse "${reportPath}": ${e.message}`);
  process.exit(0);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function trimErr(s, lines = 6) {
  if (!s) return '';
  // Strip ANSI colour codes, collapse blank lines, keep the first few lines.
  return s
    .replace(/\[[0-9;]*m/g, '')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .slice(0, lines)
    .join('\n');
}

const ENV_SIGNS =
  /\b(50[0-4]|ECONNREFUSED|ERR_CONNECTION|net::ERR|ERR_NETWORK|socket hang up|tenant not found|Bad Gateway|Gateway Time-?out|Service Unavailable)\b/i;

function envSuspect(msg) {
  return ENV_SIGNS.test(msg || '');
}

// ── Playwright JSON shape: recursive suites → specs → tests → results[] ────────
const tests = []; // normalized rows

function walkPlaywright(suite, trail = []) {
  const title = suite.title ? [...trail, suite.title] : trail;
  for (const spec of suite.specs || []) {
    const file = spec.file || suite.file || '';
    const line = spec.line || '';
    for (const t of spec.tests || []) {
      const results = t.results || [];
      const attempts = results.map((r) => r.status);
      const failed = results.filter((r) => r.status === 'failed' || r.status === 'timedOut');
      const errMsg =
        (failed[0] &&
          (failed[0].error?.message ||
            (failed[0].errors && failed[0].errors[0]?.message) ||
            failed[0].error?.stack)) ||
        '';
      tests.push({
        title: [...title, spec.title].filter(Boolean).join(' › '),
        spec: spec.title,
        file,
        line,
        project: t.projectName || '',
        status: t.status || (spec.ok ? 'expected' : 'unexpected'),
        retries: Math.max(0, results.length - 1),
        attempts,
        error: trimErr(errMsg),
        envSuspect: envSuspect(errMsg),
      });
    }
  }
  for (const child of suite.suites || []) walkPlaywright(child, title);
}

// ── Jest shape: testResults[].assertionResults[] (Detox/real-app) ──────────────
function walkJest(d) {
  for (const file of d.testResults || []) {
    const fpath = file.name || file.testFilePath || '';
    for (const a of file.assertionResults || file.testResults || []) {
      const msgs = (a.failureMessages || []).join('\n');
      const status =
        a.status === 'passed' ? 'expected' : a.status === 'failed' ? 'unexpected' : a.status;
      tests.push({
        title: [...(a.ancestorTitles || []), a.title].filter(Boolean).join(' › '),
        spec: a.title,
        file: fpath,
        line: a.location?.line || '',
        project: '',
        status,
        retries: 0,
        attempts: [a.status],
        error: trimErr(msgs),
        envSuspect: envSuspect(msgs),
      });
    }
  }
}

if (data.suites) for (const s of data.suites) walkPlaywright(s);
else if (data.testResults) walkJest(data);

// ── Tally ──────────────────────────────────────────────────────────────────────
const flaky = tests.filter((t) => t.status === 'flaky');
const failed = tests.filter((t) => t.status === 'unexpected');
const passed = tests.filter((t) => t.status === 'expected');
const skipped = tests.filter((t) => t.status === 'skipped');
const total = passed.length + failed.length + flaky.length; // exclude skipped from rate
const passRate = total ? ((passed.length / total) * 100).toFixed(0) : '—';

// ── Output ───────────────────────────────────────────────────────────────────
if (mode === 'stats') {
  // Compact line for rerun.sh to surface a flake rate.
  console.log(
    `runs=${total} pass=${passed.length} fail=${failed.length} flaky=${flaky.length} ` +
      `skip=${skipped.length} passRate=${passRate}%`,
  );
  process.exit(0);
}

if (mode === 'json') {
  console.log(
    JSON.stringify(
      {
        report: reportPath,
        stats: {
          passed: passed.length,
          failed: failed.length,
          flaky: flaky.length,
          skipped: skipped.length,
          passRate,
        },
        flaky,
        failed,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

// Human summary
const line = (s) => console.log(s);
line(`=== Report: ${reportPath} ===`);
line(
  `passed=${passed.length}  failed=${failed.length}  flaky=${flaky.length}  ` +
    `skipped=${skipped.length}  passRate=${passRate}%`,
);
line('');

function block(label, rows) {
  if (!rows.length) return;
  line(`── ${label} (${rows.length}) ───────────────────────────────────────────`);
  for (const t of rows) {
    const loc = t.file ? `${t.file}${t.line ? ':' + t.line : ''}` : '(no location)';
    const proj = t.project ? ` [${t.project}]` : '';
    const env = t.envSuspect ? '  <ENV-SUSPECT: 5xx/conn signature>' : '';
    line(`• ${t.title}${proj}`);
    line(`    ${loc}   attempts: [${t.attempts.join(' → ')}]   retries: ${t.retries}${env}`);
    if (t.error) {
      for (const el of t.error.split('\n')) line(`      ${el}`);
    }
    line('');
  }
}

block('FLAKY (failed then passed on retry — flake by definition)', flaky);
block('UNEXPECTED (failed through all retries — re-run to classify)', failed);

if (!flaky.length && !failed.length) {
  line('No failing or flaky tests in this report.');
}
line('(ENV-SUSPECT = the error carries a 5xx/connection signature → likely env/infra, not code.)');
