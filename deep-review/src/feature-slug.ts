// Feature-slug + worktree-path helpers, extracted (copied verbatim) from the
// workflow module so deep-review no longer imports it — workflow/ is removed in a
// later phase. Same SLUG_RE, same SlugError shape (its `input` field and message
// are asserted at the deep-review CLI edge and in tests), and the same
// defaultFeatureWorktree body, so the slug contract and the SlugError identity
// deep-review maps to EXIT_USAGE stay byte-for-byte compatible.

import path from 'node:path';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;

export class SlugError extends Error {
  readonly input: string;
  constructor(input: string) {
    super(`invalid feature slug: ${JSON.stringify(input)}`);
    this.name = 'SlugError';
    this.input = input;
    Object.setPrototypeOf(this, SlugError.prototype);
  }
}

export function sanitizeFeatureSlug(input: string): string {
  if (!SLUG_RE.test(input)) throw new SlugError(input);
  if (input.includes('..') || input.includes('/') || input.includes('\\') || input.includes('\0')) {
    throw new SlugError(input);
  }
  return input;
}

export function defaultFeatureWorktree(parent: string, slug: string): string {
  return path.join(parent, slug);
}
