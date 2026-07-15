/* Parses a Claude Code session transcript (the JSONL rollout under
   ~/.claude/projects/<hash>/<session>.jsonl) into the two model-independent signals the
   guides-read gate needs. `attributionSkill` is stamped by the HARNESS on assistant
   lines while a skill is active, so it is trustworthy where a model self-report would
   not be; read-proof is a `Read` tool_use correlated to a non-error, non-denied
   tool_result. Every line is parsed defensively and the module NEVER throws: a
   truncated/corrupt transcript is a realistic input, and the caller — not a parser
   crash — owns the fail-open vs fail-closed decision. */

/* One recovered Read attempt. `ok` is the read-PROOF bit: a matching tool_result
   exists, did not error, and was not denied. A read with NO matching result
   (interrupted, still in flight) stays ok=false so the gate treats "started but never
   finished" the same as "never read". */
export interface TranscriptReadEvent {
  path: string;
  ok: boolean;
}

export interface ParsedTranscript {
  /* Every distinct `attributionSkill` value seen; the gate tests membership of its own
     skill id. A Set (not a boolean) keeps the parser independent of any one skill. */
  attributionSkills: Set<string>;
  reads: TranscriptReadEvent[];
}

const READ_TOOL_NAME = 'Read';

interface ToolResultOutcome {
  isError: boolean;
  denied: boolean;
}

function parseLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (trimmed === '') return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (isRecord(value)) return value;
  } catch {
    /* Truncated/malformed lines are expected on a live or interrupted transcript. */
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/* The content array of a line's `message`, or undefined when the line carries no
   structured content (a string-content prompt, a system event). */
function messageContent(line: Record<string, unknown>): unknown[] | undefined {
  const message = line.message;
  if (!isRecord(message)) return undefined;
  const content = message.content;
  return Array.isArray(content) ? content : undefined;
}

export function parseTranscript(text: string): ParsedTranscript {
  const attributionSkills = new Set<string>();
  const readPathById = new Map<string, string>();
  const outcomeById = new Map<string, ToolResultOutcome>();

  for (const rawLine of text.split('\n')) {
    const line = parseLine(rawLine);
    if (line === undefined) continue;

    if (typeof line.attributionSkill === 'string') attributionSkills.add(line.attributionSkill);

    const content = messageContent(line);
    if (content === undefined) continue;

    /* A denied line (top-level toolDenialKind) taints every tool_result it carries,
       independent of is_error, so a future harness stamping is_error=false on a
       user-rejected call still cannot count as read-proof. */
    const lineIsDenied = typeof line.toolDenialKind === 'string' && line.toolDenialKind !== '';
    for (const item of content) {
      if (!isRecord(item)) continue;
      if (item.type === 'tool_use' && item.name === READ_TOOL_NAME) {
        const input = item.input;
        const filePath = isRecord(input) ? input.file_path : undefined;
        if (typeof item.id === 'string' && typeof filePath === 'string' && filePath !== '') {
          readPathById.set(item.id, filePath);
        }
        continue;
      }
      if (item.type === 'tool_result' && typeof item.tool_use_id === 'string') {
        outcomeById.set(item.tool_use_id, { isError: item.is_error === true, denied: lineIsDenied });
      }
    }
  }

  const reads: TranscriptReadEvent[] = [];
  for (const [id, path] of readPathById) {
    const outcome = outcomeById.get(id);
    reads.push({ path, ok: outcome !== undefined && !outcome.isError && !outcome.denied });
  }
  return { attributionSkills, reads };
}
