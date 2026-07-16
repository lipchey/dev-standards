import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../../runner/src/cli.ts';

// BUG-12: SCOPE_FLAGS is a plain object, so a bare `[arg]` lookup used to
// resolve inherited Object.prototype members (toString, constructor,
// __proto__) as if they were valid scope flags. These must fail usage
// validation (exit 2 upstream) instead of masquerading as a scope.
for (const arg of ['toString', 'constructor', '__proto__']) {
  test(`inherited-property arg "${arg}" is rejected as an unknown scope`, () => {
    const result = parseArgs(['--manifest', 'quality.json', arg]);
    assert.ok(!result.ok, `expected failure; got ${JSON.stringify(result)}`);
    assert.match(result.message, /unknown/i);
  });
}
