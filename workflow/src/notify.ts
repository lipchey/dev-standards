export const NOTIFY_EVENTS = ['ready_for_review', 'work_finished', 'ci_failed'] as const;

export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

export interface NotifyPayload {
  event: NotifyEvent;
  repo: string;
  pr: number;
  url: string;
  message: string;
}

export interface NotifyPostResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export type NotifyPostJson = (
  url: string,
  payload: NotifyPayload,
  timeoutMs: number,
) => Promise<NotifyPostResult>;

export interface SendNotifyOptions {
  webhookEnv: string;
  env: Record<string, string | undefined>;
  postJson?: NotifyPostJson;
  standalone: boolean;
}

export interface SendNotifyResult extends NotifyPostResult {
  skipped?: boolean;
  warning?: string;
}

const DEFAULT_NOTIFY_TIMEOUT_MS = 10_000;

export function isNotifyEvent(value: string): value is NotifyEvent {
  return (NOTIFY_EVENTS as readonly string[]).includes(value);
}

export async function postJsonWithFetch(
  url: string,
  payload: NotifyPayload,
  timeoutMs: number,
): Promise<NotifyPostResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, status: response.status, error: `notify webhook returned HTTP ${response.status}` };
    }
    return { ok: true, status: response.status };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `notify webhook request failed: ${detail}` };
  } finally {
    clearTimeout(timeout);
  }
}

export async function sendNotify(
  payload: NotifyPayload,
  opts: SendNotifyOptions,
): Promise<SendNotifyResult> {
  const url = opts.env[opts.webhookEnv];
  if (url === undefined || url.trim() === '') {
    const message = `notify webhook env ${opts.webhookEnv} is not set`;
    if (opts.standalone) return { ok: false, skipped: true, error: message };
    return { ok: true, skipped: true, warning: message };
  }
  const post = opts.postJson ?? postJsonWithFetch;
  return post(url, payload, DEFAULT_NOTIFY_TIMEOUT_MS);
}
