#!/usr/bin/env node

import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const CORE_CAPABILITY = 'urn:ietf:params:jmap:core';
const MAIL_CAPABILITY = 'urn:ietf:params:jmap:mail';
const FASTMAIL_SESSION_URL = 'https://api.fastmail.com/jmap/session';
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const PORT = Number.parseInt(process.env.PORT ?? '8787', 10);
const FALLBACK_POLL_MS = Number.parseInt(
  process.env.NOTIFICATION_FALLBACK_POLL_MS ?? process.env.NOTIFICATION_POLL_MS ?? '60000',
  10
);
const STORE_PATH =
  process.env.NOTIFICATION_RELAY_STORE_PATH ??
  path.join(homedir(), '.nativemail', 'fastmail-glass', 'notification-relay.json');
const LEGACY_STORE_PATH = path.join(process.cwd(), '.nativemail', 'notification-relay.json');

/** @type {Map<string, Subscriber>} */
const subscribers = new Map();

/**
 * @typedef {{
 *   accountId: string;
 *   apiUrl: string;
 *   deviceId: string;
 *   eventSourceUrl?: string;
 *   expoPushToken: string;
 *   inboxMailboxId: string;
 *   jmapToken: string;
 *   knownInboxEmailIds: string[];
 *   mailboxName: string;
 *   status: string;
 *   username: string;
 *   abortController?: AbortController;
 *   pollTimer?: NodeJS.Timeout;
 * }} Subscriber
 */

await loadStore();

