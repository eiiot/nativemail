#!/usr/bin/env node

import { Buffer } from 'node:buffer';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const CORE_CAPABILITY = 'urn:ietf:params:jmap:core';
const MAIL_CAPABILITY = 'urn:ietf:params:jmap:mail';
const FASTMAIL_SESSION_URL = process.env.FASTMAIL_SESSION_URL ?? 'https://api.fastmail.com/jmap/session';
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EVENT_SOURCE_TYPES = '*';
const ACTIVE_NOTIFICATION_LIMIT = 200;
const KNOWN_INBOX_EMAIL_LIMIT = 20000;
const NEW_EMAIL_CLOCK_SKEW_MS = 2 * 60 * 1000;
const INBOX_STATE_SYNC_LIMIT = 10;
const LOCAL_ACTION_SUPPRESSION_MS = 8000;
const INBOX_MESSAGE_NOTIFICATION_CATEGORY_ID = 'nativemailInboxMessage';
const PORT = Number.parseInt(process.env.PORT ?? '8787', 10);
const FALLBACK_POLL_MS = Number.parseInt(
  process.env.NOTIFICATION_FALLBACK_POLL_MS ?? process.env.NOTIFICATION_POLL_MS ?? '60000',
  10
);
const STORE_PATH =
  process.env.NOTIFICATION_RELAY_STORE_PATH ??
  path.join(homedir(), '.nativemail', 'fastmail-glass', 'notification-relay.json');
const LEGACY_STORE_PATH = path.join(process.cwd(), '.nativemail', 'notification-relay.json');
const OBSERVABILITY_LOG_PATH =
  process.env.NOTIFICATION_RELAY_OBSERVABILITY_PATH ??
  path.join(homedir(), '.nativemail', 'fastmail-glass', 'observability.jsonl');
const BODY_CACHE_DIR =
  process.env.NOTIFICATION_RELAY_BODY_CACHE_DIR ??
  path.join(path.dirname(STORE_PATH), 'body-cache');
const OBSERVABILITY_EVENT_LIMIT = 100;
const JMAP_SESSION_CACHE_TTL_MS = 10 * 60 * 1000;
const JMAP_SESSION_TIMEOUT_MS = 2000;
const JMAP_BODY_TIMEOUT_MS = 4000;
const JMAP_PROXY_TIMEOUT_MS = 8000;
const DIAGNOSTIC_TOKEN = process.env.NOTIFICATION_RELAY_DIAGNOSTIC_TOKEN ?? '';
const BODY_CACHE_BATCH_SIZE = 10;
const BODY_BACKFILL_QUERY_LIMIT = 100;
const BODY_BACKFILL_BATCH_DELAY_MS = 150;

/** @type {Map<string, { accountId: string; apiUrl: string; expiresAt: number }>} */
const jmapSessionCache = new Map();
/** @type {Map<string, { activeController?: AbortController; activePriority?: number; running: boolean; tasks: Array<{ priority: number; run: (signal: AbortSignal) => Promise<unknown>; resolve: (value: unknown) => void; reject: (error: unknown) => void }> }>} */

/** @type {Map<string, Subscriber>} */
const subscribers = new Map();
const bodyBackfills = new Map();

