#!/usr/bin/env node
// Flaky Triage Agent — Playwright/Jest report parser (zero deps, ESM).
//
// Reads one or more Playwright `--reporter=json` reports (or Jest results) and surfaces the
// failing + flaky tests. With several reports it AGGREGATES them into a real per-test flake
// rate ("failed 7/10 runs") — the truest signal for "how flaky is this test".
//
// Usage:
//   node parse-report.mjs <report.json | dir> [more...]          → human summary (default)
//   node parse-report.mjs --worklist <report|dir> [more...]      → flake COUNT + ranked fix list
//   node parse-report.mjs --json     <report|dir> [more...]      → machine JSON
//   node parse-report.mjs --stats    <report|dir> [more...]      → one-line pass/fail tally
//
// Exit code is always 0 — this is informational.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
let mode = 'human';
if (argv.includes('--json')) mode = 'json';
if (argv.includes('--stats')) mode = 'stats';
if (argv.includes('--worklist')) mode = 'worklist';
const targets = argv.filter((a) => !a.startsWith('--'));

if (!targets.length) {
  console.error('parse-report: no report path given.');
  console.error('usage: node parse-report.mjs [--worklist|--json|--stats] <report.json|dir> [more...]');
  process.exit(0);
}

// ── Gather every report file from the given targets ───────────────────────────
function looksLikeReport(p) {
  try {
    const txt = readFileSync(p, 'utf8');
    if (/^\s*</.test(txt)) return /<testcase\b|<testsuite\b/.test(txt); // JUnit XML
    const j = JSON.parse(txt);
    return !!(j.suites || j.testResults);
  } catch {
    return false;
  }
}
function gatherReports(t) {
  if (!existsSync(t)) return [];
  if (statSync(t).isFile()) return [t];
  const out = new Set();
  const candidates = [
    'results.json',
    'report.json',
    'test-results.json',
    'junit.xml',
    'results.xml',
    join('test-results', 'results.json'),
    join('test-results', 'junit.xml'),
    join('playwright-report', 'results.json'),
  ];
  for (const c of candidates) {
    const p = join(t, c);
    if (existsSync(p) && statSync(p).isFile()) out.add(p);
  }
  for (const f of readdirSync(t)) {
    if (!/\.(json|xml)$/.test(f)) continue;
    const p = join(t, f);
    try {
      if (statSync(p).isFile() && looksLikeReport(p)) out.add(p);
    } catch {
      /* skip */
    }
  }
  return [...out];
}

