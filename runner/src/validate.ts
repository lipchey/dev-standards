import type { Manifest, ValidationError, ValidationResult } from './types.ts';

/**
 * Hand-written manifest validator (design spec §6). Pure and dependency-free:
 * it takes an `unknown` value and returns every violation it can find.
 *
 * Two passes:
 *
 * 1. Structural — mirrors schemas/quality.schema.json exactly (required keys,
 *    closed objects, types, enums, minLength/minItems). The one schema keyword
 *    intentionally not mirrored is the `diff_filter` content pattern
 *    (`^[ACDMRTUXB]+$`): the frozen rule vocabulary has no `pattern` rule, so
 *    in Phase 1a that constraint is schema-only. Only the field's placement is
 *    checked here (semantic rule `diff-filter-scope`).
 * 2. Semantic — cross-field rules the schema cannot express (tier budget sums,
 *    `{files:<fileset>}` token shape and references, name uniqueness, the
 *    restricted glob dialect, diff_filter placement, and the Phase 1a
 *    workflow-enabled gate). Each semantic walk re-narrows from `unknown` and
 *    skips structurally broken sections — their structural errors are already
 *    reported — so the pass never throws on malformed input.
 *
 * Error paths are dotted + indexed (`tiers.fast[0].argv[1]`), top-level keys
 * are bare (`stack`), and the root itself is the empty string.
 */

type RuleName =
  // Structural rules. (`json-parse` is reserved for the manifest loader.)
  | 'required'
  | 'type'
  | 'enum'
  | 'additional-property'
  | 'min-length'
  | 'min-items'
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
  | 'diff-filter-scope'
  | 'workflow-enabled';

type UniquenessRule = 'fileset-name-unique' | 'check-name-unique' | 'workspace-name-unique';

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
const TOP_LEVEL_ALLOWED = [...TOP_LEVEL_REQUIRED, 'workflow'] as const;

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
const CHECK_ALLOWED = [...CHECK_REQUIRED, 'skip_if_empty', 'mode', 'baseline', 'bypassable'] as const;
const REQUIRED_TIERS = ['staged', 'fast', 'full'] as const;
const TIER_NAMES = ['staged', 'fast', 'full', 'audit'] as const;
const WORKFLOW_KEYS = ['enabled'] as const;

/** Exactly one argv element of this whole shape is a fileset token; anything else is a literal. */
const FILES_TOKEN = /^\{files:([A-Za-z0-9_-]+)\}$/;
/** The restricted dialect allows `**`, `*`, and literal segments — never `?`, `[...]`, `{...}`. */
const UNSUPPORTED_GLOB_SYNTAX = /[?\[{]/;

// ---------------------------------------------------------------------------
// Error collection
// ---------------------------------------------------------------------------

/**
 * The single error builder. The optional rest slot makes "value supplied"
 * explicit: missing-key errors have nothing to attach, every other call site
 * passes the offending value through.
 */
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

// ---------------------------------------------------------------------------
// Narrowing and formatting
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** Short human description of a found value, for "expected X, got Y" messages. */
function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (isUnknownArray(value)) return 'an array';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'object':
      return 'an object';
    default:
      return String(value);
  }
}

function childPath(parentPath: string, key: string): string {
  return parentPath === '' ? key : `${parentPath}.${key}`;
}

// ---------------------------------------------------------------------------
// Structural primitives — each mirrors one JSON-Schema keyword
// ---------------------------------------------------------------------------

/** `type: object`. Returns the record on success, undefined after reporting. */
function requireRecord(
  value: unknown,
  path: string,
  errors: ValidationError[],
): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  addError(errors, path, 'type', `must be an object, got ${describeValue(value)}`, value);
  return undefined;
}

/** `required` — reports the missing key's full path. */
function requireKeys(
  record: Record<string, unknown>,
  parentPath: string,
  keys: readonly string[],
  errors: ValidationError[],
): void {
  for (const key of keys) {
    if (!(key in record)) {
      addError(errors, childPath(parentPath, key), 'required', `missing required key "${key}"`);
    }
  }
}

/** `additionalProperties: false`. */
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

/** `type: string` with `minLength: 1`. */
function validateNonEmptyString(value: unknown, path: string, errors: ValidationError[]): void {
  if (typeof value !== 'string') {
    addError(errors, path, 'type', `must be a string, got ${describeValue(value)}`, value);
  } else if (value.length === 0) {
    addError(errors, path, 'min-length', 'must be a non-empty string', value);
  }
}

/** Plain `type: string` (no minLength — the empty string is structurally valid). */
function validateString(value: unknown, path: string, errors: ValidationError[]): void {
  if (typeof value !== 'string') {
    addError(errors, path, 'type', `must be a string, got ${describeValue(value)}`, value);
  }
}

/** `type: boolean`. */
function validateBoolean(value: unknown, path: string, errors: ValidationError[]): void {
  if (typeof value !== 'boolean') {
    addError(errors, path, 'type', `must be a boolean, got ${describeValue(value)}`, value);
  }
}

