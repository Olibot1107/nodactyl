'use strict';

function fail(msg, expected, actual) {
  const err = new Error(msg);
  err.expected = expected;
  err.actual = actual;
  throw err;
}

function ok(val, msg) {
  if (!val) fail(msg || `Expected truthy, got ${JSON.stringify(val)}`);
}

function eq(actual, expected, msg) {
  if (actual !== expected) fail(msg || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`, expected, actual);
}

function notEq(actual, unexpected, msg) {
  if (actual === unexpected) fail(msg || `Expected value to not be ${JSON.stringify(unexpected)}`, `not ${unexpected}`, actual);
}

function status(res, code, hint) {
  if (res.status !== code) {
    fail(`Expected HTTP ${code}${hint ? ' (' + hint + ')' : ''}, got ${res.status} — ${res.body?.error || res.raw?.slice(0, 80)}`, code, res.status);
  }
}

function hasField(obj, field, msg) {
  if (obj == null || !(field in obj)) fail(msg || `Expected field "${field}" in ${JSON.stringify(obj)}`);
}

module.exports = { ok, eq, notEq, status, hasField, fail };
