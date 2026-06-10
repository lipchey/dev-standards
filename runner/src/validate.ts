import type { Manifest, ValidationError, ValidationResult } from './types.ts';

/**
 * Hand validator for quality manifests. Structural checks mirror the schema
 * except diff_filter's pattern (schema-only in Phase 1a); semantic checks cover
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

const FILES_TOKEN = /^\{files:([A-Za-z0-9_-]+)\}$/;
// The schema dialect allows only `*`, `**`, and literals.
const UNSUPPORTED_GLOB_SYNTAX = /[?\[{]/;

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
    case 'object':
      return 'an object';
    default:
      return String(value);
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
  if (Object.hasOwn(root, 'workflow')) validateWorkflow(root['workflow'], errors);
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
  if (Object.hasOwn(fileset, 'name')) validateNonEmptyString(fileset['name'], `${path}.name`, errors);
  if (Object.hasOwn(fileset, 'source')) validateEnum(fileset['source'], `${path}.source`, FILESET_SOURCES, errors);
  if (Object.hasOwn(fileset, 'include')) validateStringArray(fileset['include'], `${path}.include`, 1, errors);
  if (Object.hasOwn(fileset, 'exclude')) validateStringArray(fileset['exclude'], `${path}.exclude`, 0, errors);
  if (Object.hasOwn(fileset, 'diff_filter')) validateString(fileset['diff_filter'], `${path}.diff_filter`, errors);
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
}

function validateWorkflow(value: unknown, errors: ValidationError[]): void {
  const workflow = requireRecord(value, 'workflow', errors);
  if (workflow === undefined) return;
  requireKeys(workflow, 'workflow', WORKFLOW_KEYS, errors);
  rejectUnknownKeys(workflow, 'workflow', WORKFLOW_KEYS, errors);
  if (!Object.hasOwn(workflow, 'enabled')) return;
  const enabled = workflow['enabled'];
  // true gets the semantic workflow-enabled error; other values fail const:false here.
  if (enabled !== false && enabled !== true) {
    addError(errors, 'workflow.enabled', 'enum', `must be false, got ${describeValue(enabled)}`, enabled);
  }
}

function validateSemantics(root: Record<string, unknown>, errors: ValidationError[]): void {
  const filesetNames = collectDeclaredFilesetNames(root);
  validateTierBudgets(root, errors);
  validateTierCheckSemantics(root, filesetNames, errors);
  validateFilesetSemantics(root, errors);
  validateWorkspaceUniqueness(root, errors);
  validateWorkflowGate(root, errors);
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

// Phase 1a gate on the semi-automatic workflow layer.
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
