'use strict';
const path = require('path');
const fs = require('fs');
const { startServer, stopServer } = require('./helpers');

const C = {
  reset: '\x1b[0m',
  bold:  '\x1b[1m',
  dim:   '\x1b[2m',
  green: '\x1b[32m',
  red:   '\x1b[31m',
  yellow:'\x1b[33m',
  cyan:  '\x1b[36m',
  white: '\x1b[37m',
};

function c(color, str) { return C[color] + str + C.reset; }

// ── Test registration helpers shared across test files ────────────────────────

const _suites = new Map(); // filename → [{ name, fn }]
let _currentFile = null;

global.describe = function(label, fn) {
  _currentFile = label;
  if (!_suites.has(label)) _suites.set(label, []);
  fn();
};

global.it = function(name, fn) {
  if (!_currentFile) return;
  _suites.get(_currentFile).push({ name, fn });
};

// ── Load test files ────────────────────────────────────────────────────────────

const testDir = __dirname;
const filter = process.argv[2]; // optional: "auth" to run only auth.test.js

const files = fs.readdirSync(testDir)
  .filter(f => f.endsWith('.test.js'))
  .filter(f => !filter || f.includes(filter))
  .sort();

if (!files.length) {
  console.error('No test files found' + (filter ? ` matching "${filter}"` : ''));
  process.exit(1);
}

for (const f of files) {
  require(path.join(testDir, f));
}

// ── Runner ────────────────────────────────────────────────────────────────────

async function run() {
  const startAll = Date.now();
  console.log('\n' + c('bold', '══════════════════════════════════════════════'));
  console.log(c('bold', '  Nodactyl Test Suite'));
  console.log(c('bold', '══════════════════════════════════════════════'));

  process.stdout.write('\n  Starting panel on port 3099...');
  const t0 = Date.now();
  try {
    await startServer();
  } catch (err) {
    console.error('\n  ' + c('red', 'Failed to start panel: ') + err.message);
    process.exit(1);
  }
  console.log(c('dim', ` ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`));

  let totalPass = 0;
  let totalFail = 0;
  const failures = [];

  for (const [suite, tests] of _suites) {
    console.log('\n' + c('dim', '──────────────────────────────────────────────'));
    console.log(c('cyan', `  ${suite}`));
    console.log(c('dim', '──────────────────────────────────────────────'));

    for (const { name, fn } of tests) {
      const t = Date.now();
      try {
        await fn();
        const ms = Date.now() - t;
        console.log(`  ${c('green', '✓')} ${c('dim', name)}${ms > 500 ? c('yellow', ` (${ms}ms)`) : ''}`);
        totalPass++;
      } catch (err) {
        const ms = Date.now() - t;
        console.log(`  ${c('red', '✗')} ${name}${ms > 500 ? c('yellow', ` (${ms}ms)`) : ''}`);
        const detail = err.message || String(err);
        console.log(`    ${c('red', detail)}`);
        if (err.actual !== undefined) {
          console.log(`    ${c('dim', 'expected:')} ${JSON.stringify(err.expected)}  ${c('dim', 'got:')} ${JSON.stringify(err.actual)}`);
        }
        totalFail++;
        failures.push({ suite, name, error: detail });
      }
    }
  }

  await stopServer();

  const duration = ((Date.now() - startAll) / 1000).toFixed(1);
  console.log('\n' + c('bold', '══════════════════════════════════════════════'));
  const summary = `  ${c('green', `${totalPass} passed`)}, ${totalFail > 0 ? c('red', `${totalFail} failed`) : c('dim', '0 failed')}  ${c('dim', `(${duration}s)`)}`;
  console.log(summary);

  if (failures.length) {
    console.log('\n' + c('red', '  Failed tests:'));
    for (const f of failures) {
      console.log(`  ${c('dim', f.suite)} › ${f.name}`);
      console.log(`    ${c('red', f.error)}`);
    }
  }

  console.log(c('bold', '══════════════════════════════════════════════') + '\n');
  process.exit(totalFail > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Runner crashed:', err);
  stopServer().catch(() => {});
  process.exit(1);
});