const reportFiles = [...new Set(targets.flatMap(gatherReports))];
if (!reportFiles.length) {
  console.error(`parse-report: no JSON report found in: ${targets.join(', ')}`);
  console.error('Generate one with:  npx playwright test … --reporter=json > results.json');
  process.exit(0);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function trimErr(s, lines = 6) {
  if (!s) return '';
  return s
    .replace(/\[[0-9;]*m/g, '')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .slice(0, lines)
    .join('\n');
}
const ENV_SIGNS =
  /\b(50[0-4]|ECONNREFUSED|ERR_CONNECTION|net::ERR|ERR_NETWORK|socket hang up|tenant not found|Bad Gateway|Gateway Time-?out|Service Unavailable)\b/i;
const envSuspect = (m) => ENV_SIGNS.test(m || '');

// Map an error signature → a probable flake category + the bolt Pattern # to cite.
function guessCategory(msg) {
  const m = msg || '';
  if (envSuspect(m)) return { cat: 'env/infra', ref: '' };
  if (/networkidle/i.test(m)) return { cat: 'networkidle hang', ref: '#5' };
  if (/\bwaitForTimeout\b/i.test(m)) return { cat: 'hard wait', ref: '#5' };
  if (/Target (page|context|browser) has been closed|Execution context was destroyed|Navigation (interrupted|failed)/i.test(m))
    return { cat: 'page-load/navigation race', ref: '' };
  if (/strict mode violation|resolved to \d+ elements/i.test(m))
    return { cat: 'ambiguous locator', ref: '#3' };
  if (/Timeout .*exceeded|waiting for .*(locator|getBy)|to be (visible|enabled|attached)/i.test(m))
    return { cat: 'selector/visibility race', ref: '#4/#8' };
  if (/expect\(.*\)\.|Expected:.*\n?.*Received:/is.test(m))
    return { cat: 'data assertion (re-run to tell bug from race)', ref: '#8' };
  return { cat: 'uncategorized — read the error', ref: '' };
}

// ── Parse ONE report into normalized per-run rows ─────────────────────────────
function parseReport(data) {
  const rows = [];
  function walkPlaywright(suite, trail = []) {
    const title = suite.title ? [...trail, suite.title] : trail;
    for (const spec of suite.specs || []) {
      const file = spec.file || suite.file || '';
      const line = spec.line || '';
      for (const t of spec.tests || []) {
        const results = t.results || [];
        const failed = results.filter((r) => r.status === 'failed' || r.status === 'timedOut');
        const errMsg =
          (failed[0] &&
            (failed[0].error?.message ||
              (failed[0].errors && failed[0].errors[0]?.message) ||
              failed[0].error?.stack)) ||
          '';
        rows.push({
          title: [...title, spec.title].filter(Boolean).join(' › '),
          spec: spec.title,
          file,
          line,
          project: t.projectName || '',
          status: t.status || (spec.ok ? 'expected' : 'unexpected'),
          retries: Math.max(0, results.length - 1),
          attempts: results.map((r) => r.status),
          error: trimErr(errMsg),
          envSuspect: envSuspect(errMsg),
        });
      }
    }
    for (const child of suite.suites || []) walkPlaywright(child, title);
  }
  function walkJest(d) {
    for (const file of d.testResults || []) {
      const fpath = file.name || file.testFilePath || '';
      for (const a of file.assertionResults || file.testResults || []) {
        const msgs = (a.failureMessages || []).join('\n');
        const status =
          a.status === 'passed' ? 'expected' : a.status === 'failed' ? 'unexpected' : a.status;
        rows.push({
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
  return rows;
}

// ── Parse a JUnit XML report (what bolt's runs emit) — regex, no XML dep ───────
function parseJUnit(xml) {
  const rows = [];
  const unesc = (s) =>
    (s || '')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#10;/g, '\n')
      .replace(/&#9;/g, '\t')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  const attr = (s, n) => {
    const m = s.match(new RegExp(n + '="([^"]*)"'));
    return m ? unesc(m[1]) : '';
  };
  const reCase = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m;
  while ((m = reCase.exec(xml))) {
    const attrs = m[1];
    const inner = m[3] || '';
    let status = 'expected';
    let error = '';
    if (/<failure\b|<error\b/.test(inner)) {
      status = 'unexpected';
      const fm = inner.match(
        /<(?:failure|error)\b([^>]*)>([\s\S]*?)<\/(?:failure|error)>|<(?:failure|error)\b([^>]*)\/>/,
      );
      if (fm) error = (attr(fm[1] || fm[3] || '', 'message') || unesc(fm[2] || '')).trim();
    } else if (/<skipped\b/.test(inner)) {
      status = 'skipped';
    }
    rows.push({
      title: attr(attrs, 'name'),
      spec: attr(attrs, 'name'),
      file: attr(attrs, 'classname'),
      line: '',
      project: '',
      status,
      retries: 0,
      attempts: [status === 'expected' ? 'passed' : status === 'skipped' ? 'skipped' : 'failed'],
      error: trimErr(error),
      envSuspect: envSuspect(error),
    });
  }
  return rows;
}

// Parse all reports; keep both a flat list (for human/json/stats) and per-report runs.
const perReport = reportFiles.map((f) => {
  try {
    const txt = readFileSync(f, 'utf8');
    const rows = /^\s*</.test(txt) ? parseJUnit(txt) : parseReport(JSON.parse(txt));
    return { file: f, rows };
  } catch (e) {
    console.error(`parse-report: skipped "${f}": ${e.message}`);
    return { file: f, rows: [] };
  }
});
const tests = perReport.flatMap((r) => r.rows);

// ── Flat tallies (single-report view) ─────────────────────────────────────────
const flaky = tests.filter((t) => t.status === 'flaky');
const failed = tests.filter((t) => t.status === 'unexpected');
const passed = tests.filter((t) => t.status === 'expected');
const skipped = tests.filter((t) => t.status === 'skipped');
const totalRan = passed.length + failed.length + flaky.length;
const passRate = totalRan ? ((passed.length / totalRan) * 100).toFixed(0) : '—';

// ── Aggregate ACROSS runs (key = file::title::project) for true flake rate ────
function aggregate() {
  const map = new Map();
  for (const { rows } of perReport) {
    for (const r of rows) {
      if (r.status === 'skipped') continue;
      const key = `${r.file}::${r.title}::${r.project}`;
      let a = map.get(key);
      if (!a) {
        a = { ...r, runs: 0, fail: 0, flaky: 0, pass: 0, lastError: '', anyEnv: false };
        map.set(key, a);
      }
      a.runs += 1;
      if (r.status === 'expected') a.pass += 1;
      else if (r.status === 'flaky') a.flaky += 1;
      else a.fail += 1;
      if (r.error) a.lastError = r.error;
      if (r.envSuspect) a.anyEnv = true;
    }
  }
  const items = [];
  for (const a of map.values()) {
    const bad = a.fail + a.flaky; // unstable observations
    let verdict;
    if (a.flaky > 0 || (a.fail > 0 && a.fail < a.runs)) verdict = 'FLAKE';
    else if (a.fail === a.runs && a.runs > 0) {
      if (a.anyEnv) verdict = 'ENV';
      else if (a.runs > 1) verdict = 'REAL_BUG';
      else verdict = 'NEEDS_RERUN';
    } else verdict = 'PASS';
    const { cat, ref } = guessCategory(a.lastError);
    items.push({
      title: a.title,
      spec: a.spec,
      file: a.file,
      line: a.line,
      project: a.project,
      runs: a.runs,
      fail: a.fail,
      flaky: a.flaky,
      bad,
      rate: a.runs ? Math.round((bad / a.runs) * 100) : 0,
      verdict,
      cat,
      ref,
      error: a.lastError,
    });
  }
  return items;
}

// ── Output ────────────────────────────────────────────────────────────────────
if (mode === 'stats') {
  console.log(
    `reports=${reportFiles.length} runs=${totalRan} pass=${passed.length} ` +
      `fail=${failed.length} flaky=${flaky.length} skip=${skipped.length} passRate=${passRate}%`,
  );
  process.exit(0);
}

if (mode === 'json') {
  console.log(
    JSON.stringify(
      {
        reports: reportFiles,
        stats: {
          passed: passed.length,
          failed: failed.length,
          flaky: flaky.length,
          skipped: skipped.length,
          passRate,
        },
        worklist: aggregate(),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

if (mode === 'worklist') {
  const items = aggregate();
  const fix = items
    .filter((i) => i.verdict === 'FLAKE')
    .sort((a, b) => b.rate - a.rate || b.bad - a.bad);
  const rerun = items.filter((i) => i.verdict === 'NEEDS_RERUN');
  const bugs = items.filter((i) => i.verdict === 'REAL_BUG');
  const env = items.filter((i) => i.verdict === 'ENV');
  const multi = reportFiles.length > 1;

  console.log('=== Flake Work List ===');
  console.log(
    `Source: ${reportFiles.length} report(s)` + (multi ? ' (aggregated for per-test flake rate)' : ''),
  );
  console.log('');
  console.log(
    `Counts:  ${fix.length} FLAKE` +
      `  ·  ${rerun.length} needs re-run` +
      `  ·  ${bugs.length} real-bug candidate` +
      `  ·  ${env.length} env (ignore)`,
  );
  console.log('');

  const loc = (i) => `${i.file}${i.line ? ':' + i.line : ''}${i.project ? ' [' + i.project + ']' : ''}`;
  const rate = (i) => (multi ? `[flaky ${i.rate}% · ${i.bad}/${i.runs}] ` : '');

  if (fix.length) {
    console.log('── WORK ON THESE — flaky, fix the test (worst-first) ─────────────────────────');
    fix.forEach((i, n) => {
      console.log(`  ${n + 1}. ${rate(i)}${i.title}`);
      console.log(`        ${loc(i)}   likely: ${i.cat}${i.ref ? '  ' + i.ref : ''}`);
    });
    console.log('');
  } else {
    console.log('No confirmed flakes in this input.');
    console.log('');
  }

  if (rerun.length) {
    console.log('── NEEDS RE-RUN to classify (failed once, no env signature) ──────────────────');
    for (const i of rerun) {
      console.log(`  - ${i.title}`);
      console.log(`        ${loc(i)}`);
      console.log(`        ./rerun.sh "${i.file}${i.spec ? ` -g '${i.spec}'` : ''}" 10`);
    }
    console.log('');
  }

  if (bugs.length || env.length) {
    console.log('── NOT YOUR FIX ──────────────────────────────────────────────────────────────');
    for (const i of bugs)
      console.log(`  - real-bug candidate: ${i.title} (failed ${i.fail}/${i.runs}) → draft a bug`);
    for (const i of env)
      console.log(`  - env: ${i.title} (${loc(i)}) → re-run when the env is healthy`);
    console.log('');
  }

  console.log(
    multi
      ? '(Per-test rate is real — aggregated across the reports you passed.)'
      : '(One report = one observation. Pass several reports, or use ./rerun.sh, for a true rate.)',
  );
  process.exit(0);
}

// Human summary (default)
const line = (s) => console.log(s);
line(`=== Report(s): ${reportFiles.join(', ')} ===`);
line(
  `passed=${passed.length}  failed=${failed.length}  flaky=${flaky.length}  ` +
    `skipped=${skipped.length}  passRate=${passRate}%`,
);
line('');
function block(label, rows) {
  if (!rows.length) return;
  line(`── ${label} (${rows.length}) ───────────────────────────────────────────`);
  for (const t of rows) {
    const l = t.file ? `${t.file}${t.line ? ':' + t.line : ''}` : '(no location)';
    const proj = t.project ? ` [${t.project}]` : '';
    const env = t.envSuspect ? '  <ENV-SUSPECT: 5xx/conn signature>' : '';
    line(`• ${t.title}${proj}`);
    line(`    ${l}   attempts: [${t.attempts.join(' → ')}]   retries: ${t.retries}${env}`);
    if (t.error) for (const el of t.error.split('\n')) line(`      ${el}`);
    line('');
  }
}
block('FLAKY (failed then passed on retry — flake by definition)', flaky);
block('UNEXPECTED (failed through all retries — re-run to classify)', failed);
if (!flaky.length && !failed.length) line('No failing or flaky tests in this report.');
line('(ENV-SUSPECT = the error carries a 5xx/connection signature → likely env/infra, not code.)');
line('(Tip: `node parse-report.mjs --worklist <report>` prints a flake count + ranked fix list.)');
