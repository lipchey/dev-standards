import type { Manifest, ValidationError, ValidationResult } from './types.ts';

/**
 * Hand validator for quality manifests. Structural checks mirror the schema
 * (including diff_filter's `^[ACDMRTUXB]+$` pattern); semantic checks cover
 * cross-field rules. Error paths are dotted/indexed.
 */

type RuleName =
  // Structural rules. (`json-parse` is reserved for the manifest loader.)
  | 'required'
  | 'type'
  | 'enum'
  | 'additional-property'
  | 'min-length'
  | 'min-items'
  | 'unique-items'
  | 'pattern'
  // Semantic rules.
  | 'tier-budget'
  | 'files-token-count'
  | 'files-token-position'
  | 'files-token-reference'
  | 'skip-if-empty-reference'
  | 'fileset-name-unique'
  | 'check-name-unique'
  | 'workspace-name-unique'
  | 'glob-dialect'
  | 'glob-globstar-segment'
  | 'diff-filter-scope'
  | 'format-fileset-reference'
  | 'format-fileset-source'
  | 'format-fileset-filter'
  | 'format-argv-token'
  | 'group-reference'
  | 'group-name-unique'
  | 'group-membership'
  | 'group-eligibility'
  | 'group-tier'
  | 'group-argv-token'
  | 'group-path';

type UniquenessRule =
  | 'fileset-name-unique'
  | 'check-name-unique'
  | 'workspace-name-unique'
  | 'group-name-unique';

const STACKS = ['node-service', 'frontend-web', 'n8n-ops', 'meta-docs'] as const;
const SCHEDULER_CLASSES = [
  'github-actions-push-and-schedule',
  'n8n-webhook-and-schedule',
  'schedule-only',
  'local-only',
] as const;
const FILESET_SOURCES = ['git_staged', 'repo_all'] as const;
const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'none'] as const;
const CHECK_MODES = ['blocking', 'report-only'] as const;

const TOP_LEVEL_REQUIRED = [
  'version',
  'repo',
  'stack',
  'scheduler_class',
  'budgets',
  'policy',
  'paths',
  'generated',
  'workspaces',
  'filesets',
  'tiers',
] as const;
const TOP_LEVEL_ALLOWED = [...TOP_LEVEL_REQUIRED, 'groups', 'format', 'deep_review'] as const;
const FORMAT_KEYS = ['argv', 'fileset', 'timeout_seconds'] as const;
// A/C/M/R all resolve to an existing regular file; D/T/U/X/B would hand the formatter a
// deleted, type-changed, or conflicted path, so a format fileset's filter must stay within these.
const FORMAT_SAFE_FILTER = new Set(['A', 'C', 'M', 'R']);

const BUDGET_KEYS = ['staged_seconds', 'fast_seconds', 'full_seconds', 'audit_seconds'] as const;
const POLICY_KEYS = [
  'mutates_by_default',
  'format_fix_staged_allowed',
  'typed_eslint_in_precommit',
  'block_new_dead_code_only',
] as const;
const PATH_KEYS = ['reports', 'baselines'] as const;
const WORKSPACE_KEYS = ['name', 'path', 'stack', 'package_manager'] as const;
const FILESET_REQUIRED = ['name', 'source', 'include'] as const;
const FILESET_ALLOWED = [...FILESET_REQUIRED, 'exclude', 'diff_filter'] as const;
const CHECK_REQUIRED = ['name', 'argv', 'timeout_seconds'] as const;
const CHECK_ALLOWED = [
  ...CHECK_REQUIRED,
  'skip_if_empty',
  'mode',
  'baseline',
  'bypassable',
  'operational_exit_codes',
  'group',
] as const;
const GROUP_REQUIRED = ['name', 'argv', 'artifact_dir', 'members'] as const;
const GROUP_MEMBER_KEYS = ['check', 'result_key'] as const;
const REQUIRED_TIERS = ['staged', 'fast', 'full'] as const;
const TIER_NAMES = ['staged', 'fast', 'full', 'audit'] as const;

// git --diff-filter letters; mirrors schemas/quality.schema.json diff_filter.
const DIFF_FILTER_PATTERN = /^[ACDMRTUXB]+$/;

// deep_review (ADR-007). Optional top-level block; `{ "enabled": false }` (or
// absent) is valid. `enabled` is the only required key; other fields are
// type/enum-checked only when present.
const DEEP_REVIEW_REQUIRED = ['enabled'] as const;
const DEEP_REVIEW_KEYS = [
  'enabled',
  'trigger',
  'modes',
  'budget',
  'verify_after_fix',
  'verify_entry',
  'no_touch_globs_ref',
  'guides_dir',
  'required_reads',
] as const;
const DEEP_REVIEW_TRIGGERS = ['manual-only'] as const;
const DEEP_REVIEW_MODES = ['review-only', 'review-and-refactor'] as const;
const DEEP_REVIEW_VERIFY = ['--fast', '--full'] as const;
const DEEP_REVIEW_BUDGET_REQUIRED = ['seconds'] as const;
const DEEP_REVIEW_BUDGET_KEYS = ['seconds', 'tokens'] as const;