const server = createServer(async (request, response) => {
  try {
    await route(request, response);
  } catch (error) {
    console.error('[relay] request failed', error);
    sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, () => {
  console.log(`[relay] listening on http://localhost:${PORT}`);
  console.log(`[relay] data store ${STORE_PATH}`);

  for (const subscriber of subscribers.values()) {
    void startSubscriber(subscriber, { rehydrate: true });
  }
});

async function route(request, response) {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `localhost:${PORT}`}`);

  if (request.method === 'GET' && url.pathname === '/health') {
    sendJson(response, 200, {
      ok: true,
      subscriberCount: subscribers.size,
      subscribers: [...subscribers.values()].map(toPublicSubscriber),
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/register') {
    const body = await readJson(request);
    const expoPushToken = getRequiredString(body, 'expoPushToken');
    const jmapToken = getRequiredString(body, 'jmapToken');
    const deviceId = sanitizeDeviceId(getRequiredString(body, 'deviceId'));

    if (!isExpoPushToken(expoPushToken)) {
      sendJson(response, 400, { error: 'Invalid Expo push token.' });
      return;
    }

    const subscriber = await createSubscriber({
      deviceId,
      expoPushToken,
      jmapToken,
    });

    subscribers.set(deviceId, subscriber);
    await saveStore();
    await startSubscriber(subscriber, { rehydrate: false });

    sendJson(response, 200, { ok: true, subscriber: toPublicSubscriber(subscriber) });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/test') {
    const body = await readJson(request);
    const deviceId = sanitizeDeviceId(getRequiredString(body, 'deviceId'));
    const subscriber = subscribers.get(deviceId);

    if (!subscriber) {
      sendJson(response, 404, { error: 'Device is not registered.' });
      return;
    }

    const ticket = await sendExpoPush(subscriber, {
      body: 'Prototype notification relay is connected.',
      data: { reason: 'test' },
      title: 'NativeMail',
    });

    sendJson(response, 200, { ok: true, ticket });
    return;
  }

  if (request.method === 'DELETE' && url.pathname.startsWith('/register/')) {
    const deviceId = sanitizeDeviceId(decodeURIComponent(url.pathname.slice('/register/'.length)));
    const subscriber = subscribers.get(deviceId);

    if (subscriber) {
      stopSubscriber(subscriber);
      subscribers.delete(deviceId);
      await saveStore();
    }

    sendJson(response, 200, { ok: true });
    return;
  }

  sendJson(response, 404, { error: 'Not found.' });
}

async function createSubscriber({ deviceId, expoPushToken, jmapToken }) {
  const session = await discoverJmapSession(jmapToken);
  const accountId = session.primaryAccounts?.[MAIL_CAPABILITY];

  if (!accountId) {
    throw new Error('Fastmail JMAP session did not include a primary mail account.');
  }

  const mailboxes = await jmapRequest(session.apiUrl, jmapToken, [
    [
      'Mailbox/get',
      {
        accountId,
        ids: null,
        properties: ['id', 'name', 'role'],
      },
      'mailboxes',
    ],
  ]);
  const mailboxResponse = findMethodResponse(mailboxes, 'Mailbox/get');
  const inbox = mailboxResponse?.[1]?.list?.find((mailbox) => mailbox.role === 'inbox');

  if (!inbox) {
    throw new Error('No Inbox mailbox was returned by Fastmail.');
  }

  const subscriber = {
    accountId,
    apiUrl: session.apiUrl,
    deviceId,
    eventSourceUrl: session.eventSourceUrl,
    expoPushToken,
    inboxMailboxId: inbox.id,
    jmapToken,
    knownInboxEmailIds: [],
    mailboxName: inbox.name || 'Inbox',
    status: 'registered',
    username: session.username || 'unknown',
  };

  await refreshInbox(subscriber, { notify: false, reason: 'register' });

  return subscriber;
}

async function startSubscriber(subscriber, { rehydrate }) {
  stopSubscriber(subscriber);

  if (rehydrate) {
    try {
      const session = await discoverJmapSession(subscriber.jmapToken);
      subscriber.apiUrl = session.apiUrl;
      subscriber.eventSourceUrl = session.eventSourceUrl;
      subscriber.status = 'rehydrated';
    } catch (error) {
      subscriber.status = `session error: ${describeError(error)}`;
      await saveStore();
      return;
    }
  }

  if (subscriber.eventSourceUrl) {
    subscriber.abortController = new AbortController();
    void readEventSourceLoop(subscriber, subscriber.abortController.signal);
  } else {
    startPolling(subscriber);
    subscriber.status = 'polling; no JMAP eventSourceUrl';
    await saveStore();
  }
}

function startPolling(subscriber) {
  subscriber.pollTimer = setInterval(() => {
    void refreshInbox(subscriber, { notify: true, reason: 'poll' }).catch((error) => {
      subscriber.status = `poll error: ${describeError(error)}`;
      console.error('[relay] poll failed', subscriber.deviceId, error);
      void saveStore();
    });
  }, FALLBACK_POLL_MS);
  subscriber.pollTimer.unref?.();
}

function stopSubscriber(subscriber) {
  subscriber.abortController?.abort();

  if (subscriber.pollTimer) {
    clearInterval(subscriber.pollTimer);
  }

  delete subscriber.abortController;
  delete subscriber.pollTimer;
}

async function readEventSourceLoop(subscriber, signal) {
  let attempt = 0;

  while (!signal.aborted) {
    try {
      subscriber.status = 'event source connecting';
      await saveStore();
      await readEventSource(subscriber, signal);
      attempt = 0;
    } catch (error) {
      if (signal.aborted) {
        return;
      }

      attempt += 1;
      subscriber.status = `event source error: ${describeError(error)}`;
      console.error('[relay] event source failed', subscriber.deviceId, error);
      await saveStore();
      await delay(Math.min(30000, 1000 * 2 ** attempt), undefined, { signal }).catch(() => {});
    }
  }
}

async function readEventSource(subscriber, signal) {
  const eventSourceUrl = expandEventSourceUrl(subscriber.eventSourceUrl, {
    closeafter: 'no',
    ping: '60',
    types: 'Email',
  });
  const response = await fetch(eventSourceUrl, {
    headers: {
      Accept: 'text/event-stream',
      Authorization: `Bearer ${subscriber.jmapToken}`,
    },
    signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(`JMAP event source failed with HTTP ${response.status}`);
  }

  subscriber.status = 'event source connected';
  await saveStore();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (!signal.aborted) {
    const { done, value } = await reader.read();

    if (done) {
      return;
    }

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? '';

    for (const eventText of events) {
      await handleEventSourceEvent(subscriber, parseEventSourceEvent(eventText));
    }
  }
}

async function handleEventSourceEvent(subscriber, event) {
  if (!event.data || (event.event !== 'state' && event.event !== 'message')) {
    return;
  }

  let payload;

  try {
    payload = JSON.parse(event.data);
  } catch {
    return;
  }

  if (payload?.['@type'] !== 'StateChange') {
    return;
  }

  const changedTypes = payload.changed?.[subscriber.accountId];

  if (!changedTypes?.Email) {
    return;
  }

  await refreshInbox(subscriber, { notify: true, reason: 'state' });
}

async function refreshInbox(subscriber, { notify, reason }) {
  const responses = await jmapRequest(subscriber.apiUrl, subscriber.jmapToken, [
    [
      'Email/query',
      {
        accountId: subscriber.accountId,
        collapseThreads: false,
        filter: { inMailbox: subscriber.inboxMailboxId },
        limit: 10,
        position: 0,
        sort: [{ property: 'receivedAt', isAscending: false }],
      },
      'query',
    ],
    [
      'Email/get',
      {
        accountId: subscriber.accountId,
        '#ids': {
          resultOf: 'query',
          name: 'Email/query',
          path: '/ids',
        },
        properties: ['id', 'threadId', 'mailboxIds', 'receivedAt', 'from', 'subject', 'preview'],
      },
      'get',
    ],
  ]);
  const queryResponse = findMethodResponse(responses, 'Email/query');
  const emailResponse = findMethodResponse(responses, 'Email/get');
  const queryIds = queryResponse?.[1]?.ids ?? [];
  const emails = sortEmails(emailResponse?.[1]?.list ?? [], queryIds);
  const knownIds = new Set(subscriber.knownInboxEmailIds);
  const newEmails = emails.filter((email) => !knownIds.has(email.id));

  subscriber.knownInboxEmailIds = mergeKnownIds(subscriber.knownInboxEmailIds, queryIds);
  subscriber.status = `inbox checked (${reason}) at ${new Date().toISOString()}`;
  await saveStore();

  if (!notify || !newEmails.length) {
    return;
  }

  for (const email of newEmails.reverse()) {
    await sendInboxNotification(subscriber, email);
  }
}

async function sendInboxNotification(subscriber, email) {
  const from = email.from?.[0];
  const sender = from?.name || from?.email || 'New mail';
  const subject = email.subject || '(No subject)';
  const body = email.preview || `New message in ${subscriber.mailboxName}`;

  await sendExpoPush(subscriber, {
    body,
    data: {
      date: email.receivedAt ?? '',
      fromEmail: from?.email ?? '',
      mailboxId: subscriber.inboxMailboxId,
      mailboxName: subscriber.mailboxName,
      messageId: email.id,
      preview: email.preview ?? '',
      sender,
      source: 'jmap',
      subject,
      threadId: email.threadId ?? '',
    },
    title: sender,
    subtitle: subject,
  });
}

async function sendExpoPush(subscriber, message) {
  const response = await fetch(EXPO_PUSH_URL, {
    body: JSON.stringify({
      ...message,
      sound: 'default',
      to: subscriber.expoPushToken,
    }),
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(`Expo push failed with HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }

  console.log('[relay] sent notification', subscriber.deviceId, message.title, message.subtitle ?? '');
  return payload;
}