/**
 * @typedef {{
 *   accountId: string;
 *   apiUrl: string;
 *   deviceId: string;
 *   eventSourceUrl?: string;
 *   expoPushToken: string;
 *   inboxMailboxId: string;
 *   jmapToken: string;
 *   activeNotificationEmailIds?: string[];
 *   knownInboxEmailIds: string[];
 *   lastEventAt?: string;
 *   lastEventId?: string;
 *   lastEventType?: string;
 *   lastInboxCheckedAt?: string;
 *   lastInboxCheckReason?: string;
 *   lastInboxEmailIds?: string[];
 *   lastInboxUnreadEmailsSource?: string;
 *   lastInboxStateSignature?: string;
 *   lastInboxStateSyncAt?: string;
 *   lastLocalActionAt?: string;
 *   lastLocalActionMessageIds?: string[];
 *   localActionSuppressUntil?: number;
 *   lastMailboxUnreadEmails?: number | null;
 *   lastNewInboxEmailIds?: string[];
 *   lastInboxUnreadEmails?: number | null;
 *   lastBadgeSyncAt?: string;
 *   lastNotificationDismissalAt?: string;
 *   lastNotificationDismissalEmailIds?: string[];
 *   lastNotificationAt?: string;
 *   lastNotificationTitle?: string;
 *   lastPushTicketId?: string;
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
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/health/details') {
    if (!requireDiagnosticAuthorization(request, response)) return;
    sendJson(response, 200, {
      ok: true,
      subscriberCount: subscribers.size,
      subscribers: [...subscribers.values()].map(toPublicSubscriber),
    });
    return;
  }

  if (request.method === 'GET' && url.pathname.startsWith('/debug/')) {
    if (!requireDiagnosticAuthorization(request, response)) return;
    const deviceId = sanitizeDeviceId(decodeURIComponent(url.pathname.slice('/debug/'.length)));
    const subscriber = subscribers.get(deviceId);

    sendJson(response, 200, {
      ok: true,
      registered: Boolean(subscriber),
      subscriber: subscriber ? toPublicSubscriber(subscriber, { includeDebug: true }) : null,
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/observability') {
    if (!requireDiagnosticAuthorization(request, response)) return;
    const limit = Math.min(
      OBSERVABILITY_EVENT_LIMIT,
      Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? '50', 10) || 50)
    );

    sendJson(response, 200, {
      events: await readRecentObservabilityEvents(limit),
      ok: true,
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/observability') {
    const body = await readJson(request);
    const events = normalizeObservabilityEvents(body);

    if (!events.length) {
      sendJson(response, 200, { accepted: 0, ok: true });
      return;
    }

    await appendObservabilityEvents(events);
    sendJson(response, 200, { accepted: events.length, ok: true });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/jmap/message-body') {
    const startedAt = Date.now();
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ') || authorization.length <= 7) {
      sendJson(response, 401, { error: 'A Fastmail bearer token is required.' });
      return;
    }

    const body = await readJson(request);
    const requestedMessageIds = Array.isArray(body.messageIds)
      ? body.messageIds.filter((value) => typeof value === 'string' && value.length > 0)
      : [getRequiredString(body, 'messageId')];
    const messageIds = [...new Set(requestedMessageIds)].slice(0, 20);
    if (!messageIds.length) {
      sendJson(response, 400, { error: 'At least one message id is required.' });
      return;
    }
    const token = authorization.slice(7);
    const cachedEmails = await readCachedEmails(token, messageIds);
    const missingMessageIds = messageIds.filter((messageId) => !cachedEmails.has(messageId));

    if (!missingMessageIds.length) {
      const emails = messageIds.map((messageId) => cachedEmails.get(messageId)).filter(Boolean);
      sendJson(response, 200, {
        cache: { hits: emails.length, misses: 0 },
        email: messageIds.length === 1 ? emails[0] ?? null : undefined,
        emails,
        ok: true,
        timings: { jmapMs: 0, sessionCacheHit: true, sessionMs: 0, totalMs: Date.now() - startedAt },
      });
      return;
    }

    const sessionStartedAt = Date.now();
    const { accountId, apiUrl, cacheHit } = await getCachedJmapSession(token);

    const jmapStartedAt = Date.now();
    const jmapResponse = await fetchWithTimeout(apiUrl, {
      body: JSON.stringify({
        using: [CORE_CAPABILITY, MAIL_CAPABILITY],
        methodCalls: [[
          'Email/get',
          {
            accountId,
            ids: missingMessageIds,
            properties: ['id', 'blobId', 'bodyStructure', 'bodyValues', 'htmlBody', 'textBody', 'attachments'],
            bodyProperties: ['partId', 'blobId', 'size', 'name', 'type', 'charset', 'cid', 'disposition'],
            fetchHTMLBodyValues: true,
            fetchTextBodyValues: true,
          },
          '0',
        ]],
      }),
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
    }, JMAP_BODY_TIMEOUT_MS, 'Fastmail Email/get timed out');
    if (!jmapResponse.ok) {
      sendJson(response, jmapResponse.status, { error: 'Fastmail Email/get failed.' });
      return;
    }

    const result = await jmapResponse.json();
    const invocation = result.methodResponses?.[0];
    if (invocation?.[0] === 'error') {
      sendJson(response, 502, { error: `Fastmail Email/get: ${invocation[1]?.type ?? 'unknown'}` });
      return;
    }

    const timings = {
      jmapMs: Date.now() - jmapStartedAt,
      sessionCacheHit: cacheHit,
      sessionMs: jmapStartedAt - sessionStartedAt,
      totalMs: Date.now() - startedAt,
    };
    const fetchedEmails = invocation?.[1]?.list ?? [];
    await Promise.all(fetchedEmails.map((email) => writeCachedEmail(token, email)));
    for (const email of fetchedEmails) cachedEmails.set(email.id, email);
    const emails = messageIds.map((messageId) => cachedEmails.get(messageId)).filter(Boolean);
    console.log('[relay] message body success', JSON.stringify({ messageIds, count: emails.length, cacheHits: messageIds.length - missingMessageIds.length, ...timings }));
    sendJson(response, 200, {
      cache: { hits: messageIds.length - missingMessageIds.length, misses: missingMessageIds.length },
      email: messageIds.length === 1 ? emails[0] ?? null : undefined,
      emails,
      ok: true,
      timings,
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/jmap/proxy') {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ') || authorization.length <= 7) {
      sendJson(response, 401, { error: 'A Fastmail bearer token is required.' });
      return;
    }

    const token = authorization.slice(7);
    const proxyRequest = await readJson(request);
    const target = new URL(getRequiredString(proxyRequest, 'url'));
    if (target.protocol !== 'https:' || !isAllowedFastmailHostname(target.hostname)) {
      sendJson(response, 400, { error: 'Invalid Fastmail proxy target.' });
      return;
    }
    const method = getOptionalString(proxyRequest, 'method') ?? 'GET';
    const requestBody = getOptionalString(proxyRequest, 'body');
    const upstream = await fetchWithTimeout(target, {
      body: method === 'GET' ? undefined : requestBody,
      headers: {
        Accept: getOptionalString(proxyRequest, 'accept') ?? 'application/json',
        Authorization: `Bearer ${token}`,
        ...(requestBody ? { 'Content-Type': 'application/json' } : {}),
      },
      method,
    }, JMAP_PROXY_TIMEOUT_MS, 'Fastmail proxy request timed out');
    const payload = Buffer.from(await upstream.arrayBuffer());
    response.statusCode = upstream.status;
    response.setHeader('content-type', upstream.headers.get('content-type') ?? 'application/octet-stream');
    response.end(payload);
    return;
  }

  if (request.method === 'POST' && url.pathname.startsWith('/refresh/')) {
    const deviceId = sanitizeDeviceId(decodeURIComponent(url.pathname.slice('/refresh/'.length)));
    const subscriber = subscribers.get(deviceId);

    if (!subscriber) {
      sendJson(response, 404, { error: 'Device is not registered.' });
      return;
    }

    const notify = url.searchParams.get('notify') === '1';
    const result = await refreshInbox(subscriber, { notify, reason: notify ? 'manual-notify' : 'manual' });

    sendJson(response, 200, { ok: true, result, subscriber: toPublicSubscriber(subscriber, { includeDebug: true }) });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/local-action') {
    const body = await readJson(request);
    const deviceId = sanitizeDeviceId(getRequiredString(body, 'deviceId'));
    const subscriber = subscribers.get(deviceId);

    if (!subscriber) {
      sendJson(response, 404, { error: 'Device is not registered.' });
      return;
    }

    const messageId = getOptionalString(body, 'messageId');

    subscriber.localActionSuppressUntil = Date.now() + LOCAL_ACTION_SUPPRESSION_MS;
    subscriber.lastLocalActionAt = new Date().toISOString();
    subscriber.lastLocalActionMessageIds = messageId
      ? mergeKnownIds(subscriber.lastLocalActionMessageIds ?? [], [messageId]).slice(0, 20)
      : subscriber.lastLocalActionMessageIds ?? [];
    await saveStore();

    sendJson(response, 200, {
      ok: true,
      suppressUntil: new Date(subscriber.localActionSuppressUntil).toISOString(),
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

  if (request.method === 'GET' && url.pathname.startsWith('/register/')) {
    const deviceId = sanitizeDeviceId(decodeURIComponent(url.pathname.slice('/register/'.length)));
    const subscriber = subscribers.get(deviceId);

    sendJson(response, 200, {
      ok: true,
      registered: Boolean(subscriber),
      subscriber: subscriber ? toPublicSubscriber(subscriber) : null,
    });
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

async function getCachedJmapSession(token) {
  const cacheKey = createHash('sha256').update(token).digest('hex');
  const cached = jmapSessionCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached, cacheHit: true };
  }

  const sessionResponse = await fetchWithTimeout(FASTMAIL_SESSION_URL, {
    headers: { Authorization: `Bearer ${token}` },
  }, JMAP_SESSION_TIMEOUT_MS, 'Fastmail JMAP session timed out');
  if (!sessionResponse.ok) {
    throw new Error(`Fastmail JMAP session failed with HTTP ${sessionResponse.status}.`);
  }

  const session = await sessionResponse.json();
  const accountId = session.primaryAccounts?.[MAIL_CAPABILITY];
  if (!accountId || !session.apiUrl) {
    throw new Error('Fastmail JMAP session is missing mail request details.');
  }

  const value = {
    accountId,
    apiUrl: session.apiUrl,
    expiresAt: Date.now() + JMAP_SESSION_CACHE_TTL_MS,
  };
  jmapSessionCache.set(cacheKey, value);
  return { ...value, cacheHit: false };
}

function getBodyCachePath(token, messageId) {
  const accountKey = createHash('sha256').update(token).digest('hex');
  const messageKey = createHash('sha256').update(messageId).digest('hex');
  return path.join(BODY_CACHE_DIR, accountKey.slice(0, 2), accountKey, `${messageKey}.json`);
}

async function readCachedEmails(token, messageIds) {
  const entries = await Promise.all(messageIds.map(async (messageId) => {
    try {
      const email = JSON.parse(await readFile(getBodyCachePath(token, messageId), 'utf8'));
      return email?.id === messageId ? [messageId, email] : null;
    } catch (error) {
      if (error?.code !== 'ENOENT') console.warn('[relay] body cache read failed', messageId, describeError(error));
      return null;
    }
  }));
  return new Map(entries.filter(Boolean));
}

async function writeCachedEmail(token, email) {
  if (!email?.id) return;
  const cachePath = getBodyCachePath(token, email.id);
  const temporaryPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(temporaryPath, JSON.stringify(email));
  await rename(temporaryPath, cachePath);
}

async function fetchAndCacheBodies({ accountId, apiUrl, messageIds, token }) {
  const uniqueIds = [...new Set(messageIds)].filter(Boolean);
  if (!uniqueIds.length) return [];
  const cached = await readCachedEmails(token, uniqueIds);
  const missingIds = uniqueIds.filter((messageId) => !cached.has(messageId));
  if (!missingIds.length) return uniqueIds.map((messageId) => cached.get(messageId)).filter(Boolean);

  const response = await fetchWithTimeout(apiUrl, {
    body: JSON.stringify({
      using: [CORE_CAPABILITY, MAIL_CAPABILITY],
      methodCalls: [['Email/get', {
        accountId,
        ids: missingIds,
        properties: ['id', 'blobId', 'bodyStructure', 'bodyValues', 'htmlBody', 'textBody', 'attachments'],
        bodyProperties: ['partId', 'blobId', 'size', 'name', 'type', 'charset', 'cid', 'disposition'],
        fetchHTMLBodyValues: true,
        fetchTextBodyValues: true,
      }, 'cacheBodies']],
    }),
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    method: 'POST',
  }, JMAP_PROXY_TIMEOUT_MS, 'Fastmail body cache fill timed out');
  if (!response.ok) throw new Error(`Fastmail body cache fill failed with HTTP ${response.status}.`);
  const payload = await response.json();
  const invocation = payload.methodResponses?.[0];
  if (invocation?.[0] === 'error') throw new Error(`Fastmail body cache fill: ${invocation[1]?.type ?? 'unknown'}`);
  const emails = invocation?.[1]?.list ?? [];
  await Promise.all(emails.map((email) => writeCachedEmail(token, email)));
  for (const email of emails) cached.set(email.id, email);
  return uniqueIds.map((messageId) => cached.get(messageId)).filter(Boolean);
}

async function fetchWithTimeout(url, options, timeoutMs, message) {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  options.signal?.addEventListener('abort', forwardAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error(message)), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(message);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', forwardAbort);
  }
}

function isAllowedFastmailHostname(hostname) {
  return hostname === 'fastmail.com' || hostname.endsWith('.fastmail.com');
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
    activeNotificationEmailIds: [],
    apiUrl: session.apiUrl,
    deviceId,
    eventSourceUrl: session.eventSourceUrl,
    expoPushToken,
    inboxMailboxId: inbox.id,
    jmapToken,
    knownInboxEmailIds: [],
    registeredAt: new Date().toISOString(),
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
      await refreshInbox(subscriber, { notify: false, reason: 'rehydrate' });
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

  scheduleBodyBackfill(subscriber);
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
    types: EVENT_SOURCE_TYPES,
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
  if (!event.data) {
    if (event.event === 'ping') {
      subscriber.lastEventAt = new Date().toISOString();
      subscriber.lastEventId = event.id || undefined;
      subscriber.lastEventType = 'ping';
      await saveStore();
    }

    return;
  }

  let payload;

  try {
    payload = JSON.parse(event.data);
  } catch {
    subscriber.lastEventAt = new Date().toISOString();
    subscriber.lastEventId = event.id || undefined;
    subscriber.lastEventType = `${event.event}: invalid json`;
    await saveStore();
    return;
  }

  subscriber.lastEventAt = new Date().toISOString();
  subscriber.lastEventId = event.id || undefined;

  if (payload?.['@type'] !== 'StateChange' && !payload?.changed) {
    subscriber.lastEventType = `${event.event}: ${payload?.['@type'] ?? 'unknown'}`;
    await saveStore();
    return;
  }

  const changedTypes = payload.changed?.[subscriber.accountId];
  const changedTypeNames = Object.keys(changedTypes ?? {});
  subscriber.lastEventType = changedTypeNames.length ? `state: ${changedTypeNames.join(',')}` : 'state: no account changes';
  await saveStore();

  if (!changedTypes || (!changedTypes.Email && !changedTypes.EmailDelivery && !changedTypes.Mailbox)) {
    return;
  }

  await refreshInbox(subscriber, { notify: true, reason: 'state' });
}

async function refreshInbox(subscriber, { notify, reason }) {
  const activeNotificationEmailIds = normalizeIdList(subscriber.activeNotificationEmailIds);
  const methodCalls = [
    [
      'Mailbox/get',
      {
        accountId: subscriber.accountId,
        ids: [subscriber.inboxMailboxId],
        properties: ['id', 'unreadEmails'],
      },
      'mailbox',
    ],
    [
      'Email/query',
      {
        accountId: subscriber.accountId,
        collapseThreads: false,
        filter: { inMailbox: subscriber.inboxMailboxId },
        limit: INBOX_STATE_SYNC_LIMIT,
        position: 0,
        sort: [{ property: 'receivedAt', isAscending: false }],
      },
      'query',
    ],
    [
      'Email/query',
      {
        accountId: subscriber.accountId,
        calculateTotal: true,
        collapseThreads: false,
        filter: { inMailbox: subscriber.inboxMailboxId, notKeyword: '$seen' },
        limit: 1,
        position: 0,
      },
      'unreadQuery',
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
        properties: ['id', 'threadId', 'mailboxIds', 'keywords', 'receivedAt', 'from', 'subject', 'preview'],
      },
      'get',
    ],
  ];

  if (activeNotificationEmailIds.length) {
    methodCalls.push([
      'Email/get',
      {
        accountId: subscriber.accountId,
        ids: activeNotificationEmailIds,
        properties: ['id', 'mailboxIds', 'keywords'],
      },
      'activeNotifications',
    ]);
  }

  const responses = await jmapRequest(subscriber.apiUrl, subscriber.jmapToken, methodCalls);
  const mailboxResponse = findMethodResponse(responses, 'Mailbox/get');
  const queryResponse = findMethodResponse(responses, 'Email/query');
  const unreadQueryResponse = findMethodResponse(responses, 'Email/query', 'unreadQuery');
  const emailResponse = findMethodResponse(responses, 'Email/get');
  const activeNotificationResponse = findMethodResponse(responses, 'Email/get', 'activeNotifications');
  const previousInboxUnreadEmails = normalizeNullableCount(subscriber.lastInboxUnreadEmails);
  const previousInboxStateSignature = subscriber.lastInboxStateSignature;
  const mailboxUnreadEmails = getMailboxUnreadEmails(mailboxResponse?.[1]?.list?.[0]);
  const unreadQueryEmails = getUnreadQueryTotal(unreadQueryResponse?.[1]);
  const inboxUnreadEmails = unreadQueryEmails ?? mailboxUnreadEmails;
  const inboxUnreadEmailsSource = unreadQueryEmails === null ? 'mailbox' : 'email-query';
  const queryIds = queryResponse?.[1]?.ids ?? [];
  const emails = sortEmails(emailResponse?.[1]?.list ?? [], queryIds);
  const inboxStateSignature = getInboxStateSignature(emails, inboxUnreadEmails);
  const knownIds = new Set(subscriber.knownInboxEmailIds);
  const newEmails = emails.filter((email) =>
    !knownIds.has(email.id) &&
    isUnreadEmail(email) &&
    isReceivedAfterPreviousInboxCheck(email, subscriber)
  );
  const currentUnreadEmailIds = emails.filter(isUnreadEmail).map((email) => email.id);
  const staleNotificationEmailIds = getStaleNotificationEmailIds(
    activeNotificationEmailIds,
    activeNotificationResponse?.[1],
    subscriber.inboxMailboxId
  );
  const localActionSuppressed = notify && hasActiveLocalActionSuppression(subscriber) && !newEmails.length;
  const nextActiveNotificationEmailIds = withoutIds(
    notify
      ? activeNotificationEmailIds
      : mergeNotificationIds(activeNotificationEmailIds, currentUnreadEmailIds),
    staleNotificationEmailIds
  );

  subscriber.knownInboxEmailIds = mergeKnownIds(subscriber.knownInboxEmailIds, queryIds);
  subscriber.activeNotificationEmailIds = notify
    ? activeNotificationEmailIds
    : nextActiveNotificationEmailIds;
  subscriber.lastInboxCheckedAt = new Date().toISOString();
  subscriber.lastInboxCheckReason = reason;
  subscriber.lastInboxEmailIds = queryIds;
  subscriber.lastNewInboxEmailIds = newEmails.map((email) => email.id);
  subscriber.lastInboxStateSignature = inboxStateSignature;
  subscriber.lastMailboxUnreadEmails = mailboxUnreadEmails;
  subscriber.lastInboxUnreadEmails = inboxUnreadEmails;
  subscriber.lastInboxUnreadEmailsSource = inboxUnreadEmailsSource;
  subscriber.lastNotificationDismissalEmailIds = staleNotificationEmailIds;
  subscriber.status = `inbox checked (${reason}) at ${subscriber.lastInboxCheckedAt}`;
  await saveStore();

  if (newEmails.length) {
    try {
      await fetchAndCacheBodies({
        accountId: subscriber.accountId,
        apiUrl: subscriber.apiUrl,
        messageIds: newEmails.map((email) => email.id),
        token: subscriber.jmapToken,
      });
      subscriber.lastBodyCacheArrivalAt = new Date().toISOString();
    } catch (error) {
      subscriber.lastBodyCacheError = describeError(error);
      console.warn('[relay] arrival body cache failed', subscriber.deviceId, error);
    }
    await saveStore();
  }

  let dismissed = 0;
  let badgeSynced = false;
  let stateSynced = false;

  if (notify && !localActionSuppressed) {
    for (const emailId of staleNotificationEmailIds) {
      await sendInboxNotificationDismissal(subscriber, emailId, inboxUnreadEmails);
      dismissed += 1;
    }

    subscriber.activeNotificationEmailIds = nextActiveNotificationEmailIds;
    await saveStore();
  } else if (localActionSuppressed) {
    subscriber.lastLocalActionAt = new Date().toISOString();
    await saveStore();
  }

  const didSendBadgeBearingNotification = newEmails.length > 0 || staleNotificationEmailIds.length > 0;
  const shouldSyncInboxState =
    notify &&
    !localActionSuppressed &&
    Boolean(previousInboxStateSignature) &&
    inboxStateSignature !== previousInboxStateSignature &&
    !newEmails.length;

  if (shouldSyncInboxState) {
    await sendInboxStateSync(subscriber, {
      emails,
      inboxUnreadEmails,
      mailboxName: subscriber.mailboxName,
    });
    stateSynced = true;
  } else if (
    notify &&
    inboxUnreadEmails !== null &&
    inboxUnreadEmails !== previousInboxUnreadEmails &&
    !localActionSuppressed &&
    !didSendBadgeBearingNotification
  ) {
    await sendInboxBadgeSync(subscriber, inboxUnreadEmails);
    badgeSynced = true;
  }

  if (!notify || !newEmails.length) {
    return {
      badgeSynced,
      checkedIds: queryIds,
      dismissed,
      dismissedIds: staleNotificationEmailIds,
      inboxUnreadEmails,
      inboxUnreadEmailsSource,
      mailboxUnreadEmails,
      newIds: newEmails.map((email) => email.id),
      notified: 0,
      stateSynced,
    };
  }

  await sendInboxStateSync(subscriber, {
    emails,
    inboxUnreadEmails,
    mailboxName: subscriber.mailboxName,
  });
  stateSynced = true;

  let notified = 0;

  for (const email of newEmails.reverse()) {
    await sendInboxNotification(subscriber, email, inboxUnreadEmails);
    notified += 1;
  }

  return {
    badgeSynced,
    checkedIds: queryIds,
    dismissed,
    dismissedIds: staleNotificationEmailIds,
    inboxUnreadEmails,
    inboxUnreadEmailsSource,
    mailboxUnreadEmails,
    newIds: newEmails.map((email) => email.id),
    notified,
    stateSynced,
  };
}

function scheduleBodyBackfill(subscriber) {
  const key = createHash('sha256').update(subscriber.jmapToken).digest('hex');
  if (bodyBackfills.has(key)) return;
  const task = delay(500)
    .then(() => backfillInboxBodies(subscriber))
    .catch((error) => {
      subscriber.lastBodyCacheError = describeError(error);
      console.error('[relay] body backfill failed', subscriber.deviceId, error);
      return saveStore();
    })
    .finally(() => bodyBackfills.delete(key));
  bodyBackfills.set(key, task);
}

async function backfillInboxBodies(subscriber) {
  let position = 0;
  let cached = 0;
  let failed = 0;
  subscriber.bodyCacheStatus = 'backfilling';
  subscriber.bodyCacheStartedAt = new Date().toISOString();
  await saveStore();

  while (true) {
    const responses = await jmapRequest(subscriber.apiUrl, subscriber.jmapToken, [[
      'Email/query',
      {
        accountId: subscriber.accountId,
        collapseThreads: false,
        filter: { inMailbox: subscriber.inboxMailboxId },
        limit: BODY_BACKFILL_QUERY_LIMIT,
        position,
        sort: [{ property: 'receivedAt', isAscending: false }],
      },
      'bodyBackfillQuery',
    ]]);
    const ids = findMethodResponse(responses, 'Email/query', 'bodyBackfillQuery')?.[1]?.ids ?? [];
    if (!ids.length) break;

    // Backfill establishes the account baseline as well as warming bodies.
    // Without this, an old unread message entering the top query window looks
    // indistinguishable from a newly delivered message and triggers a push.
    subscriber.knownInboxEmailIds = mergeKnownIds(subscriber.knownInboxEmailIds, ids);
    await saveStore();

    for (let index = 0; index < ids.length; index += BODY_CACHE_BATCH_SIZE) {
      const batch = ids.slice(index, index + BODY_CACHE_BATCH_SIZE);
      try {
        const emails = await fetchAndCacheBodies({
          accountId: subscriber.accountId,
          apiUrl: subscriber.apiUrl,
          messageIds: batch,
          token: subscriber.jmapToken,
        });
        cached += emails.length;
      } catch (error) {
        failed += batch.length;
        subscriber.lastBodyCacheError = describeError(error);
      }
      subscriber.bodyCacheCached = cached;
      subscriber.bodyCacheFailed = failed;
      subscriber.bodyCacheScanned = position + index + batch.length;
      await saveStore();
      await delay(BODY_BACKFILL_BATCH_DELAY_MS);
    }

    position += ids.length;
    if (ids.length < BODY_BACKFILL_QUERY_LIMIT) break;
  }

  subscriber.bodyCacheCompletedAt = new Date().toISOString();
  subscriber.bodyCacheStatus = failed ? 'complete-with-errors' : 'complete';
  await saveStore();
  console.log('[relay] body backfill complete', JSON.stringify({ deviceId: subscriber.deviceId, cached, failed }));
}

async function sendInboxNotification(subscriber, email, inboxUnreadEmails) {
  const from = email.from?.[0];
  const sender = from?.name || from?.email || 'New mail';
  const subject = email.subject || '(No subject)';
  const body = email.preview || `New message in ${subscriber.mailboxName}`;

  await sendExpoPush(subscriber, {
    ...(inboxUnreadEmails === null ? {} : { badge: inboxUnreadEmails }),
    body,
    categoryId: INBOX_MESSAGE_NOTIFICATION_CATEGORY_ID,
    collapseId: email.id,
    data: {
      accountId: subscriber.accountId,
      date: email.receivedAt ?? '',
      fromEmail: from?.email ?? '',
      inboxUnreadEmails,
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

  subscriber.activeNotificationEmailIds = mergeNotificationIds(
    subscriber.activeNotificationEmailIds,
    [email.id]
  );
  subscriber.lastNotificationAt = new Date().toISOString();
  subscriber.lastNotificationTitle = `${sender}: ${subject}`;
  await saveStore();
}

async function sendInboxNotificationDismissal(subscriber, emailId, inboxUnreadEmails) {
  await sendExpoPush(subscriber, {
    _contentAvailable: true,
    collapseId: emailId,
    data: {
      action: 'dismiss-message-notification',
      messageId: emailId,
      source: 'jmap',
      type: 'dismiss-message-notification',
    },
  });

  subscriber.lastNotificationDismissalAt = new Date().toISOString();
  await saveStore();
}

async function sendInboxBadgeSync(subscriber, inboxUnreadEmails) {
  await sendExpoPush(subscriber, {
    _contentAvailable: true,
    data: {
      action: 'sync-inbox-badge',
      inboxUnreadEmails,
      source: 'jmap',
      type: 'sync-inbox-badge',
    },
  });

  subscriber.lastBadgeSyncAt = new Date().toISOString();
  await saveStore();
}

async function sendInboxStateSync(subscriber, { emails, inboxUnreadEmails, mailboxName }) {
  await sendExpoPush(subscriber, {
    _contentAvailable: true,
    data: {
      accountId: subscriber.accountId,
      action: 'sync-inbox-state',
      inboxUnreadEmails,
      mailboxId: subscriber.inboxMailboxId,
      mailboxName,
      messages: emails.map(toInboxStateSyncMessage),
      source: 'jmap',
      type: 'sync-inbox-state',
    },
  });

  subscriber.lastInboxStateSyncAt = new Date().toISOString();
  await saveStore();
}

async function sendExpoPush(subscriber, message) {
  const shouldPlaySound = !message._contentAvailable && !Object.hasOwn(message, 'sound');
  const response = await fetch(EXPO_PUSH_URL, {
    body: JSON.stringify({
      ...(shouldPlaySound ? { sound: 'default' } : {}),
      ...message,
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

  assertExpoPushTicketOk(payload);

  subscriber.lastPushTicketId = getExpoPushTicketId(payload) ?? subscriber.lastPushTicketId;
  await saveStore();
  console.log(
    '[relay] sent notification',
    subscriber.deviceId,
    message.title ?? message.data?.action ?? 'background',
    message.subtitle ?? message.data?.messageId ?? ''
  );
  return payload;
}

function assertExpoPushTicketOk(payload) {
  const tickets = Array.isArray(payload?.data) ? payload.data : payload?.data ? [payload.data] : [];
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  const failedTicket = tickets.find((ticket) => ticket?.status === 'error');
  const requestError = errors[0];

  if (!failedTicket && !requestError) {
    return;
  }

  const error = failedTicket ?? requestError;
  const detailCode = error?.details?.error ? ` (${error.details.error})` : '';
  const message = error?.message ?? JSON.stringify(error);

  throw new Error(`Expo push ticket error${detailCode}: ${message}`);
}

function getExpoPushTicketId(payload) {
  const ticket = Array.isArray(payload?.data) ? payload.data[0] : payload?.data;

  return typeof ticket?.id === 'string' ? ticket.id : null;
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

function findMethodResponse(responses, name, callId) {
  return responses.find((response) => response[0] === name && (!callId || response[2] === callId)) ?? null;
}

function sortEmails(emails, ids) {
  const byId = new Map(emails.map((email) => [email.id, email]));

  return ids.map((id) => byId.get(id)).filter(Boolean);
}

function mergeKnownIds(currentIds, nextIds) {
  return Array.from(new Set([...nextIds, ...currentIds])).slice(0, KNOWN_INBOX_EMAIL_LIMIT);
}

function isReceivedAfterPreviousInboxCheck(email, subscriber) {
  const baseline = Date.parse(subscriber.lastInboxCheckedAt ?? subscriber.registeredAt ?? '');
  const receivedAt = Date.parse(email.receivedAt ?? '');
  if (!Number.isFinite(baseline) || !Number.isFinite(receivedAt)) return false;
  return receivedAt >= baseline - NEW_EMAIL_CLOCK_SKEW_MS;
}

function mergeNotificationIds(currentIds, nextIds) {
  return Array.from(new Set([...normalizeIdList(nextIds), ...normalizeIdList(currentIds)])).slice(
    0,
    ACTIVE_NOTIFICATION_LIMIT
  );
}

function normalizeIdList(ids) {
  return Array.isArray(ids)
    ? ids.filter((id) => typeof id === 'string' && id.length > 0)
    : [];
}

function hasActiveLocalActionSuppression(subscriber) {
  return typeof subscriber.localActionSuppressUntil === 'number' && subscriber.localActionSuppressUntil > Date.now();
}

function withoutIds(ids, removedIds) {
  const removedIdSet = new Set(removedIds);

  return ids.filter((id) => !removedIdSet.has(id));
}

function getStaleNotificationEmailIds(activeNotificationEmailIds, emailGetPayload, inboxMailboxId) {
  if (!activeNotificationEmailIds.length || !emailGetPayload) {
    return [];
  }

  const emailById = new Map((emailGetPayload.list ?? []).map((email) => [email.id, email]));
  const notFoundIds = new Set(emailGetPayload.notFound ?? []);

  return activeNotificationEmailIds.filter((emailId) => {
    const email = emailById.get(emailId);

    return notFoundIds.has(emailId) || !email || !email.mailboxIds?.[inboxMailboxId] || !isUnreadEmail(email);
  });
}

function isUnreadEmail(email) {
  return !email.keywords?.$seen;
}

function getInboxStateSignature(emails, inboxUnreadEmails) {
  return JSON.stringify({
    ids: emails.map((email) => email.id),
    unread: emails.map((email) => [email.id, isUnreadEmail(email)]),
    inboxUnreadEmails,
  });
}

function toInboxStateSyncMessage(email) {
  const from = email.from?.[0];
  const sender = from?.name || from?.email || 'New mail';

  return {
    date: email.receivedAt ?? '',
    fromEmail: from?.email ?? '',
    keywords: email.keywords ?? {},
    mailboxIds: email.mailboxIds ?? {},
    messageId: email.id,
    preview: email.preview ?? '',
    sender,
    subject: email.subject || '(No subject)',
    threadId: email.threadId ?? '',
  };
}

function getMailboxUnreadEmails(mailbox) {
  const unreadEmails = mailbox?.unreadEmails;

  return normalizeNullableCount(unreadEmails);
}

function getUnreadQueryTotal(queryPayload) {
  return normalizeNullableCount(queryPayload?.total);
}

function normalizeNullableCount(value) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : null;
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

function requireDiagnosticAuthorization(request, response) {
  if (!DIAGNOSTIC_TOKEN) {
    sendJson(response, 503, { error: 'Diagnostic access is not configured.' });
    return false;
  }
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  const expectedBuffer = Buffer.from(DIAGNOSTIC_TOKEN);
  const suppliedBuffer = Buffer.from(supplied);
  const authorized = expectedBuffer.length === suppliedBuffer.length &&
    timingSafeEqual(expectedBuffer, suppliedBuffer);
  if (!authorized) sendJson(response, 401, { error: 'Unauthorized.' });
  return authorized;
}

function getRequiredString(body, key) {
  const value = body?.[key];

  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Missing ${key}.`);
  }

  return value.trim();
}

function getOptionalString(body, key) {
  const value = body?.[key];

  return typeof value === 'string' && value.trim() ? value.trim() : null;
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

function toPublicSubscriber(subscriber, options = {}) {
  const publicSubscriber = {
    accountId: subscriber.accountId,
    activeNotificationEmailIds: normalizeIdList(subscriber.activeNotificationEmailIds).length,
    deviceId: subscriber.deviceId,
    eventSource: Boolean(subscriber.eventSourceUrl),
    inboxMailboxId: subscriber.inboxMailboxId,
    knownInboxEmailIds: subscriber.knownInboxEmailIds.length,
    lastEventAt: subscriber.lastEventAt ?? null,
    lastEventType: subscriber.lastEventType ?? null,
    lastInboxCheckedAt: subscriber.lastInboxCheckedAt ?? null,
    lastInboxCheckReason: subscriber.lastInboxCheckReason ?? null,
    lastNewInboxEmailIds: subscriber.lastNewInboxEmailIds?.length ?? 0,
    lastInboxUnreadEmails: subscriber.lastInboxUnreadEmails ?? null,
    lastInboxUnreadEmailsSource: subscriber.lastInboxUnreadEmailsSource ?? null,
    lastInboxStateSyncAt: subscriber.lastInboxStateSyncAt ?? null,
    lastLocalActionAt: subscriber.lastLocalActionAt ?? null,
    localActionSuppressed: hasActiveLocalActionSuppression(subscriber),
    lastMailboxUnreadEmails: subscriber.lastMailboxUnreadEmails ?? null,
    lastBadgeSyncAt: subscriber.lastBadgeSyncAt ?? null,
    lastNotificationDismissalAt: subscriber.lastNotificationDismissalAt ?? null,
    lastNotificationDismissalEmailIds: subscriber.lastNotificationDismissalEmailIds?.length ?? 0,
    lastNotificationAt: subscriber.lastNotificationAt ?? null,
    lastPushTicketId: subscriber.lastPushTicketId ?? null,
    mailboxName: subscriber.mailboxName,
    pollingMs: subscriber.pollTimer ? FALLBACK_POLL_MS : null,
    status: subscriber.status,
    username: subscriber.username,
    bodyCacheStatus: subscriber.bodyCacheStatus ?? 'not-started',
    bodyCacheScanned: subscriber.bodyCacheScanned ?? 0,
    bodyCacheCached: subscriber.bodyCacheCached ?? 0,
    bodyCacheFailed: subscriber.bodyCacheFailed ?? 0,
    bodyCacheCompletedAt: subscriber.bodyCacheCompletedAt ?? null,
    lastBodyCacheArrivalAt: subscriber.lastBodyCacheArrivalAt ?? null,
  };

  if (options.includeDebug) {
    publicSubscriber.lastEventId = subscriber.lastEventId ?? null;
    publicSubscriber.lastInboxEmailIds = subscriber.lastInboxEmailIds ?? [];
    publicSubscriber.lastNewInboxEmailIds = subscriber.lastNewInboxEmailIds ?? [];
    publicSubscriber.activeNotificationEmailIdsPreview = normalizeIdList(
      subscriber.activeNotificationEmailIds
    ).slice(0, 20);
    publicSubscriber.knownInboxEmailIdsPreview = subscriber.knownInboxEmailIds.slice(0, 20);
    publicSubscriber.lastNotificationDismissalEmailIds = subscriber.lastNotificationDismissalEmailIds ?? [];
    publicSubscriber.lastNotificationTitle = subscriber.lastNotificationTitle ?? null;
    publicSubscriber.lastLocalActionMessageIds = subscriber.lastLocalActionMessageIds ?? [];
    publicSubscriber.lastBodyCacheError = subscriber.lastBodyCacheError ?? null;
  }

  return publicSubscriber;
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
      subscriber.activeNotificationEmailIds = normalizeIdList(subscriber.activeNotificationEmailIds);
      subscriber.knownInboxEmailIds = normalizeIdList(subscriber.knownInboxEmailIds);
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

async function appendObservabilityEvents(events) {
  await mkdir(path.dirname(OBSERVABILITY_LOG_PATH), { recursive: true });
  await appendFile(
    OBSERVABILITY_LOG_PATH,
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
  );
}

async function readRecentObservabilityEvents(limit) {
  const text = await readFile(OBSERVABILITY_LOG_PATH, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') {
      return '';
    }

    throw error;
  });
  const lines = text.trim().split('\n').filter(Boolean).slice(-limit);

  return lines.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { parseError: true, raw: line.slice(0, 500) };
    }
  });
}

function normalizeObservabilityEvents(body) {
  const deviceId = sanitizeDeviceId(getOptionalString(body, 'deviceId') ?? 'unknown');
  const platform = getOptionalString(body, 'platform') ?? 'unknown';
  const appVersion = getOptionalString(body, 'appVersion');
  const rawEvents = Array.isArray(body?.events) ? body.events : [];

  return rawEvents
    .slice(0, 50)
    .map((event) => normalizeObservabilityEvent(event, { appVersion, deviceId, platform }))
    .filter(Boolean);
}

function normalizeObservabilityEvent(event, envelope) {
  if (!event || typeof event !== 'object') {
    return null;
  }

  const name = getOptionalString(event, 'name');

  if (!name) {
    return null;
  }

  return {
    appVersion: envelope.appVersion,
    at: getOptionalString(event, 'at') ?? new Date().toISOString(),
    deviceId: envelope.deviceId,
    id: getOptionalString(event, 'id') ?? null,
    level: getOptionalString(event, 'level') ?? 'info',
    name: name.slice(0, 120),
    platform: envelope.platform,
    properties: normalizeObservabilityProperties(event.properties),
    serverAt: new Date().toISOString(),
  };
}

function normalizeObservabilityProperties(properties) {
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    return {};
  }

  const normalized = {};

  for (const [key, value] of Object.entries(properties).slice(0, 60)) {
    if (
      value === null ||
      typeof value === 'boolean' ||
      typeof value === 'number'
    ) {
      normalized[key.slice(0, 80)] = value;
    } else if (typeof value === 'string') {
      normalized[key.slice(0, 80)] = value.slice(0, 500);
    }
  }

  return normalized;
}