const FILES_TOKEN = /^\{files:([\w-]+)\}$/;
// A fileset name must be referenceable via the `{files:<name>}` token, whose grammar is `[\w-]+`.
// Anything else (a dot, space, …) validates as a non-empty string yet can never be referenced.
const FILESET_NAME_PATTERN = /^[\w-]+$/;
// The schema dialect allows only `*`, `**`, and literals.
const UNSUPPORTED_GLOB_SYNTAX = /[?[{]/;
// A group name and every `artifact_dir` segment become filesystem components the runner writes to
// and deletes, so the grammar stays narrow enough that no accepted value can leave the namespace.
const GROUP_SEGMENT_PATTERN = /^[\w.-]+$/;
// Deliberately broader than `FILES_TOKEN`: a group argv rejects anything `{files:…}`-shaped, not
// only a legal fileset name, because a batch has no fileset to expand and no way to report a skip.
const GROUP_FILES_TOKEN = /^\{files:.*\}$/s;

// Rest tuple distinguishes "no value" from an explicit undefined value.
function addError(
  errors: ValidationError[],
  path: string,
  rule: RuleName,
  message: string,
  ...value: [] | [unknown]
): void {
  const error: ValidationError = { path, rule, message };
  if (value.length === 1) {
    error.value = value[0];
  }
  errors.push(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (isUnknownArray(value)) return 'an array';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
    case 'bigint':
    case 'boolean':
    case 'symbol':
    case 'undefined':
    case 'function':
      return String(value);
    default:
      /* typeof === 'object' (null/array handled above). The object case sits in
         `default` because TS neither narrows `unknown` through negated typeof
         guards nor proves typeof-switch exhaustiveness — a positive-case-only
         switch fails TS2366. */
      return 'an object';
  }
}

function childPath(parentPath: string, key: string): string {
  return parentPath === '' ? key : `${parentPath}.${key}`;
}

function requireRecord(
  value: unknown,
  path: string,
  errors: ValidationError[],
): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  addError(errors, path, 'type', `must be an object, got ${describeValue(value)}`, value);
  return undefined;
}

function requireKeys(
  record: Record<string, unknown>,
  parentPath: string,
  keys: readonly string[],
  errors: ValidationError[],
): void {
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) {
      addError(errors, childPath(parentPath, key), 'required', `missing required key "${key}"`);
    }
  }
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  parentPath: string,
  allowed: readonly string[],
  errors: ValidationError[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      addError(
        errors,
        childPath(parentPath, key),
        'additional-property',
        `unknown key "${key}" (allowed keys: ${allowed.join(', ')})`,
        record[key],
      );
    }
  }
}

function validateNonEmptyString(value: unknown, path: string, errors: ValidationError[]): void {
  if (typeof value !== 'string') {
    addError(errors, path, 'type', `must be a string, got ${describeValue(value)}`, value);
  } else if (value.length === 0) {
    addError(errors, path, 'min-length', 'must be a non-empty string', value);
  }
}

function validateString(value: unknown, path: string, errors: ValidationError[]): void {
  if (typeof value !== 'string') {
    addError(errors, path, 'type', `must be a string, got ${describeValue(value)}`, value);
  }
}

function validateBoolean(value: unknown, path: string, errors: ValidationError[]): void {
  if (typeof value !== 'boolean') {
    addError(errors, path, 'type', `must be a boolean, got ${describeValue(value)}`, value);
  }
}

function validatePositiveInteger(value: unknown, path: string, errors: ValidationError[]): void {
  if (!isPositiveInteger(value)) {
    addError(errors, path, 'type', `must be a positive integer, got ${describeValue(value)}`, value);
  }
}

function validateEnum(
  value: unknown,
  path: string,
  allowed: readonly string[],
  errors: ValidationError[],
): void {
  if (typeof value === 'string' && allowed.includes(value)) return;
  addError(
    errors,
    path,
    'enum',
    `must be one of: ${allowed.join(', ')}; got ${describeValue(value)}`,
    value,
  );
}

function validateStringArray(
  value: unknown,
  path: string,
  minItems: 0 | 1,
  errors: ValidationError[],
  // When true, each item must be a NON-EMPTY string (mirrors schema items.minLength:1). Off by
  // default so callers whose schema allows "" (e.g. plain argv) are unaffected.
  requireNonEmptyItems = false,
): void {
  if (!isUnknownArray(value)) {
    addError(errors, path, 'type', `must be an array of strings, got ${describeValue(value)}`, value);
    return;
  }
  if (value.length < minItems) {
    addError(errors, path, 'min-items', `must contain at least ${minItems} item`, value);
  }
  value.forEach((item, index) => {
    if (typeof item !== 'string') {
      addError(errors, `${path}[${index}]`, 'type', `must be a string, got ${describeValue(item)}`, item);
    } else if (requireNonEmptyItems && item.length === 0) {
      addError(errors, `${path}[${index}]`, 'min-length', 'must be a non-empty string', item);
    }
  });
}

function validateStructure(root: Record<string, unknown>, errors: ValidationError[]): void {
  requireKeys(root, '', TOP_LEVEL_REQUIRED, errors);
  rejectUnknownKeys(root, '', TOP_LEVEL_ALLOWED, errors);
  if (Object.hasOwn(root, 'version')) validateVersion(root['version'], errors);
  if (Object.hasOwn(root, 'repo')) validateNonEmptyString(root['repo'], 'repo', errors);
  if (Object.hasOwn(root, 'stack')) validateEnum(root['stack'], 'stack', STACKS, errors);
  if (Object.hasOwn(root, 'scheduler_class')) {
    validateEnum(root['scheduler_class'], 'scheduler_class', SCHEDULER_CLASSES, errors);
  }
  if (Object.hasOwn(root, 'budgets')) validateBudgets(root['budgets'], errors);
  if (Object.hasOwn(root, 'policy')) validatePolicy(root['policy'], errors);
  if (Object.hasOwn(root, 'paths')) validatePaths(root['paths'], errors);
  if (Object.hasOwn(root, 'generated')) validateGenerated(root['generated'], errors);
  if (Object.hasOwn(root, 'workspaces')) validateWorkspaces(root['workspaces'], errors);
  if (Object.hasOwn(root, 'filesets')) validateFilesets(root['filesets'], errors);
  if (Object.hasOwn(root, 'tiers')) validateTiers(root['tiers'], errors);
  if (Object.hasOwn(root, 'groups')) validateGroups(root['groups'], errors);
  if (Object.hasOwn(root, 'format')) validateFormat(root['format'], errors);
  if (Object.hasOwn(root, 'deep_review')) validateDeepReview(root['deep_review'], errors);
}