/** `type: integer` with `exclusiveMinimum: 0` (one `type` violation either way). */
function validatePositiveInteger(value: unknown, path: string, errors: ValidationError[]): void {
  if (!isPositiveInteger(value)) {
    addError(errors, path, 'type', `must be a positive integer, got ${describeValue(value)}`, value);
  }
}

/** `enum` — any non-member value (including non-strings) is one `enum` violation. */
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

/** `type: array` of strings with optional `minItems: 1`. */
function validateStringArray(
  value: unknown,
  path: string,
  minItems: 0 | 1,
  errors: ValidationError[],
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
    }
  });
}

// ---------------------------------------------------------------------------
// Structural pass — mirrors schemas/quality.schema.json
// ---------------------------------------------------------------------------

function validateStructure(root: Record<string, unknown>, errors: ValidationError[]): void {
  requireKeys(root, '', TOP_LEVEL_REQUIRED, errors);
  rejectUnknownKeys(root, '', TOP_LEVEL_ALLOWED, errors);
  if ('version' in root) validateVersion(root['version'], errors);
  if ('repo' in root) validateNonEmptyString(root['repo'], 'repo', errors);
  if ('stack' in root) validateEnum(root['stack'], 'stack', STACKS, errors);
  if ('scheduler_class' in root) {
    validateEnum(root['scheduler_class'], 'scheduler_class', SCHEDULER_CLASSES, errors);
  }
  if ('budgets' in root) validateBudgets(root['budgets'], errors);
  if ('policy' in root) validatePolicy(root['policy'], errors);
  if ('paths' in root) validatePaths(root['paths'], errors);
  if ('generated' in root) validateGenerated(root['generated'], errors);
  if ('workspaces' in root) validateWorkspaces(root['workspaces'], errors);
  if ('filesets' in root) validateFilesets(root['filesets'], errors);
  if ('tiers' in root) validateTiers(root['tiers'], errors);
  if ('workflow' in root) validateWorkflow(root['workflow'], errors);
}

/** `const: 1` — a single-value enum. */
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
    if (key in budgets) validatePositiveInteger(budgets[key], `budgets.${key}`, errors);
  }
}

function validatePolicy(value: unknown, errors: ValidationError[]): void {
  const policy = requireRecord(value, 'policy', errors);
  if (policy === undefined) return;
  requireKeys(policy, 'policy', POLICY_KEYS, errors);
  rejectUnknownKeys(policy, 'policy', POLICY_KEYS, errors);
  for (const key of POLICY_KEYS) {
    if (key in policy) validateBoolean(policy[key], `policy.${key}`, errors);
  }
}

function validatePaths(value: unknown, errors: ValidationError[]): void {
  const paths = requireRecord(value, 'paths', errors);
  if (paths === undefined) return;
  requireKeys(paths, 'paths', PATH_KEYS, errors);
  rejectUnknownKeys(paths, 'paths', PATH_KEYS, errors);
  for (const key of PATH_KEYS) {
    if (key in paths) validateNonEmptyString(paths[key], `paths.${key}`, errors);
  }
}

function validateGenerated(value: unknown, errors: ValidationError[]): void {
  const generated = requireRecord(value, 'generated', errors);
  if (generated === undefined) return;
  requireKeys(generated, 'generated', ['hooks_dir'], errors);
  rejectUnknownKeys(generated, 'generated', ['hooks_dir', 'ci_quality'], errors);
  if ('hooks_dir' in generated) {
    validateNonEmptyString(generated['hooks_dir'], 'generated.hooks_dir', errors);
  }
  if ('ci_quality' in generated) {
    validateString(generated['ci_quality'], 'generated.ci_quality', errors);
  }
}

