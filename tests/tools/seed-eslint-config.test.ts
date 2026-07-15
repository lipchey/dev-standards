import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAllowedSpec } from '../../tools/check-new-deps.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'seed-eslint-config.sh');

function seed(root: string) {
  return spawnSync('bash', [SCRIPT, root], { encoding: 'utf8' });
}

/* realpath the mkdtemp so macOS's /var → /private/var symlink never makes the
   consumer path differ from what the seeder resolves via `pwd -P`. */
function withConsumer(pkg: Record<string, unknown>, callback: (root: string) => void): void {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ds-seed-eslint-')));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg) + '\n');
    callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/* Pins seeder⇄gate compatibility: the seeder's WANT map may only emit specs the
   N1 dependency-pin gate accepts, proven against the gate's OWN grammar oracle —
   revert the D6 `>=9.38.0`→`^9.38.0` fix and this turns red. */
test('every seeded devDependencies spec satisfies the N1 grammar', () => {
  withConsumer({}, (root) => {
    const result = seed(root);
    assert.equal(result.status, 0, result.stderr);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const deps = pkg.devDependencies ?? {};
    assert.ok(Object.keys(deps).length > 0, 'seeder must inject devDependencies into a bare package.json');
    for (const [name, spec] of Object.entries(deps)) {
      assert.ok(isAllowedSpec(spec), `seeded spec for "${name}" is not grammar-allowed: ${JSON.stringify(spec)}`);
    }
  });
});

/* 8.0.0 is a non-default pin (the seeder's default is ^9.38.0): an overwrite
   would flip the value, so this proves add-if-absent, not a default that happens
   to match. */
test('a pre-pinned eslint version is preserved (add-if-absent contract)', () => {
  withConsumer({ devDependencies: { eslint: '8.0.0' } }, (root) => {
    const result = seed(root);
    assert.equal(result.status, 0, result.stderr);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(pkg.devDependencies.eslint, '8.0.0');
  });
});

test('the lint script is seeded when absent and preserved when present', () => {
  withConsumer({}, (root) => {
    const result = seed(root);
    assert.equal(result.status, 0, result.stderr);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts.lint, 'eslint .');
  });
  withConsumer({ scripts: { lint: 'eslint src --max-warnings 0' } }, (root) => {
    const result = seed(root);
    assert.equal(result.status, 0, result.stderr);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts.lint, 'eslint src --max-warnings 0');
  });
});

/* Severity `error` in the seeded config is only a gate when verify runs ESLint:
   the seeder must wire a BLOCKING (no `mode` key) check into fast+full, and must
   never touch a consumer that already carries an eslint check in ANY tier (the
   documented report-only ramp). */
test('a blocking eslint check is wired into fast and full quality tiers', () => {
  withConsumer({}, (root) => {
    fs.writeFileSync(
      path.join(root, 'quality.json'),
      JSON.stringify({ tiers: { staged: [], fast: [], full: [] } }) + '\n',
    );
    const result = seed(root);
    assert.equal(result.status, 0, result.stderr);
    const quality = JSON.parse(fs.readFileSync(path.join(root, 'quality.json'), 'utf8'));
    for (const tierName of ['fast', 'full'] as const) {
      const checks = quality.tiers[tierName].filter((check: { name: string }) => check.name === 'eslint');
      assert.equal(checks.length, 1, `${tierName} must gain exactly one eslint check`);
      assert.deepEqual(checks[0].argv, ['npm', 'run', 'lint']);
      assert.equal('mode' in checks[0], false, `${tierName} eslint check must be blocking (no mode key)`);
    }
    assert.equal(quality.tiers.staged.length, 0);
  });
});

test('an existing eslint check in any tier is left untouched (ramp contract)', () => {
  withConsumer({}, (root) => {
    const rampCheck = { name: 'eslint', argv: ['npm', 'run', 'lint'], mode: 'report-only' };
    fs.writeFileSync(
      path.join(root, 'quality.json'),
      JSON.stringify({ tiers: { fast: [rampCheck], full: [] } }) + '\n',
    );
    const result = seed(root);
    assert.equal(result.status, 0, result.stderr);
    const quality = JSON.parse(fs.readFileSync(path.join(root, 'quality.json'), 'utf8'));
    assert.deepEqual(quality.tiers.fast, [rampCheck]);
    assert.deepEqual(quality.tiers.full, []);
  });
});

test('a consumer without quality.json seeds cleanly with an operator note', () => {
  withConsumer({}, (root) => {
    const result = seed(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /quality\.json: absent/);
  });
});