function validateFormat(value: unknown, errors: ValidationError[]): void {
  const format = requireRecord(value, 'format', errors);
  if (format === undefined) return;
  requireKeys(format, 'format', FORMAT_KEYS, errors);
  rejectUnknownKeys(format, 'format', FORMAT_KEYS, errors);
  if (Object.hasOwn(format, 'argv')) validateStringArray(format['argv'], 'format.argv', 1, errors);
  if (Object.hasOwn(format, 'fileset')) validateNonEmptyString(format['fileset'], 'format.fileset', errors);
  if (Object.hasOwn(format, 'timeout_seconds')) {
    validatePositiveInteger(format['timeout_seconds'], 'format.timeout_seconds', errors);
  }
}

function validateVersion(value: unknown, errors: ValidationError[]): void {
  if (value !== 1) {
    addError(
      errors,
      'version',
      'enum',
      `must be 1 (the supported manifest major version), got ${describeValue(value)}`,
      value,
    );
  }
}

function validateBudgets(value: unknown, errors: ValidationError[]): void {
  const budgets = requireRecord(value, 'budgets', errors);
  if (budgets === undefined) return;
  requireKeys(budgets, 'budgets', BUDGET_KEYS, errors);
  rejectUnknownKeys(budgets, 'budgets', BUDGET_KEYS, errors);
  for (const key of BUDGET_KEYS) {
    if (Object.hasOwn(budgets, key)) validatePositiveInteger(budgets[key], `budgets.${key}`, errors);
  }
}

function validatePolicy(value: unknown, errors: ValidationError[]): void {
  const policy = requireRecord(value, 'policy', errors);
  if (policy === undefined) return;
  requireKeys(policy, 'policy', POLICY_KEYS, errors);
  rejectUnknownKeys(policy, 'policy', POLICY_KEYS, errors);
  for (const key of POLICY_KEYS) {
    if (Object.hasOwn(policy, key)) validateBoolean(policy[key], `policy.${key}`, errors);
  }
}

function validatePaths(value: unknown, errors: ValidationError[]): void {
  const paths = requireRecord(value, 'paths', errors);
  if (paths === undefined) return;
  requireKeys(paths, 'paths', PATH_KEYS, errors);
  rejectUnknownKeys(paths, 'paths', PATH_KEYS, errors);
  for (const key of PATH_KEYS) {
    if (Object.hasOwn(paths, key)) validateNonEmptyString(paths[key], `paths.${key}`, errors);
  }
}

function validateGenerated(value: unknown, errors: ValidationError[]): void {
  const generated = requireRecord(value, 'generated', errors);
  if (generated === undefined) return;
  requireKeys(generated, 'generated', ['hooks_dir'], errors);
  rejectUnknownKeys(generated, 'generated', ['hooks_dir', 'ci_quality'], errors);
  if (Object.hasOwn(generated, 'hooks_dir')) {
    validateNonEmptyString(generated['hooks_dir'], 'generated.hooks_dir', errors);
  }
  if (Object.hasOwn(generated, 'ci_quality')) {
    validateString(generated['ci_quality'], 'generated.ci_quality', errors);
  }
}

function validateWorkspaces(value: unknown, errors: ValidationError[]): void {
  if (!isUnknownArray(value)) {
    addError(errors, 'workspaces', 'type', `must be an array of workspaces, got ${describeValue(value)}`, value);
    return;
  }
  if (value.length === 0) {
    addError(errors, 'workspaces', 'min-items', 'must declare at least 1 workspace', value);
  }
  value.forEach((entry, index) => {
    validateWorkspace(entry, `workspaces[${index}]`, errors);
  });
}

function validateWorkspace(value: unknown, path: string, errors: ValidationError[]): void {
  const workspace = requireRecord(value, path, errors);
  if (workspace === undefined) return;
  requireKeys(workspace, path, WORKSPACE_KEYS, errors);
  rejectUnknownKeys(workspace, path, WORKSPACE_KEYS, errors);
  if (Object.hasOwn(workspace, 'name')) validateNonEmptyString(workspace['name'], `${path}.name`, errors);
  if (Object.hasOwn(workspace, 'path')) validateNonEmptyString(workspace['path'], `${path}.path`, errors);
  if (Object.hasOwn(workspace, 'stack')) validateEnum(workspace['stack'], `${path}.stack`, STACKS, errors);
  if (Object.hasOwn(workspace, 'package_manager')) {
    validateEnum(workspace['package_manager'], `${path}.package_manager`, PACKAGE_MANAGERS, errors);
  }
}

function validateFilesets(value: unknown, errors: ValidationError[]): void {
  if (!isUnknownArray(value)) {
    addError(errors, 'filesets', 'type', `must be an array of filesets, got ${describeValue(value)}`, value);
    return;
  }
  value.forEach((entry, index) => {
    validateFileset(entry, `filesets[${index}]`, errors);
  });
}

function validateFileset(value: unknown, path: string, errors: ValidationError[]): void {
  const fileset = requireRecord(value, path, errors);
  if (fileset === undefined) return;
  requireKeys(fileset, path, FILESET_REQUIRED, errors);
  rejectUnknownKeys(fileset, path, FILESET_ALLOWED, errors);
  if (Object.hasOwn(fileset, 'name')) validateFilesetName(fileset['name'], `${path}.name`, errors);
  if (Object.hasOwn(fileset, 'source')) validateEnum(fileset['source'], `${path}.source`, FILESET_SOURCES, errors);
  if (Object.hasOwn(fileset, 'include')) validateStringArray(fileset['include'], `${path}.include`, 1, errors, true);
  if (Object.hasOwn(fileset, 'exclude')) validateStringArray(fileset['exclude'], `${path}.exclude`, 0, errors, true);
  if (Object.hasOwn(fileset, 'diff_filter')) validateDiffFilter(fileset['diff_filter'], `${path}.diff_filter`, errors);
}

