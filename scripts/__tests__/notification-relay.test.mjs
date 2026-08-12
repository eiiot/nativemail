import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const servers = [];
const processes = [];
const tempDirectories = [];

afterEach(async () => {
  for (const process of processes.splice(0)) process.kill('SIGTERM');
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(() => resolve()))));
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe('notification relay message-body proxy', () => {
  it('fetches one email body from Fastmail without persisting the bearer token', async () => {
    const seenAuthorization = [];
    let sessionRequests = 0;
    const fastmail = createServer(async (request, response) => {
      seenAuthorization.push(request.headers.authorization ?? '');
      response.setHeader('content-type', 'application/json');

      if (request.url === '/session') {
        sessionRequests += 1;
        response.end(JSON.stringify({
          apiUrl: `http://127.0.0.1:${fastmail.address().port}/api`,
          primaryAccounts: { 'urn:ietf:params:jmap:mail': 'account-1' },
        }));
        return;
      }

      response.end(JSON.stringify({
        methodResponses: [['Email/get', { list: [{ id: 'message-1', textBody: [], bodyValues: {} }] }, '0']],
      }));
    });
    servers.push(fastmail);
    await listen(fastmail);

    const relayPort = await getAvailablePort();
    const directory = await mkdtemp(path.join(tmpdir(), 'nativemail-relay-test-'));
    tempDirectories.push(directory);
    const relay = spawn(process.execPath, ['scripts/notification-relay.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        FASTMAIL_SESSION_URL: `http://127.0.0.1:${fastmail.address().port}/session`,
        NOTIFICATION_RELAY_OBSERVABILITY_PATH: path.join(directory, 'observability.jsonl'),
        NOTIFICATION_RELAY_STORE_PATH: path.join(directory, 'store.json'),
        PORT: String(relayPort),
      },
      stdio: 'ignore',
    });
    processes.push(relay);
    await waitForHealth(relayPort);

    const response = await fetch(`http://127.0.0.1:${relayPort}/jmap/message-body`, {
      body: JSON.stringify({ messageId: 'message-1' }),
      headers: { authorization: 'Bearer secret-token', 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ email: { id: 'message-1' }, ok: true });
    const secondResponse = await fetch(`http://127.0.0.1:${relayPort}/jmap/message-body`, {
      body: JSON.stringify({ messageId: 'message-1' }),
      headers: { authorization: 'Bearer secret-token', 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(secondResponse.status).toBe(200);
    expect(sessionRequests).toBe(1);
    expect(seenAuthorization).toEqual(['Bearer secret-token', 'Bearer secret-token', 'Bearer secret-token']);
  });

  it('fetches multiple immutable email bodies in one JMAP call', async () => {
    let requestedIds = [];
    const fastmail = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/session') {
        response.end(JSON.stringify({
          apiUrl: `http://127.0.0.1:${fastmail.address().port}/api`,
          primaryAccounts: { 'urn:ietf:params:jmap:mail': 'account-1' },
        }));
        return;
      }
      const body = await readRequestJson(request);
      requestedIds = body.methodCalls[0][1].ids;
      response.end(JSON.stringify({
        methodResponses: [['Email/get', { list: requestedIds.map((id) => ({ id, textBody: [], bodyValues: {} })) }, '0']],
      }));
    });
    servers.push(fastmail);
    await listen(fastmail);
    const { port } = await startRelay(fastmail);

    const response = await fetch(`http://127.0.0.1:${port}/jmap/message-body`, {
      body: JSON.stringify({ messageIds: ['message-1', 'message-2'] }),
      headers: { authorization: 'Bearer secret-token', 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(requestedIds).toEqual(['message-1', 'message-2']);
    expect(await response.json()).toMatchObject({
      emails: [{ id: 'message-1' }, { id: 'message-2' }],
      ok: true,
    });
  });
});

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function startRelay(fastmail) {
  const port = await getAvailablePort();
  const directory = await mkdtemp(path.join(tmpdir(), 'nativemail-relay-test-'));
  tempDirectories.push(directory);
  const relay = spawn(process.execPath, ['scripts/notification-relay.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      FASTMAIL_SESSION_URL: `http://127.0.0.1:${fastmail.address().port}/session`,
      NOTIFICATION_RELAY_OBSERVABILITY_PATH: path.join(directory, 'observability.jsonl'),
      NOTIFICATION_RELAY_STORE_PATH: path.join(directory, 'store.json'),
      PORT: String(port),
    },
    stdio: 'ignore',
  });
  processes.push(relay);
  await waitForHealth(port);
  return { port };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

async function getAvailablePort() {
  const server = createServer();
  await listen(server);
  const port = server.address().port;
  await new Promise((resolve) => server.close(() => resolve()));
  return port;
}

async function waitForHealth(port) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Relay did not start');
}
