import { spawnSync } from 'node:child_process';

export const REQUIRED_CMUX_VERBS = [
  'new_section',
  'split_run',
  'notify',
  'close_section',
] as const;

export type CmuxVerb = (typeof REQUIRED_CMUX_VERBS)[number];
export type PaneAgent = 'claude' | 'codex' | 'helper';

export interface PaneSpec {
  pane_id: string;
  cwd: string;
  agent: PaneAgent;
  command: string[];
}

export interface CmuxSectionSpec {
  section: string;
  worktree: string;
  panes: PaneSpec[];
}

export interface CmuxSpawnOptions {
  shell: false;
  encoding: 'utf8';
  timeout: number;
}

export interface CmuxSpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error & { code?: string };
}

export type CmuxSpawn = (
  file: string,
  args: string[],
  options: CmuxSpawnOptions,
) => CmuxSpawnResult;

export interface CmuxCapabilities {
  present: boolean;
  version: string;
  verbs: readonly string[];
  missing: readonly CmuxVerb[];
  detail: string;
}

export interface CmuxAction {
  verb: CmuxVerb;
  args: string[];
}

export interface CmuxPlan {
  ready: boolean;
  capabilities: CmuxCapabilities;
  actions: CmuxAction[];
  instructions: string;
}

export interface CmuxLaunchResult {
  ok: boolean;
  paneIds: string[];
  instructions: string;
  error?: string;
}

export interface CmuxNotifyResult {
  ok: boolean;
  error?: string;
}

export interface CmuxAdapter {
  capabilities: () => CmuxCapabilities;
  plan: (spec: CmuxSectionSpec) => CmuxPlan;
  launch: (spec: CmuxSectionSpec) => CmuxLaunchResult;
  notify: (section: string, message: string) => CmuxNotifyResult;
}

interface CmuxAdapterDeps {
  binary?: string;
  spawn?: CmuxSpawn;
  timeoutMs?: number;
}

interface RawCapabilities {
  version?: unknown;
  verbs?: unknown;
}

const DEFAULT_BINARY = 'cmux';
const DEFAULT_TIMEOUT_MS = 10_000;