// A fileset name must be a non-empty string AND match the `{files:<name>}` token grammar, else it
// validates but is unreferenceable. Mirrors the schema's `pattern` on filesets.items.name.
function validateFilesetName(value: unknown, path: string, errors: ValidationError[]): void {
  validateNonEmptyString(value, path, errors);
  if (typeof value === 'string' && value.length > 0 && !FILESET_NAME_PATTERN.test(value)) {
    addError(
      errors,
      path,
      'pattern',
      'fileset name must match ^[A-Za-z0-9_-]+$ so it can be referenced via {files:<name>}',
      value,
    );
  }
}

function validateDiffFilter(value: unknown, path: string, errors: ValidationError[]): void {
  if (typeof value !== 'string') {
    addError(errors, path, 'type', `must be a string, got ${describeValue(value)}`, value);
    return;
  }
  if (!DIFF_FILTER_PATTERN.test(value)) {
    addError(
      errors,
      path,
      'pattern',
      'must match ^[ACDMRTUXB]+$ (git --diff-filter letters)',
      value,
    );
  }
}

function validateTiers(value: unknown, errors: ValidationError[]): void {
  const tiers = requireRecord(value, 'tiers', errors);
  if (tiers === undefined) return;
  requireKeys(tiers, 'tiers', REQUIRED_TIERS, errors);
  rejectUnknownKeys(tiers, 'tiers', TIER_NAMES, errors);
  for (const tier of TIER_NAMES) {
    if (Object.hasOwn(tiers, tier)) validateCheckArray(tiers[tier], `tiers.${tier}`, errors);
  }
}

function validateCheckArray(value: unknown, path: string, errors: ValidationError[]): void {
  if (!isUnknownArray(value)) {
    addError(errors, path, 'type', `must be an array of checks, got ${describeValue(value)}`, value);
    return;
  }
  value.forEach((entry, index) => {
    validateCheck(entry, `${path}[${index}]`, errors);
  });
}

function validateCheck(value: unknown, path: string, errors: ValidationError[]): void {
  const check = requireRecord(value, path, errors);
  if (check === undefined) return;
  requireKeys(check, path, CHECK_REQUIRED, errors);
  rejectUnknownKeys(check, path, CHECK_ALLOWED, errors);
  if (Object.hasOwn(check, 'name')) validateNonEmptyString(check['name'], `${path}.name`, errors);
  if (Object.hasOwn(check, 'argv')) validateStringArray(check['argv'], `${path}.argv`, 1, errors);
  if (Object.hasOwn(check, 'timeout_seconds')) {
    validatePositiveInteger(check['timeout_seconds'], `${path}.timeout_seconds`, errors);
  }
  if (Object.hasOwn(check, 'skip_if_empty')) validateString(check['skip_if_empty'], `${path}.skip_if_empty`, errors);
  if (Object.hasOwn(check, 'mode')) validateEnum(check['mode'], `${path}.mode`, CHECK_MODES, errors);
  if (Object.hasOwn(check, 'baseline')) validateString(check['baseline'], `${path}.baseline`, errors);
  if (Object.hasOwn(check, 'bypassable')) validateBoolean(check['bypassable'], `${path}.bypassable`, errors);
  if (Object.hasOwn(check, 'operational_exit_codes')) {
    validateOperationalExitCodes(check['operational_exit_codes'], `${path}.operational_exit_codes`, errors);
  }
  if (Object.hasOwn(check, 'group')) validateNonEmptyString(check['group'], `${path}.group`, errors);
}

function validateGroups(value: unknown, errors: ValidationError[]): void {
  if (!isUnknownArray(value)) {
    addError(errors, 'groups', 'type', `must be an array of groups, got ${describeValue(value)}`, value);
    return;
  }
  value.forEach((entry, index) => {
    validateGroup(entry, `groups[${index}]`, errors);
  });
}

function validateGroup(value: unknown, path: string, errors: ValidationError[]): void {
  const group = requireRecord(value, path, errors);
  if (group === undefined) return;
  requireKeys(group, path, GROUP_REQUIRED, errors);
  rejectUnknownKeys(group, path, GROUP_REQUIRED, errors);
  if (Object.hasOwn(group, 'name')) validateNonEmptyString(group['name'], `${path}.name`, errors);
  if (Object.hasOwn(group, 'argv')) {
    validateStringArray(group['argv'], `${path}.argv`, 1, errors, true);
  }
  if (Object.hasOwn(group, 'artifact_dir')) {
    validateNonEmptyString(group['artifact_dir'], `${path}.artifact_dir`, errors);
  }
  if (Object.hasOwn(group, 'members')) validateGroupMembers(group['members'], `${path}.members`, errors);
}

function validateGroupMembers(value: unknown, path: string, errors: ValidationError[]): void {
  if (!isUnknownArray(value)) {
    addError(errors, path, 'type', `must be an array of group members, got ${describeValue(value)}`, value);
    return;
  }
  if (value.length === 0) {
    addError(errors, path, 'min-items', 'must contain at least 1 member', value);
  }
  value.forEach((entry, index) => {
    const memberPath = `${path}[${index}]`;
    const member = requireRecord(entry, memberPath, errors);
    if (member === undefined) return;
    requireKeys(member, memberPath, GROUP_MEMBER_KEYS, errors);
    rejectUnknownKeys(member, memberPath, GROUP_MEMBER_KEYS, errors);
    if (Object.hasOwn(member, 'check')) {
      validateNonEmptyString(member['check'], `${memberPath}.check`, errors);
    }
    if (Object.hasOwn(member, 'result_key')) {
      validateNonEmptyString(member['result_key'], `${memberPath}.result_key`, errors);
    }
  });
}

// Mirrors the schema: a non-empty array of unique integers in [1, 255]. Item-level errors are
// indexed; `uniqueItems` is reported at the offending item so the message is actionable.
function validateOperationalExitCodes(value: unknown, path: string, errors: ValidationError[]): void {
  if (!isUnknownArray(value)) {
    addError(errors, path, 'type', `must be an array of integers, got ${describeValue(value)}`, value);
    return;
  }
  if (value.length < 1) {
    addError(errors, path, 'min-items', 'must contain at least 1 item', value);
  }
  const seen = new Set<number>();
  value.forEach((item, index) => {
    if (typeof item !== 'number' || !Number.isInteger(item) || item < 1 || item > 255) {
      addError(
        errors,
        `${path}[${index}]`,
        'type',
        `must be an integer in the inclusive range [1, 255], got ${describeValue(item)}`,
        item,
      );
      return;
    }
    if (seen.has(item)) {
      addError(errors, `${path}[${index}]`, 'unique-items', `duplicate exit code ${item}`, item);
    }
    seen.add(item);
  });
}