function validateWorkspaces(value: unknown, errors: ValidationError[]): void {
  if (!isUnknownArray(value)) {
    addError(errors, 'workspaces', 'type', `must be an array, got ${describeValue(value)}`, value);
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
  if ('name' in workspace) validateNonEmptyString(workspace['name'], `${path}.name`, errors);
  if ('path' in workspace) validateNonEmptyString(workspace['path'], `${path}.path`, errors);
  if ('stack' in workspace) validateEnum(workspace['stack'], `${path}.stack`, STACKS, errors);
  if ('package_manager' in workspace) {
    validateEnum(workspace['package_manager'], `${path}.package_manager`, PACKAGE_MANAGERS, errors);
  }
}

/** `filesets` has no minItems — an empty array is a valid (if useless) declaration. */
function validateFilesets(value: unknown, errors: ValidationError[]): void {
  if (!isUnknownArray(value)) {
    addError(errors, 'filesets', 'type', `must be an array, got ${describeValue(value)}`, value);
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
  if ('name' in fileset) validateNonEmptyString(fileset['name'], `${path}.name`, errors);
  if ('source' in fileset) validateEnum(fileset['source'], `${path}.source`, FILESET_SOURCES, errors);
  if ('include' in fileset) validateStringArray(fileset['include'], `${path}.include`, 1, errors);
  if ('exclude' in fileset) validateStringArray(fileset['exclude'], `${path}.exclude`, 0, errors);
  if ('diff_filter' in fileset) validateString(fileset['diff_filter'], `${path}.diff_filter`, errors);
}

function validateTiers(value: unknown, errors: ValidationError[]): void {
  const tiers = requireRecord(value, 'tiers', errors);
  if (tiers === undefined) return;
  requireKeys(tiers, 'tiers', REQUIRED_TIERS, errors);
  rejectUnknownKeys(tiers, 'tiers', TIER_NAMES, errors);
  for (const tier of TIER_NAMES) {
    if (tier in tiers) validateCheckArray(tiers[tier], `tiers.${tier}`, errors);
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
  if ('name' in check) validateNonEmptyString(check['name'], `${path}.name`, errors);
  if ('argv' in check) validateStringArray(check['argv'], `${path}.argv`, 1, errors);
  if ('timeout_seconds' in check) {
    validatePositiveInteger(check['timeout_seconds'], `${path}.timeout_seconds`, errors);
  }
  if ('skip_if_empty' in check) validateString(check['skip_if_empty'], `${path}.skip_if_empty`, errors);
  if ('mode' in check) validateEnum(check['mode'], `${path}.mode`, CHECK_MODES, errors);
  if ('baseline' in check) validateString(check['baseline'], `${path}.baseline`, errors);
  if ('bypassable' in check) validateBoolean(check['bypassable'], `${path}.bypassable`, errors);
}

function validateWorkflow(value: unknown, errors: ValidationError[]): void {
  const workflow = requireRecord(value, 'workflow', errors);
  if (workflow === undefined) return;
  requireKeys(workflow, 'workflow', WORKFLOW_KEYS, errors);
  rejectUnknownKeys(workflow, 'workflow', WORKFLOW_KEYS, errors);
  if (!('enabled' in workflow)) return;
  const enabled = workflow['enabled'];
  // `true` is left to the semantic workflow-enabled gate so it yields exactly
  // one clear error; any other non-`false` value breaks the `const: false`.
  if (enabled !== false && enabled !== true) {
    addError(errors, 'workflow.enabled', 'enum', `must be false, got ${describeValue(enabled)}`, enabled);
  }
}

// ---------------------------------------------------------------------------
// Semantic pass — cross-field rules the schema cannot express (spec §6).
// Every walk re-guards its slice of the tree, so sections that failed the
// structural pass are skipped here instead of crashing the traversal.
// ---------------------------------------------------------------------------

function validateSemantics(root: Record<string, unknown>, errors: ValidationError[]): void {
  const filesetNames = collectDeclaredFilesetNames(root);
  validateTierBudgets(root, errors);
  validateTierCheckSemantics(root, filesetNames, errors);
  validateFilesetSemantics(root, errors);
  validateWorkspaceUniqueness(root, errors);
  validateWorkflowGate(root, errors);
}

/** Declared fileset names; undefined when `filesets` itself is structurally broken. */
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

/** `tier-budget` — report-only checks count too: the budget is wall-clock time. */
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
    reportDuplicateNames(checks, `tiers.${tier}`, 'check-name-unique', `check in tier "${tier}"`, errors);
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
  reportDuplicateNames(filesets, 'filesets', 'fileset-name-unique', 'fileset', errors);
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
  });
}

/**
 * `diff-filter-scope` — `diff_filter` belongs to git_staged filesets only
 * (its absence there is fine: callers default to ACMR). An invalid `source`
 * already failed structurally, so only a definite `repo_all` is flagged.
 */
function validateDiffFilterScope(
  fileset: Record<string, unknown>,
  filesetPath: string,
  errors: ValidationError[],
): void {
  if ('diff_filter' in fileset && fileset['source'] === 'repo_all') {
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
  reportDuplicateNames(workspaces, 'workspaces', 'workspace-name-unique', 'workspace', errors);
}

/** Flags every entry whose string `name` repeats an earlier one. */
function reportDuplicateNames(
  entries: readonly unknown[],
  basePath: string,
  rule: UniquenessRule,
  label: string,
  errors: ValidationError[],
): void {
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    if (!isRecord(entry)) return;
    const name = entry['name'];
    if (typeof name !== 'string') return;
    if (seen.has(name)) {
      addError(errors, `${basePath}[${index}].name`, rule, `duplicate ${label} name ${JSON.stringify(name)}`, name);
    }
    seen.add(name);
  });
}

/** `workflow-enabled` — the Phase 1a gate on the semi-automatic workflow layer. */
function validateWorkflowGate(root: Record<string, unknown>, errors: ValidationError[]): void {
  const workflow = root['workflow'];
  if (!isRecord(workflow)) return;
  if (workflow['enabled'] === true) {
    addError(
      errors,
      'workflow.enabled',
      'workflow-enabled',
      'workflow.enabled is true, but full workflow validation is not implemented yet; omit workflow or set enabled to false',
      true,
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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
