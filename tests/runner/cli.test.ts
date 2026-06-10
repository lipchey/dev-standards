import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../../runner/src/cli.ts';

test('--manifest quality.json --fast', () => {
  const result = parseArgs(['--manifest', 'quality.json', '--fast']);
  assert.ok(result.ok, `expected ok; got ${JSON.stringify(result)}`);
  assert.equal(result.manifestPath, 'quality.json');
  assert.equal(result.scope, 'fast');
});

test('--manifest quality.json --full', () => {
  const result = parseArgs(['--manifest', 'quality.json', '--full']);
  assert.ok(result.ok, `expected ok; got ${JSON.stringify(result)}`);
  assert.equal(result.manifestPath, 'quality.json');
  assert.equal(result.scope, 'full');
});

test('--manifest quality.json --doctor', () => {
  const result = parseArgs(['--manifest', 'quality.json', '--doctor']);
  assert.ok(result.ok, `expected ok; got ${JSON.stringify(result)}`);
  assert.equal(result.manifestPath, 'quality.json');
  assert.equal(result.scope, 'doctor');
});

test('missing --manifest fails', () => {
  const result = parseArgs(['--fast']);
  assert.ok(!result.ok, `expected failure; got ${JSON.stringify(result)}`);
  assert.match(result.message, /manifest/i);
});

test('multiple scopes fail', () => {
  const result = parseArgs(['--manifest', 'quality.json', '--fast', '--full']);
  assert.ok(!result.ok, `expected failure; got ${JSON.stringify(result)}`);
  assert.match(result.message, /scope/i);
});

test('unknown scope fails', () => {
  const result = parseArgs(['--manifest', 'quality.json', '--turbo']);
  assert.ok(!result.ok, `expected failure; got ${JSON.stringify(result)}`);
  assert.match(result.message, /unknown/i);
});