// deep_review (ADR-007): present-but-disabled (or absent) is valid; only
// `enabled` is required when the block is present. Optional fields are
// type/enum/integer-checked when present, mirroring the schema. `modes` items
// and `budget` are structural-only, so Ajv and this validator agree.
function validateDeepReview(value: unknown, errors: ValidationError[]): void {
  const deepReview = requireRecord(value, 'deep_review', errors);
  if (deepReview === undefined) return;
  requireKeys(deepReview, 'deep_review', DEEP_REVIEW_REQUIRED, errors);
  rejectUnknownKeys(deepReview, 'deep_review', DEEP_REVIEW_KEYS, errors);
  if (Object.hasOwn(deepReview, 'enabled')) {
    validateBoolean(deepReview['enabled'], 'deep_review.enabled', errors);
  }
  if (Object.hasOwn(deepReview, 'trigger')) {
    validateEnum(deepReview['trigger'], 'deep_review.trigger', DEEP_REVIEW_TRIGGERS, errors);
  }
  if (Object.hasOwn(deepReview, 'modes')) validateDeepReviewModes(deepReview['modes'], errors);
  if (Object.hasOwn(deepReview, 'budget')) validateDeepReviewBudget(deepReview['budget'], errors);
  if (Object.hasOwn(deepReview, 'verify_after_fix')) {
    validateEnum(deepReview['verify_after_fix'], 'deep_review.verify_after_fix', DEEP_REVIEW_VERIFY, errors);
  }
  if (Object.hasOwn(deepReview, 'verify_entry')) {
    validateNonEmptyString(deepReview['verify_entry'], 'deep_review.verify_entry', errors);
  }
  if (Object.hasOwn(deepReview, 'no_touch_globs_ref')) {
    validateNonEmptyString(deepReview['no_touch_globs_ref'], 'deep_review.no_touch_globs_ref', errors);
  }
  if (Object.hasOwn(deepReview, 'guides_dir')) {
    validateNonEmptyString(deepReview['guides_dir'], 'deep_review.guides_dir', errors);
  }
  if (Object.hasOwn(deepReview, 'required_reads')) {
    validateStringArray(deepReview['required_reads'], 'deep_review.required_reads', 0, errors);
    // Each entry must be a NON-EMPTY string, matching the schema's items.minLength:1 (else Ajv
    // and this validator diverge). An empty entry is also a brick: it resolves to cwd, "exists",
    // and its empty tail matches nothing, so the guides-read gate would block every review.
    const reads = deepReview['required_reads'];
    if (isUnknownArray(reads)) {
      reads.forEach((item, index) => {
        if (item === '') {
          addError(errors, `deep_review.required_reads[${index}]`, 'min-length', 'must be a non-empty string', item);
        }
      });
    }
  }
}

function validateDeepReviewModes(value: unknown, errors: ValidationError[]): void {
  if (!isUnknownArray(value)) {
    addError(errors, 'deep_review.modes', 'type', `must be an array of modes, got ${describeValue(value)}`, value);
    return;
  }
  value.forEach((item, index) => {
    validateEnum(item, `deep_review.modes[${index}]`, DEEP_REVIEW_MODES, errors);
  });
}

// tokens may be a positive integer or null (the schema's ["integer","null"] +
// minimum:1; minimum does not constrain null). Treat null as valid so the
// conformance battery cannot diverge from Ajv.
function validateDeepReviewBudget(value: unknown, errors: ValidationError[]): void {
  const budget = requireRecord(value, 'deep_review.budget', errors);
  if (budget === undefined) return;
  requireKeys(budget, 'deep_review.budget', DEEP_REVIEW_BUDGET_REQUIRED, errors);
  rejectUnknownKeys(budget, 'deep_review.budget', DEEP_REVIEW_BUDGET_KEYS, errors);
  if (Object.hasOwn(budget, 'seconds')) {
    validatePositiveInteger(budget['seconds'], 'deep_review.budget.seconds', errors);
  }
  if (Object.hasOwn(budget, 'tokens') && budget['tokens'] !== null) {
    validatePositiveInteger(budget['tokens'], 'deep_review.budget.tokens', errors);
  }
}

function validateSemantics(root: Record<string, unknown>, errors: ValidationError[]): void {
  const filesetNames = collectDeclaredFilesetNames(root);
  validateTierBudgets(root, errors);
  validateTierCheckSemantics(root, filesetNames, errors);
  validateGroupSemantics(root, errors);
  validateFilesetSemantics(root, errors);
  validateFormatSemantics(root, errors);
  validateWorkspaceUniqueness(root, errors);
}

interface LocatedCheck {
  check: Record<string, unknown>;
  path: string;
  tier: (typeof TIER_NAMES)[number];
  name: string;
  group?: string;
}