async function discoverJmapSession(token) {
  const response = await fetch(FASTMAIL_SESSION_URL, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Fastmail JMAP session failed with HTTP ${response.status}`);
  }

  return response.json();
}

async function jmapRequest(apiUrl, token, methodCalls) {
  const response = await fetch(apiUrl, {
    body: JSON.stringify({
      methodCalls,
      using: [CORE_CAPABILITY, MAIL_CAPABILITY],
    }),
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(`Fastmail JMAP API failed with HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }

  for (const methodResponse of payload.methodResponses ?? []) {
    if (methodResponse[0] === 'error') {
      throw new Error(`JMAP ${methodResponse[0]}: ${JSON.stringify(methodResponse[1])}`);
    }
  }

  return payload.methodResponses ?? [];
}

function parseEventSourceEvent(eventText) {
  const event = { data: '', event: 'message', id: '' };

  for (const line of eventText.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) {
      continue;
    }

    const separatorIndex = line.indexOf(':');
    const field = separatorIndex >= 0 ? line.slice(0, separatorIndex) : line;
    const rawValue = separatorIndex >= 0 ? line.slice(separatorIndex + 1) : '';
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;

    if (field === 'event') {
      event.event = value;
    } else if (field === 'data') {
      event.data += event.data ? `\n${value}` : value;
    } else if (field === 'id') {
      event.id = value;
    }
  }

  return event;
}

