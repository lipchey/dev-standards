import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { postJsonWithFetch, sendNotify } from '../../workflow/src/notify.ts';

async function withServer(handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void) {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => handler(req, Buffer.concat(chunks).toString('utf8'), res));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}/hook`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

const payload = {
  event: 'ready_for_review' as const,
  repo: 'owner/repo',
  pr: 42,
  url: 'https://github.example/owner/repo/pull/42',
  message: 'Ready for review',
};

test('payload-schema-exact', async () => {
  const received: unknown[] = [];
  const server = await withServer((_req, body, res) => {
    received.push(JSON.parse(body));
    res.writeHead(204).end();
  });
  try {
    const result = await postJsonWithFetch(server.url, payload, 10_000);

    assert.equal(result.ok, true);
    assert.deepEqual(received, [payload]);
    assert.deepEqual(Object.keys(received[0] as Record<string, unknown>), ['event', 'repo', 'pr', 'url', 'message']);
  } finally {
    await server.close();
  }
});

test('webhook-env-resolution', async () => {
  const calls: Array<{ url: string; timeoutMs: number }> = [];

  const result = await sendNotify(payload, {
    webhookEnv: 'CUSTOM_WEBHOOK',
    env: { CUSTOM_WEBHOOK: 'https://example.test/webhook' },
    postJson: async (url, _body, timeoutMs) => {
      calls.push({ url, timeoutMs });
      return { ok: true, status: 202 };
    },
    standalone: true,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ url: 'https://example.test/webhook', timeoutMs: 10_000 }]);
});

test('missing-env-warns-and-fails-standalone-only', async () => {
  const embedded = await sendNotify(payload, {
    webhookEnv: 'MISSING_WEBHOOK',
    env: {},
    postJson: async () => assert.fail('missing env should not post'),
    standalone: false,
  });
  assert.equal(embedded.ok, true);
  assert.equal(embedded.skipped, true);
  assert.match(embedded.warning ?? '', /MISSING_WEBHOOK/);

  const standalone = await sendNotify(payload, {
    webhookEnv: 'MISSING_WEBHOOK',
    env: {},
    postJson: async () => assert.fail('missing env should not post'),
    standalone: true,
  });
  assert.equal(standalone.ok, false);
  assert.equal(standalone.skipped, true);
  assert.match(standalone.error ?? '', /MISSING_WEBHOOK/);
});

test('timeout-10s', async () => {
  let timeout = 0;
  const result = await sendNotify(payload, {
    webhookEnv: 'WORKFLOW_NOTIFY_WEBHOOK',
    env: { WORKFLOW_NOTIFY_WEBHOOK: 'https://example.test/webhook' },
    postJson: async (_url, _body, timeoutMs) => {
      timeout = timeoutMs;
      return { ok: false, error: 'timed out' };
    },
    standalone: true,
  });

  assert.equal(timeout, 10_000);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /timed out/);
});

test('non-2xx-is-failure', async () => {
  const server = await withServer((_req, _body, res) => {
    res.writeHead(503).end('nope');
  });
  try {
    const result = await postJsonWithFetch(server.url, payload, 10_000);

    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.match(result.error ?? '', /503/);
  } finally {
    await server.close();
  }
});