function validateGroupSemantics(root: Record<string, unknown>, errors: ValidationError[]): void {
  const tiers = root['tiers'];
  if (!isRecord(tiers)) return;
  const groups = isUnknownArray(root['groups']) ? root['groups'] : [];

  const checks: LocatedCheck[] = [];
  for (const tier of TIER_NAMES) {
    const tierChecks = tiers[tier];
    if (!isUnknownArray(tierChecks)) continue;
    tierChecks.forEach((check, index) => {
      if (!isRecord(check) || typeof check['name'] !== 'string') return;
      const group = check['group'];
      checks.push({
        check,
        path: `tiers.${tier}[${index}]`,
        tier,
        name: check['name'],
        ...(typeof group === 'string' ? { group } : {}),
      });
    });
  }

  reportDuplicateNames(groups, 'groups', 'group-name-unique', 'group', '', errors);
  const declaredGroups = new Set(
    groups.flatMap((group) =>
      isRecord(group) && typeof group['name'] === 'string' ? [group['name']] : [],
    ),
  );

  for (const located of checks) {
    const groupName = located.group;
    if (groupName === undefined || groupName.length === 0) continue;
    if (!declaredGroups.has(groupName)) {
      addError(
        errors,
        `${located.path}.group`,
        'group-reference',
        `check ${JSON.stringify(located.name)} references undeclared group ${JSON.stringify(groupName)}`,
        groupName,
      );
    }
    if (Object.hasOwn(located.check, 'operational_exit_codes')) {
      addError(
        errors,
        `${located.path}.operational_exit_codes`,
        'group-eligibility',
        `check ${JSON.stringify(located.name)} declares operational_exit_codes and cannot join group ${JSON.stringify(groupName)}; a gate with that field is not batchable`,
        located.check['operational_exit_codes'],
      );
    }
    if (Object.hasOwn(located.check, 'skip_if_empty')) {
      addError(
        errors,
        `${located.path}.skip_if_empty`,
        'group-eligibility',
        `check ${JSON.stringify(located.name)} declares skip_if_empty and cannot join group ${JSON.stringify(groupName)}; a gate with that field is not batchable`,
        located.check['skip_if_empty'],
      );
    }
    if (located.check['bypassable'] === true) {
      addError(
        errors,
        `${located.path}.bypassable`,
        'group-eligibility',
        `check ${JSON.stringify(located.name)} sets bypassable true and cannot join group ${JSON.stringify(groupName)}; a bypassable gate is not batchable`,
        true,
      );
    }
    const mode = located.check['mode'];
    if (typeof mode === 'string' && mode !== 'blocking') {
      addError(
        errors,
        `${located.path}.mode`,
        'group-eligibility',
        `check ${JSON.stringify(located.name)} uses mode ${JSON.stringify(mode)} and cannot join group ${JSON.stringify(groupName)}; a non-blocking gate is not batchable`,
        mode,
      );
    }
  }

  groups.forEach((entry, groupIndex) => {
    if (!isRecord(entry)) return;
    validateGroupPathSemantics(entry, groupIndex, errors);
    validateGroupArgvSemantics(entry, groupIndex, errors);
    validateGroupMembership(entry, groupIndex, checks, errors);
  });
}

function validateGroupPathSemantics(
  group: Record<string, unknown>,
  groupIndex: number,
  errors: ValidationError[],
): void {
  const name = group['name'];
  if (typeof name === 'string' && name.length > 0 && !isGroupSegment(name)) {
    addError(
      errors,
      `groups[${groupIndex}].name`,
      'group-path',
      'group name must be a single path segment matching ^[A-Za-z0-9._-]+$ and cannot be "." or ".."',
      name,
    );
  }
  const artifactDir = group['artifact_dir'];
  if (typeof artifactDir === 'string' && artifactDir.length > 0 && !isGroupArtifactDir(artifactDir)) {
    addError(
      errors,
      `groups[${groupIndex}].artifact_dir`,
      'group-path',
      'artifact_dir must be a relative POSIX path whose segments match ^[A-Za-z0-9._-]+$ and are not "." or ".."',
      artifactDir,
    );
  }
}

function isGroupSegment(value: string): boolean {
  return value !== '.' && value !== '..' && GROUP_SEGMENT_PATTERN.test(value);
}

function isGroupArtifactDir(value: string): boolean {
  if (value.startsWith('/') || /^[a-z]:/i.test(value) || value.includes('\\')) return false;
  return value.split('/').every(isGroupSegment);
}

function validateGroupArgvSemantics(
  group: Record<string, unknown>,
  groupIndex: number,
  errors: ValidationError[],
): void {
  const argv = group['argv'];
  if (!isUnknownArray(argv)) return;
  argv.forEach((argument, index) => {
    if (typeof argument === 'string' && GROUP_FILES_TOKEN.test(argument)) {
      addError(
        errors,
        `groups[${groupIndex}].argv[${index}]`,
        'group-argv-token',
        'group argv cannot contain a {files:<fileset>} token because an empty expansion has no attributable result',
        argument,
      );
    }
  });
}