export function createCmuxAdapter(deps: CmuxAdapterDeps = {}): CmuxAdapter {
  const binary = deps.binary ?? DEFAULT_BINARY;
  const spawn = deps.spawn ?? realSpawn;
  const spawnOptions: CmuxSpawnOptions = {
    encoding: 'utf8',
    shell: false,
    timeout: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  const probed = probe(binary, spawn, spawnOptions);

  const capabilities = (): CmuxCapabilities => probed;

  const plan = (spec: CmuxSectionSpec): CmuxPlan => {
    assertSafePositionals(spec);
    assertPaneCwds(spec);
    if (!isReady(probed)) {
      return {
        ready: false,
        capabilities: probed,
        actions: [],
        instructions: copyPasteInstructions(spec, probed),
      };
    }
    return {
      ready: true,
      capabilities: probed,
      actions: plannedActions(spec),
      instructions: copyPasteInstructions(spec, probed),
    };
  };

  const launch = (spec: CmuxSectionSpec): CmuxLaunchResult => {
    const dryRun = plan(spec);
    if (!dryRun.ready) {
      return {
        ok: false,
        paneIds: [],
        instructions: dryRun.instructions,
      };
    }
    let sectionCreated = false;
    for (const action of dryRun.actions) {
      const result = runCmux(binary, action.args, spawn, spawnOptions);
      if (isFailure(result)) {
        let error = resultDetail(result);
        if (sectionCreated) {
          const rollback = runCmux(binary, ['close_section', spec.section], spawn, spawnOptions);
          if (isFailure(rollback)) {
            error = `${error}; rollback close_section failed: ${resultDetail(rollback)}`;
          }
        }
        return {
          ok: false,
          paneIds: [],
          instructions: dryRun.instructions,
          error,
        };
      }
      if (action.verb === 'new_section') sectionCreated = true;
    }
    return {
      ok: true,
      paneIds: spec.panes.map((pane) => pane.pane_id),
      instructions: '',
    };
  };

  const notify = (section: string, message: string): CmuxNotifyResult => {
    if (!isReady(probed)) return { ok: false, error: probed.detail };
    const sectionError = unsafePositionalDetail('section', section);
    if (sectionError !== undefined) return { ok: false, error: sectionError };
    const messageError = unsafePositionalDetail('message', message);
    if (messageError !== undefined) return { ok: false, error: messageError };
    const result = runCmux(binary, ['notify', section, message], spawn, spawnOptions);
    if (isFailure(result)) return { ok: false, error: resultDetail(result) };
    return { ok: true };
  };

  return { capabilities, plan, launch, notify };
}

export function probeCmux(): { ok: boolean; detail: string } {
  const caps = createCmuxAdapter().capabilities();
  if (isReady(caps)) {
    return { ok: true, detail: `cmux ${caps.version} supports ${REQUIRED_CMUX_VERBS.join(', ')}` };
  }
  return { ok: false, detail: caps.detail };
}

function realSpawn(file: string, args: string[], options: CmuxSpawnOptions): CmuxSpawnResult {
  const result = spawnSync(file, args, options);
  const mapped: CmuxSpawnResult = {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
  if (result.error !== undefined) mapped.error = result.error as Error & { code?: string };
  return mapped;
}

function runCmux(
  binary: string,
  args: string[],
  spawn: CmuxSpawn,
  options: CmuxSpawnOptions,
): CmuxSpawnResult {
  try {
    return spawn(binary, args, options);
  } catch (error) {
    return {
      status: null,
      stdout: '',
      stderr: '',
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

function probe(binary: string, spawn: CmuxSpawn, options: CmuxSpawnOptions): CmuxCapabilities {
  const result = runCmux(binary, ['capabilities', '--json'], spawn, options);
  if (result.error !== undefined) {
    const missingBinary = result.error.code === 'ENOENT';
    return absent(missingBinary ? 'cmux not found on PATH' : `cmux probe failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    return absent(resultDetail(result) || 'cmux capabilities probe returned a non-zero status');
  }
  try {
    const parsed = JSON.parse(result.stdout) as RawCapabilities;
    const verbs = Array.isArray(parsed.verbs)
      ? parsed.verbs.filter((verb): verb is string => typeof verb === 'string')
      : [];
    const version = typeof parsed.version === 'string' && parsed.version.length > 0
      ? parsed.version
      : 'unknown';
    const missing = missingVerbs(verbs);
    return {
      present: true,
      version,
      verbs,
      missing,
      detail: missing.length === 0
        ? `cmux ${version} available`
        : `cmux ${version} missing required verb(s): ${missing.join(', ')}`,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return absent(`cmux capabilities JSON could not be parsed: ${detail}`);
  }
}

function absent(detail: string): CmuxCapabilities {
  return {
    present: false,
    version: '',
    verbs: [],
    missing: REQUIRED_CMUX_VERBS,
    detail,
  };
}

function missingVerbs(verbs: readonly string[]): CmuxVerb[] {
  const available = new Set(verbs);
  return REQUIRED_CMUX_VERBS.filter((verb) => !available.has(verb));
}

function isReady(caps: CmuxCapabilities): boolean {
  return caps.present && caps.missing.length === 0;
}

function assertPaneCwds(spec: CmuxSectionSpec): void {
  for (const pane of spec.panes) {
    if (pane.cwd !== spec.worktree) {
      throw new Error(
        `pane "${pane.pane_id}" cwd "${pane.cwd}" does not match front-matter worktree "${spec.worktree}"`,
      );
    }
  }
}

function assertSafePositionals(spec: CmuxSectionSpec): void {
  assertSafePositional('section', spec.section);
  for (const pane of spec.panes) {
    assertSafePositional('pane_id', pane.pane_id);
  }
}

function assertSafePositional(label: string, value: string): void {
  const detail = unsafePositionalDetail(label, value);
  if (detail !== undefined) throw new Error(detail);
}

function unsafePositionalDetail(label: string, value: string): string | undefined {
  if (value.length === 0) return `unsafe cmux ${label}: empty value`;
  if (value.startsWith('-')) return `unsafe cmux ${label}: value must not start with "-"`;
  if (/[\x00-\x1f\x7f]/.test(value)) return `unsafe cmux ${label}: value contains a control character`;
  return undefined;
}

function plannedActions(spec: CmuxSectionSpec): CmuxAction[] {
  return [
    {
      verb: 'new_section',
      args: ['new_section', spec.section, '--cwd', spec.worktree],
    },
    ...spec.panes.map((pane): CmuxAction => ({
      verb: 'split_run',
      args: [
        'split_run',
        spec.section,
        pane.pane_id,
        '--cwd',
        pane.cwd,
        '--agent',
        pane.agent,
        '--',
        ...pane.command,
      ],
    })),
    {
      verb: 'notify',
      args: ['notify', spec.section, 'workflow panes armed'],
    },
  ];
}

function copyPasteInstructions(spec: CmuxSectionSpec, caps: CmuxCapabilities): string {
  const reason = isReady(caps)
    ? 'cmux is available; dry-run copy-paste fallback'
    : `cmux unavailable for arming (${caps.detail})`;
  const lines = [
    reason,
    'copy-paste these commands into separate panes:',
    ...spec.panes.map((pane) => `[${pane.pane_id}] cwd=${pane.cwd} argv=${JSON.stringify(pane.command)}`),
  ];
  return `${lines.join('\n')}\n`;
}

function isFailure(result: CmuxSpawnResult): boolean {
  return result.error !== undefined || result.status !== 0;
}

function resultDetail(result: CmuxSpawnResult): string {
  if (result.error !== undefined) return result.error.message;
  return result.stderr.trim() || result.stdout.trim() || `cmux exited with status ${result.status}`;
}
