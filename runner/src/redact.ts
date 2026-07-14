/*
 * Sanitize the free-text DS_BYPASS_REASON env value at its single ingestion
 * point (exec.ts), so every downstream sink — the persisted verify report and
 * the telemetry event — receives an already-bounded, already-redacted string.
 * Order is redact THEN cap: capping first could truncate a secret yet leak its
 * prefix. This is a best-effort deny-list, NOT a scanner: the pattern set is by
 * definition incomplete (new token formats appear), so "keep no secrets in
 * DS_BYPASS_REASON" (README) stays the operative rule — redaction is a
 * fail-closed backstop, not a licence. Deterministic in-process patterns
 * (dep-free) rather than the deep-review gitleaks scanner: that one is a
 * fail-closed binary spawn, and report writing must not gain an external-tool
 * availability dependency for one 200-char human-typed field.
 */

/* Single owner of the 200-char reason policy: telemetry.ts imports this for its
 * sink-side defense-in-depth cap instead of defining its own copy. */
export const BYPASS_REASON_MAX = 200;

/* Deliberately over-redacting (fail-closed): a long URL or hash inside a
 * reason may get mangled; the reason is a one-line human note, not a payload
 * channel. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END[A-Z ]*PRIVATE KEY-----|$)/g,
  /\bgithub_pat_\w{20,}\b/g,
  /\bgh[oprsu]_[A-Za-z0-9]{20,}\b/g,
  /\bglpat-[\w-]{20,}\b/g,
  /\bxox[a-z]-[A-Za-z0-9-]{10,}\b/g,
  /\bsk-[\w-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{4,}\b/g,
  /\b(?:bearer|basic)[ \t]+[\w.~+/=-]{16,}/gi,
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key|authorization)\s*[=:]\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
  /\b[\w+/=-]{40,}\b/g,
];

export function capAndRedactBypassReason(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;
  /* A reason must be VISIBLE to be an audit trail: zero-width or blank-filler
   * strings (U+200B, Hangul Filler U+3164, Braille Blank U+2800) survive trim()
   * yet render as nothing — treat them as unset so the bypass still requires a
   * real reason. Best-effort like the deny-list: a determined user can always
   * type "x"; this guards the accidental/hollow cases, not adversaries. */
  if (!/(?![\p{Default_Ignorable_Code_Point}\u2800])[\p{L}\p{N}\p{P}\p{S}]/u.test(trimmed)) {
    return undefined;
  }
  let redacted = trimmed;
  for (const pattern of SECRET_PATTERNS) redacted = redacted.replace(pattern, '[REDACTED]');
  if (redacted.length <= BYPASS_REASON_MAX) return redacted;
  const capped = redacted.slice(0, BYPASS_REASON_MAX);
  /* Never end on a split surrogate pair: a lone high surrogate corrupts the
   * audit text (and any strict-UTF8 consumer of the report). */
  const last = capped.charCodeAt(capped.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? capped.slice(0, -1) : capped;
}