function validateGroupMembership(
  group: Record<string, unknown>,
  groupIndex: number,
  checks: readonly LocatedCheck[],
  errors: ValidationError[],
): void {
  const name = group['name'];
  const members = group['members'];
  if (typeof name !== 'string' || name.length === 0 || !isUnknownArray(members)) return;

  const memberNames = new Set<string>();
  const resultKeys = new Set<string>();
  members.forEach((member, memberIndex) => {
    if (!isRecord(member)) return;
    const checkName = member['check'];
    if (typeof checkName === 'string') {
      if (memberNames.has(checkName)) {
        addError(
          errors,
          `groups[${groupIndex}].members[${memberIndex}].check`,
          'group-membership',
          `duplicate member check ${JSON.stringify(checkName)} in group ${JSON.stringify(name)}`,
          checkName,
        );
      }
      memberNames.add(checkName);
    }
    const resultKey = member['result_key'];
    if (typeof resultKey === 'string') {
      if (resultKeys.has(resultKey)) {
        addError(
          errors,
          `groups[${groupIndex}].members[${memberIndex}].result_key`,
          'group-membership',
          `duplicate result_key ${JSON.stringify(resultKey)} in group ${JSON.stringify(name)}`,
          resultKey,
        );
      }
      resultKeys.add(resultKey);
    }
  });

  const assigned = checks.filter((check) => check.group === name);
  for (const check of assigned) {
    if (!memberNames.has(check.name)) {
      addError(
        errors,
        `${check.path}.group`,
        'group-membership',
        `check ${JSON.stringify(check.name)} names group ${JSON.stringify(name)} but is absent from its members`,
        name,
      );
    }
  }

  let memberTier: LocatedCheck['tier'] | undefined;
  members.forEach((member, memberIndex) => {
    if (!isRecord(member) || typeof member['check'] !== 'string') return;
    const checkName = member['check'];
    const candidates = checks.filter((check) => check.name === checkName);
    const assignedCandidates = candidates.filter((check) => check.group === name);
    const path = `groups[${groupIndex}].members[${memberIndex}].check`;
    if (candidates.length === 0) {
      addError(
        errors,
        path,
        'group-membership',
        `group ${JSON.stringify(name)} member check ${JSON.stringify(checkName)} does not exist`,
        checkName,
      );
      return;
    }
    if (assignedCandidates.length === 0) {
      addError(
        errors,
        path,
        'group-membership',
        `group ${JSON.stringify(name)} member check ${JSON.stringify(checkName)} is not assigned to group ${JSON.stringify(name)}`,
        checkName,
      );
      return;
    }
    const candidateTier = assignedCandidates[0]?.tier;
    if (candidateTier === undefined) return;
    if (memberTier === undefined) {
      memberTier = candidateTier;
    } else if (candidateTier !== memberTier) {
      addError(
        errors,
        path,
        'group-tier',
        `group ${JSON.stringify(name)} spans tiers ${JSON.stringify(memberTier)} and ${JSON.stringify(candidateTier)}; all members must share one tier`,
        checkName,
      );
    }
    const extraTier = assignedCandidates.find((candidate) => candidate.tier !== candidateTier)?.tier;
    if (extraTier !== undefined) {
      addError(
        errors,
        path,
        'group-tier',
        `group ${JSON.stringify(name)} spans tiers ${JSON.stringify(candidateTier)} and ${JSON.stringify(extraTier)}; all members must share one tier`,
        checkName,
      );
    }
  });
}

function validateFormatSemantics(root: Record<string, unknown>, errors: ValidationError[]): void {
  const format = root['format'];
  if (!isRecord(format)) return;
  /* format.argv is the formatter command ONLY; the runner appends the safe staged-file list
     internally. A `{files:<fileset>}` token here is forbidden: an unknown/empty fileset expands to
     zero args, so the internally-appended staged path would slide into argv[0] and be EXECUTED as
     the program instead of formatted (BUG-07). */
  const argv = format['argv'];
  if (isUnknownArray(argv)) {
    argv.forEach((element, index) => {
      if (typeof element === 'string' && FILES_TOKEN.test(element)) {
        addError(
          errors,
          `format.argv[${index}]`,
          'format-argv-token',
          'format.argv must not contain a {files:<fileset>} token; the runner appends the staged file list itself',
          element,
        );
      }
    });
  }
  const filesetName = format['fileset'];
  if (typeof filesetName !== 'string') return; // structural pass already flagged a bad fileset name
  const filesets = root['filesets'];
  if (!isUnknownArray(filesets)) return; // filesets section broken; reference is uncheckable
  const target = filesets.find((entry) => isRecord(entry) && entry['name'] === filesetName);
  if (target === undefined || !isRecord(target)) {
    addError(errors, 'format.fileset', 'format-fileset-reference',
      `format.fileset references undeclared fileset "${filesetName}"`, filesetName);
    return;
  }
  if (target['source'] !== 'git_staged') {
    addError(errors, 'format.fileset', 'format-fileset-source',
      `format.fileset "${filesetName}" must have source "git_staged"`, filesetName);
  }
  const diffFilter = target['diff_filter'];
  if (typeof diffFilter === 'string') {
    const unsafe = [...diffFilter].filter((letter) => !FORMAT_SAFE_FILTER.has(letter));
    if (unsafe.length > 0) {
      addError(errors, 'format.fileset', 'format-fileset-filter',
        `format fileset "${filesetName}" diff_filter must use only A/C/M/R; the formatter cannot ` +
          `run on ${unsafe.join('')} (deleted/type-changed/conflicted) paths`,
        diffFilter);
    }
  }
}

function collectDeclaredFilesetNames(
  root: Record<string, unknown>,
): ReadonlySet<string> | undefined {
  const filesets = root['filesets'];
  if (!isUnknownArray(filesets)) return undefined;
  const names = new Set<string>();
  for (const fileset of filesets) {
    if (!isRecord(fileset)) continue;
    const name = fileset['name'];
    if (typeof name === 'string') names.add(name);
  }
  return names;
}

// report-only checks still consume the tier's wall-clock budget.
function validateTierBudgets(root: Record<string, unknown>, errors: ValidationError[]): void {
  const budgets = root['budgets'];
  const tiers = root['tiers'];
  if (!isRecord(budgets) || !isRecord(tiers)) return;
  for (const tier of TIER_NAMES) {
    const budget = budgets[`${tier}_seconds`];
    const checks = tiers[tier];
    if (!isPositiveInteger(budget) || !isUnknownArray(checks)) continue;
    const timeouts = checks.map((check) => (isRecord(check) ? check['timeout_seconds'] : undefined));
    if (!timeouts.every(isPositiveInteger)) continue; // broken checks already failed structurally
    const total = timeouts.reduce((sum, timeout) => sum + timeout, 0);
    if (total > budget) {
      addError(
        errors,
        `tiers.${tier}`,
        'tier-budget',
        `sum of timeout_seconds across all checks is ${total}, exceeding budgets.${tier}_seconds (${budget})`,
        total,
      );
    }
  }
}

function validateTierCheckSemantics(
  root: Record<string, unknown>,
  filesetNames: ReadonlySet<string> | undefined,
  errors: ValidationError[],
): void {
  const tiers = root['tiers'];
  if (!isRecord(tiers)) return;
  for (const tier of TIER_NAMES) {
    const checks = tiers[tier];
    if (!isUnknownArray(checks)) continue;
    reportDuplicateNames(checks, `tiers.${tier}`, 'check-name-unique', 'check', ` in tier "${tier}"`, errors);
    checks.forEach((check, index) => {
      if (!isRecord(check)) return;
      validateCheckSemantics(check, `tiers.${tier}[${index}]`, filesetNames, errors);
    });
  }
}