function expandEventSourceUrl(template, variables) {
  return template
    .replace(/\{\?([^}]+)\}/g, (_match, names) => {
      const params = names
        .split(',')
        .filter((name) => variables[name] !== undefined)
        .map((name) => `${encodeURIComponent(name)}=${encodeURIComponent(variables[name])}`);

      return params.length ? `?${params.join('&')}` : '';
    })
    .replace(/\{([^}]+)\}/g, (_match, name) => encodeURIComponent(variables[name] ?? ''));
}

function findMethodResponse(responses, name) {
  return responses.find((response) => response[0] === name) ?? null;
}

function sortEmails(emails, ids) {
  const byId = new Map(emails.map((email) => [email.id, email]));

  return ids.map((id) => byId.get(id)).filter(Boolean);
}

function mergeKnownIds(currentIds, nextIds) {
  return Array.from(new Set([...nextIds, ...currentIds])).slice(0, 200);
}

async function readJson(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString('utf8');

  return text ? JSON.parse(text) : {};
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload, null, 2));
}

function getRequiredString(body, key) {
  const value = body?.[key];

  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Missing ${key}.`);
  }

  return value.trim();
}

function sanitizeDeviceId(value) {
  return value.replace(/[^a-zA-Z0-9._:-]/g, '-').slice(0, 120);
}

function isExpoPushToken(token) {
  return /^Expo(nent)?PushToken\[[^\]]+\]$/.test(token);
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function toPublicSubscriber(subscriber) {
  return {
    accountId: subscriber.accountId,
    deviceId: subscriber.deviceId,
    eventSource: Boolean(subscriber.eventSourceUrl),
    inboxMailboxId: subscriber.inboxMailboxId,
    knownInboxEmailIds: subscriber.knownInboxEmailIds.length,
    mailboxName: subscriber.mailboxName,
    pollingMs: subscriber.pollTimer ? FALLBACK_POLL_MS : null,
    status: subscriber.status,
    username: subscriber.username,
  };
}

async function loadStore() {
  try {
    const text = await readFile(STORE_PATH, 'utf8').catch(async (error) => {
      if (error?.code === 'ENOENT' && STORE_PATH !== LEGACY_STORE_PATH) {
        return await readFile(LEGACY_STORE_PATH, 'utf8');
      }

      throw error;
    });
    const data = JSON.parse(text);

    for (const subscriber of data.subscribers ?? []) {
      subscribers.set(subscriber.deviceId, subscriber);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn('[relay] could not read store', error);
    }
  }
}

async function saveStore() {
  await mkdir(path.dirname(STORE_PATH), { recursive: true });
  await writeFile(
    STORE_PATH,
    JSON.stringify({
      subscribers: [...subscribers.values()].map((subscriber) => {
        const { abortController, pollTimer, ...storedSubscriber } = subscriber;

        return storedSubscriber;
      }),
    }, null, 2)
  );
}