function validateCheckSemantics(
  check: Record<string, unknown>,
  checkPath: string,
  filesetNames: ReadonlySet<string> | undefined,
  errors: ValidationError[],
): void {
  validateArgvFileTokens(check['argv'], `${checkPath}.argv`, filesetNames, errors);
  const skipIfEmpty = check['skip_if_empty'];
  if (typeof skipIfEmpty === 'string' && filesetNames !== undefined && !filesetNames.has(skipIfEmpty)) {
    addError(
      errors,
      `${checkPath}.skip_if_empty`,
      'skip-if-empty-reference',
      `skip_if_empty references undeclared fileset "${skipIfEmpty}"`,
      skipIfEmpty,
    );
  }
}

function validateArgvFileTokens(
  argv: unknown,
  argvPath: string,
  filesetNames: ReadonlySet<string> | undefined,
  errors: ValidationError[],
): void {
  if (!isUnknownArray(argv)) return; // non-array argv already failed structurally
  const tokens: Array<{ index: number; filesetName: string }> = [];
  argv.forEach((element, index) => {
    if (typeof element !== 'string') return;
    const filesetName = FILES_TOKEN.exec(element)?.[1];
    if (filesetName !== undefined) tokens.push({ index, filesetName });
  });
  if (tokens.length > 1) {
    addError(
      errors,
      argvPath,
      'files-token-count',
      `argv may contain at most one {files:<fileset>} token, found ${tokens.length}`,
      argv,
    );
  }
  if (tokens[0]?.index === 0) {
    addError(
      errors,
      `${argvPath}[0]`,
      'files-token-position',
      'argv[0] must be the executable; a {files:<fileset>} token cannot come first',
      argv[0],
    );
  }
  if (filesetNames === undefined) return; // filesets section broken; references are uncheckable
  for (const token of tokens) {
    if (!filesetNames.has(token.filesetName)) {
      addError(
        errors,
        `${argvPath}[${token.index}]`,
        'files-token-reference',
        `{files:${token.filesetName}} references undeclared fileset "${token.filesetName}"`,
        argv[token.index],
      );
    }
  }
}

function validateFilesetSemantics(root: Record<string, unknown>, errors: ValidationError[]): void {
  const filesets = root['filesets'];
  if (!isUnknownArray(filesets)) return;
  reportDuplicateNames(filesets, 'filesets', 'fileset-name-unique', 'fileset', '', errors);
  filesets.forEach((fileset, index) => {
    if (!isRecord(fileset)) return;
    const filesetPath = `filesets[${index}]`;
    validateGlobDialect(fileset['include'], `${filesetPath}.include`, errors);
    validateGlobDialect(fileset['exclude'], `${filesetPath}.exclude`, errors);
    validateDiffFilterScope(fileset, filesetPath, errors);
  });
}

function validateGlobDialect(patterns: unknown, path: string, errors: ValidationError[]): void {
  if (!isUnknownArray(patterns)) return; // absent, or already failed structurally
  patterns.forEach((pattern, index) => {
    if (typeof pattern !== 'string') return;
    if (UNSUPPORTED_GLOB_SYNTAX.test(pattern)) {
      addError(
        errors,
        `${path}[${index}]`,
        'glob-dialect',
        'pattern uses unsupported glob syntax ("?", "[", or "{"); the restricted dialect allows "**", "*", and literal segments',
        pattern,
      );
    }
    // A `**` must be a WHOLE path segment. An embedded double-star (like "a**b" or "src**.ts") is
    // ambiguous across the three matchers — the runner treated it as a globstar crossing "/", the
    // policy tools as a within-segment "*". Rejecting the mixed form keeps runner/src/glob.ts and
    // tools/*.mjs in exact agreement: `**` valid only as a whole segment.
    if (pattern.split('/').some((segment) => segment !== '**' && segment.includes('**'))) {
      addError(
        errors,
        `${path}[${index}]`,
        'glob-globstar-segment',
        'a "**" globstar must be a whole path segment; an embedded double-star (e.g. "a**b") is not allowed',
        pattern,
      );
    }
  });
}

// diff_filter belongs only to git_staged; invalid source values already failed structurally.
function validateDiffFilterScope(
  fileset: Record<string, unknown>,
  filesetPath: string,
  errors: ValidationError[],
): void {
  if (Object.hasOwn(fileset, 'diff_filter') && fileset['source'] === 'repo_all') {
    addError(
      errors,
      `${filesetPath}.diff_filter`,
      'diff-filter-scope',
      'diff_filter applies only to filesets with source "git_staged"',
      fileset['diff_filter'],
    );
  }
}

function validateWorkspaceUniqueness(root: Record<string, unknown>, errors: ValidationError[]): void {
  const workspaces = root['workspaces'];
  if (!isUnknownArray(workspaces)) return;
  reportDuplicateNames(workspaces, 'workspaces', 'workspace-name-unique', 'workspace', '', errors);
}

function reportDuplicateNames(
  entries: readonly unknown[],
  basePath: string,
  rule: UniquenessRule,
  label: string,
  context: string,
  errors: ValidationError[],
): void {
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    if (!isRecord(entry)) return;
    const name = entry['name'];
    if (typeof name !== 'string') return;
    if (seen.has(name)) {
      addError(
        errors,
        `${basePath}[${index}].name`,
        rule,
        `duplicate ${label} name ${JSON.stringify(name)}${context}`,
        name,
      );
    }
    seen.add(name);
  });
}

export function validate(value: unknown): ValidationResult {
  const errors: ValidationError[] = [];
  if (!isRecord(value)) {
    addError(errors, '', 'type', `manifest must be a plain JSON object, got ${describeValue(value)}`, value);
    return { ok: false, errors };
  }
  validateStructure(value, errors);
  validateSemantics(value, errors);
  return { ok: errors.length === 0, errors };
}

export function isManifest(value: unknown): value is Manifest {
  return validate(value).ok;
}
