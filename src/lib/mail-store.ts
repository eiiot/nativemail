import { create } from 'zustand';

import {
  readCachedEmailBody,
  readCachedMailboxSnapshot,
  writeCachedEmailBody,
} from '@/lib/mail-cache';
import {
  fetchJmapMessageBody,
  type JmapMailboxSnapshot,
  type JmapMessageBody,
  type JmapThread,
} from '@/lib/jmap-client';
import type { Message } from '@/lib/mock-mail';
import { observeDuration, observeError, observeEvent } from '@/lib/observability';

type MessagePatch = Pick<Partial<Message>, 'keywords' | 'pinned' | 'unread'>;

const LOCAL_ACTION_REFRESH_SUPPRESSION_MS = 8000;
const SLOW_FOREGROUND_BODY_FETCH_MS = 1000;
const BACKGROUND_MESSAGE_BODY_NETWORK_FETCHES_ENABLED = false;
// Capped at 2 (was 3): combined with the transport-level read-retry, 3 body
// attempts could stack into a ~18s retry storm at cold start when each attempt
// hit a hanging connection. With one reused connection (kept warm + flushed on
// foreground) retries should rarely fire; bound the worst case regardless.
const FOREGROUND_MESSAGE_BODY_FETCH_MAX_ATTEMPTS = 2;
const FOREGROUND_MESSAGE_BODY_FETCH_RETRY_DELAYS_MS = [120, 350];

type MessageBodyFetchPriority = 'background' | 'foreground';

type MessageBodyFetchEntry = {
  controller: AbortController;
  priority: MessageBodyFetchPriority;
  promise: Promise<JmapMessageBody | null>;
  startedAt: number;
};

const messageBodyFetches = new Map<string, MessageBodyFetchEntry>();
const foregroundSlowProbeTimers = new Map<string, ReturnType<typeof setTimeout>>();
let localMailActionSuppressUntil = 0;
let foregroundMessageBodyFetchCount = 0;
let foregroundMessageBodyFetchLastActivityAt = 0;

function getMessageBodyFetchCounts() {
  let background = 0;
  let foreground = 0;

  for (const fetchEntry of messageBodyFetches.values()) {
    if (fetchEntry.priority === 'foreground') {
      foreground += 1;
    } else {
      background += 1;
    }
  }

  return {
    background,
    foreground,
    foregroundMessageBodyFetchCount,
    total: messageBodyFetches.size,
  };
}

export function getForegroundMessageBodyFetchStatus() {
  return {
    activeCount: foregroundMessageBodyFetchCount,
    lastActivityAt: foregroundMessageBodyFetchLastActivityAt,
  };
}

function armForegroundBodySlowProbe({
  messageId,
  reason,
  refresh,
  startedAt,
}: {
  messageId: string;
  reason: string;
  refresh: boolean;
  startedAt: number;
}) {
  if (foregroundSlowProbeTimers.has(messageId)) {
    observeEvent('mail.body.fetch.foreground-probe.already-armed', {
      ...getMessageBodyFetchCounts(),
      ageMs: Math.max(0, Date.now() - startedAt),
      messageId,
      reason,
      refresh,
    });
    return;
  }

  const delayMs = Math.max(0, SLOW_FOREGROUND_BODY_FETCH_MS - (Date.now() - startedAt));

  observeEvent('mail.body.fetch.foreground-probe.armed', {
    ...getMessageBodyFetchCounts(),
    ageMs: Math.max(0, Date.now() - startedAt),
    delayMs,
    messageId,
    reason,
    refresh,
  });

  const timer = setTimeout(() => {
    foregroundSlowProbeTimers.delete(messageId);

    // Record that a foreground body fetch crossed the slow threshold, but do
    // NOT fire diagnostic probe requests: those were raw fetches with no
    // timeout that piled onto an already-stuck connection (one hung ~7
    // minutes). The transport-level timeout now bounds slow fetches instead.
    observeEvent('mail.body.fetch.foreground-slow', {
      ...getMessageBodyFetchCounts(),
      durationMs: Math.max(0, Date.now() - startedAt),
      messageId,
      reason,
      refresh,
    }, 'warn');
  }, delayMs);

  foregroundSlowProbeTimers.set(messageId, timer);
}

function clearForegroundBodySlowProbe(messageId: string) {
  const timer = foregroundSlowProbeTimers.get(messageId);

  if (!timer) {
    return;
  }

  clearTimeout(timer);
  foregroundSlowProbeTimers.delete(messageId);
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown) {
  if (error instanceof Error) {
    return error.name === 'AbortError';
  }

  return false;
}

function isRetriableMessageBodyFetchError(error: unknown) {
  const message = getErrorMessage(error).toLowerCase();

  return (
    message.includes('network connection was lost') ||
    message.includes('network request failed') ||
    message.includes('fetch failed') ||
    message.includes('timed out') ||
    message.includes('the request timed out') ||
    message.includes('offline') ||
    message.includes('connection reset') ||
    message.includes('connection closed')
  );
}

function createBodyFetchRetryAbortError() {
  const error = new Error('Body fetch retry aborted');
  error.name = 'AbortError';
  return error;
}

function delayMessageBodyRetry(delayMs: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(createBodyFetchRetryAbortError());
      return;
    }

    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);

    const onAbort = () => {
      clearTimeout(timeout);
      reject(createBodyFetchRetryAbortError());
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchJmapMessageBodyWithRetry({
  messageId,
  priority,
  signal,
}: {
  messageId: string;
  priority: MessageBodyFetchPriority;
  signal?: AbortSignal;
}) {
  const maxAttempts = priority === 'foreground' ? FOREGROUND_MESSAGE_BODY_FETCH_MAX_ATTEMPTS : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptStartedAt = Date.now();

    try {
      if (attempt > 1) {
        observeEvent('mail.body.fetch.retry.start', {
          ...getMessageBodyFetchCounts(),
          attempt,
          maxAttempts,
          messageId,
          priority,
        });
      }

      const body = await fetchJmapMessageBody({
        inlineCidImageData: false,
        messageId,
        signal,
      });

      if (attempt > 1) {
        observeDuration('mail.body.fetch.retry.success', attemptStartedAt, {
          attempt,
          hasBody: Boolean(body),
          html: body?.html?.trim() ? body.html.length : 0,
          maxAttempts,
          messageId,
          priority,
          text: body?.text?.trim() ? body.text.length : 0,
        });
      }

      return body;
    } catch (error: unknown) {
      const canRetry =
        attempt < maxAttempts &&
        !signal?.aborted &&
        !isAbortError(error) &&
        isRetriableMessageBodyFetchError(error);

      observeError('mail.body.fetch.attempt.failed', error, {
        ...getMessageBodyFetchCounts(),
        attempt,
        canRetry,
        messageId,
        priority,
      });

      if (!canRetry) {
        throw error;
      }

      const delayMs =
        FOREGROUND_MESSAGE_BODY_FETCH_RETRY_DELAYS_MS[
          Math.min(attempt - 1, FOREGROUND_MESSAGE_BODY_FETCH_RETRY_DELAYS_MS.length - 1)
        ] ?? 0;

      observeEvent('mail.body.fetch.retry.scheduled', {
        ...getMessageBodyFetchCounts(),
        attempt: attempt + 1,
        delayMs,
        messageId,
        priority,
      });

      await delayMessageBodyRetry(delayMs, signal);
    }
  }

  return null;
}

type MailStoreState = {
  hiddenMailboxMessageIds: Record<string, Record<string, true>>;
  messageBodies: Record<string, JmapMessageBody>;
  snapshots: Record<string, JmapMailboxSnapshot>;
  threads: Record<string, JmapThread>;
  applyMailboxSnapshot: (snapshot: JmapMailboxSnapshot, mailboxId?: string | null) => void;
  applyMessageBody: (messageId: string, body: JmapMessageBody) => void;
  clearHiddenMessageInMailbox: (messageId: string, mailboxId?: string | null) => void;
  hideMessageInMailbox: (messageId: string, mailboxId?: string | null) => void;
  patchMessage: (messageId: string, patch: MessagePatch) => void;
  removeMessageFromMailbox: (messageId: string, mailboxId?: string | null) => void;
};

export const useMailStore = create<MailStoreState>((set) => ({
  hiddenMailboxMessageIds: {},
  messageBodies: {},
  snapshots: {},
  threads: {},
  applyMailboxSnapshot: (snapshot, mailboxId) => {
    set((state) => {
      const messageBodies = { ...state.messageBodies };
      const snapshots = { ...state.snapshots };
      const nextSnapshot = filterHiddenMailboxMessages(snapshot, mailboxId, state.hiddenMailboxMessageIds);
      const threads = { ...state.threads, ...(nextSnapshot.threads ?? {}) };

      for (const key of getSnapshotKeys(nextSnapshot, mailboxId)) {
        snapshots[key] = nextSnapshot;
      }

      for (const message of nextSnapshot.messages) {
        const body = getMessageBodyFromMessage(message);

        if (body) {
          messageBodies[message.id] = mergeMessageBodies(messageBodies[message.id], body);
        }
      }

      return { messageBodies, snapshots, threads };
    });
  },
  clearHiddenMessageInMailbox: (messageId, mailboxId) => {
    set((state) => {
      const key = getMailboxSnapshotKey(mailboxId);
      const hiddenForMailbox = state.hiddenMailboxMessageIds[key];

      if (!hiddenForMailbox?.[messageId]) {
        return state;
      }

      const nextHiddenForMailbox = { ...hiddenForMailbox };
      delete nextHiddenForMailbox[messageId];

      const hiddenMailboxMessageIds = { ...state.hiddenMailboxMessageIds };

      if (Object.keys(nextHiddenForMailbox).length) {
        hiddenMailboxMessageIds[key] = nextHiddenForMailbox;
      } else {
        delete hiddenMailboxMessageIds[key];
      }

      return { hiddenMailboxMessageIds };
    });
  },
  hideMessageInMailbox: (messageId, mailboxId) => {
    set((state) => {
      const key = getMailboxSnapshotKey(mailboxId);
      const hiddenForMailbox = state.hiddenMailboxMessageIds[key] ?? {};
      const hiddenMailboxMessageIds = {
        ...state.hiddenMailboxMessageIds,
        [key]: {
          ...hiddenForMailbox,
          [messageId]: true as true,
        },
      };
      const snapshot = state.snapshots[key];

      if (!snapshot) {
        return { hiddenMailboxMessageIds };
      }

      const nextSnapshot = {
        ...snapshot,
        messages: snapshot.messages.filter((message) => message.id !== messageId),
      };
      const snapshots = { ...state.snapshots };

      for (const snapshotKey of getSnapshotKeys(nextSnapshot, mailboxId)) {
        snapshots[snapshotKey] = nextSnapshot;
      }

      return { hiddenMailboxMessageIds, snapshots };
    });
  },
  applyMessageBody: (messageId, body) => {
    set((state) => {
      const currentBody = state.messageBodies[messageId];

      return {
        messageBodies: {
          ...state.messageBodies,
          [messageId]: mergeMessageBodies(currentBody, body),
        },
      };
    });
  },
  patchMessage: (messageId, patch) => {
    set((state) => ({
      snapshots: mapSnapshots(state.snapshots, (snapshot) => ({
        ...snapshot,
        messages: snapshot.messages.map((message) =>
          message.id === messageId ? patchMessage(message, patch) : message,
        ),
        threads: snapshot.threads ? patchThreads(snapshot.threads, messageId, patch) : snapshot.threads,
      })),
      threads: patchThreads(state.threads, messageId, patch),
    }));
  },
  removeMessageFromMailbox: (messageId, mailboxId) => {
    set((state) => {
      const key = getMailboxSnapshotKey(mailboxId);
      const snapshot = state.snapshots[key];

      if (!snapshot) {
        return state;
      }

      const nextSnapshot = {
        ...snapshot,
        messages: snapshot.messages.filter((message) => message.id !== messageId),
      };
      const snapshots = { ...state.snapshots };

      for (const snapshotKey of getSnapshotKeys(nextSnapshot, mailboxId)) {
        snapshots[snapshotKey] = nextSnapshot;
      }

      return { snapshots };
    });
  },
}));

export function selectMailboxSnapshot(
  state: MailStoreState,
  mailboxId?: string | null,
) {
  return state.snapshots[getMailboxSnapshotKey(mailboxId)] ?? null;
}

export function selectMessageBody(
  state: MailStoreState,
  messageId?: string | null,
) {
  return messageId ? state.messageBodies[messageId] ?? null : null;
}

export function selectThread(
  state: MailStoreState,
  threadId?: string | null,
) {
  return threadId ? state.threads[threadId] ?? null : null;
}

export async function hydrateMailboxSnapshotFromCache(mailboxId?: string | null) {
  const snapshot = await readCachedMailboxSnapshot({ mailboxId });

  if (snapshot) {
    useMailStore.getState().applyMailboxSnapshot(snapshot, mailboxId);
  }

  return snapshot;
}

export function recordLocalMailAction() {
  localMailActionSuppressUntil = Math.max(
    localMailActionSuppressUntil,
    Date.now() + LOCAL_ACTION_REFRESH_SUPPRESSION_MS,
  );
}

export function getLocalMailActionRefreshSuppressionRemainingMs() {
  return Math.max(0, localMailActionSuppressUntil - Date.now());
}

export function isLocalMailActionRefreshSuppressed() {
  return getLocalMailActionRefreshSuppressionRemainingMs() > 0;
}

export async function hydrateMessageBodyFromCache(messageId: string) {
  const currentBody = selectMessageBody(useMailStore.getState(), messageId);

  if (currentBody) {
    return currentBody;
  }

  const body = await readCachedEmailBody(messageId);

  if (body) {
    useMailStore.getState().applyMessageBody(messageId, body);
  }

  return body;
}

export async function loadMessageBody(
  messageId: string,
  {
    priority = 'foreground',
    refresh = false,
  }: {
    priority?: MessageBodyFetchPriority;
    refresh?: boolean;
  } = {},
) {
  const startedAt = Date.now();

  observeEvent('mail.body.load.start', {
    ...getMessageBodyFetchCounts(),
    messageId,
    priority,
    refresh,
  });

  if (priority === 'background' && !BACKGROUND_MESSAGE_BODY_NETWORK_FETCHES_ENABLED) {
    const cachedOrMemoryBody = await hydrateMessageBodyFromCache(messageId);

    observeEvent('mail.body.fetch.background-network-disabled', {
      ...getMessageBodyFetchCounts(),
      hasBody: Boolean(cachedOrMemoryBody),
      html: cachedOrMemoryBody?.html?.trim() ? cachedOrMemoryBody.html.length : 0,
      messageId,
      refresh,
      text: cachedOrMemoryBody?.text?.trim() ? cachedOrMemoryBody.text.length : 0,
    });

    return cachedOrMemoryBody;
  }

  if (!refresh) {
    const cachedOrMemoryBody = await hydrateMessageBodyFromCache(messageId);

    if (cachedOrMemoryBody) {
      observeDuration('mail.body.load.cache-hit', startedAt, {
        html: cachedOrMemoryBody.html?.trim() ? cachedOrMemoryBody.html.length : 0,
        messageId,
        priority,
        refresh,
        text: cachedOrMemoryBody.text?.trim() ? cachedOrMemoryBody.text.length : 0,
      });
      return cachedOrMemoryBody;
    }
  }

  const existingFetch = messageBodyFetches.get(messageId);

  if (existingFetch) {
    const joinStartedAt = Date.now();

    observeEvent('mail.body.fetch.join', {
      ...getMessageBodyFetchCounts(),
      existingPriority: existingFetch.priority,
      messageId,
      priority,
      refresh,
    });

    if (priority === 'foreground') {
      foregroundMessageBodyFetchLastActivityAt = Date.now();
      foregroundMessageBodyFetchCount += 1;
      abortBackgroundMessageBodyFetches(messageId);

      if (existingFetch.priority === 'background') {
        existingFetch.priority = 'foreground';
        observeEvent('mail.body.fetch.upgrade', {
          ...getMessageBodyFetchCounts(),
          ageMs: Math.max(0, Date.now() - existingFetch.startedAt),
          messageId,
        });
      }

      armForegroundBodySlowProbe({
        messageId,
        reason: 'joined-existing-fetch',
        refresh,
        startedAt: existingFetch.startedAt,
      });

      return existingFetch.promise
        .then((body) => {
          observeDuration('mail.body.fetch.join.success', joinStartedAt, {
            hasBody: Boolean(body),
            messageId,
            priority,
            text: body?.text?.trim() ? body.text.length : 0,
            html: body?.html?.trim() ? body.html.length : 0,
          });

          return body;
        })
        .catch((error: unknown) => {
          observeError('mail.body.fetch.join.failed', error, {
            messageId,
            priority,
          });
          throw error;
        })
        .finally(() => {
          clearForegroundBodySlowProbe(messageId);
          foregroundMessageBodyFetchLastActivityAt = Date.now();
          foregroundMessageBodyFetchCount = Math.max(0, foregroundMessageBodyFetchCount - 1);
        });
    }

    return existingFetch.promise.then((body) => {
      observeDuration('mail.body.fetch.join.success', joinStartedAt, {
        hasBody: Boolean(body),
        messageId,
        priority,
        text: body?.text?.trim() ? body.text.length : 0,
        html: body?.html?.trim() ? body.html.length : 0,
      });

      return body;
    });
  }

  if (priority === 'foreground') {
    foregroundMessageBodyFetchLastActivityAt = Date.now();
    foregroundMessageBodyFetchCount += 1;
    abortBackgroundMessageBodyFetches(messageId);
  }

  const controller = new AbortController();
  const networkStartedAt = Date.now();

  observeEvent('mail.body.fetch.start', {
    ...getMessageBodyFetchCounts(),
    messageId,
    priority,
    refresh,
  });

  const fetchPromise = fetchJmapMessageBodyWithRetry({
    messageId,
    priority,
    signal: controller.signal,
  })
    .then(async (body) => {
      const finalPriority = messageBodyFetches.get(messageId)?.priority ?? priority;

      observeDuration('mail.body.fetch.success', networkStartedAt, {
        attachments: body?.attachments?.length ?? 0,
        finalPriority,
        hasBody: Boolean(body),
        html: body?.html?.trim() ? body.html.length : 0,
        messageId,
        priority,
        text: body?.text?.trim() ? body.text.length : 0,
      });

      if (body) {
        useMailStore.getState().applyMessageBody(messageId, body);
        const cacheWriteStartedAt = Date.now();

        await writeCachedEmailBody(messageId, body)
          .then(() => {
            observeDuration('mail.body.cache-write.success', cacheWriteStartedAt, {
              finalPriority,
              html: body.html?.trim() ? body.html.length : 0,
              messageId,
              priority,
              text: body.text?.trim() ? body.text.length : 0,
            });
          })
          .catch((error: unknown) => {
            observeError('mail.body.cache-write.failed', error, {
              messageId,
              priority,
            });
          });
      }

      return body;
    })
    .catch((error: unknown) => {
      observeError('mail.body.fetch.failed', error, {
        ...getMessageBodyFetchCounts(),
        finalPriority: messageBodyFetches.get(messageId)?.priority ?? priority,
        messageId,
        priority,
        refresh,
      });
      throw error;
    })
    .finally(() => {
      clearForegroundBodySlowProbe(messageId);

      if (priority === 'foreground') {
        foregroundMessageBodyFetchLastActivityAt = Date.now();
        foregroundMessageBodyFetchCount = Math.max(0, foregroundMessageBodyFetchCount - 1);
      }

      if (messageBodyFetches.get(messageId)?.promise === fetchPromise) {
        messageBodyFetches.delete(messageId);
      }
    });

  messageBodyFetches.set(messageId, {
    controller,
    priority,
    promise: fetchPromise,
    startedAt: networkStartedAt,
  });

  if (priority === 'foreground') {
    armForegroundBodySlowProbe({
      messageId,
      reason: 'started-foreground',
      refresh,
      startedAt: networkStartedAt,
    });
  }

  observeEvent('mail.body.fetch.registered', {
    ...getMessageBodyFetchCounts(),
    messageId,
    priority,
    refresh,
  });

  return fetchPromise;
}

export async function prefetchMessageBodies(
  messageIds: string[],
  {
    concurrency = 2,
    limit = 8,
    source = 'unknown',
  }: {
    concurrency?: number;
    limit?: number;
    source?: string;
  } = {},
) {
  const uniqueIds = Array.from(new Set(messageIds));
  const pendingIds = uniqueIds
    .filter((messageId) => !selectMessageBody(useMailStore.getState(), messageId))
    .slice(0, limit);
  let loaded = 0;
  let failed = 0;
  let cursor = 0;

  observeEvent('mail.body.prefetch.start', {
    concurrency,
    foregroundMessageBodyFetchCount,
    limit,
    pending: pendingIds.length,
    requested: uniqueIds.length,
    source,
  });

  async function runNext() {
    while (cursor < pendingIds.length) {
      if (foregroundMessageBodyFetchCount > 0) {
        observeEvent('mail.body.prefetch.paused-for-foreground', {
          ...getMessageBodyFetchCounts(),
          attempted: cursor,
          pending: pendingIds.length,
          source,
        });
        break;
      }

      const messageId = pendingIds[cursor];
      cursor += 1;

      if (!messageId) {
        continue;
      }

      try {
        const body = await loadMessageBody(messageId, { priority: 'background' });

        if (body) {
          loaded += 1;
        } else {
          failed += 1;
        }
      } catch {
        failed += 1;
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), pendingIds.length) },
      () => runNext(),
    ),
  );

  return {
    attempted: pendingIds.length,
    failed,
    loaded,
    requested: uniqueIds.length,
    skipped: uniqueIds.length - pendingIds.length,
  };
}

function abortBackgroundMessageBodyFetches(exceptMessageId?: string) {
  for (const [messageId, fetchEntry] of messageBodyFetches) {
    if (messageId === exceptMessageId || fetchEntry.priority !== 'background') {
      continue;
    }

    observeEvent('mail.body.fetch.abort-background', {
      ...getMessageBodyFetchCounts(),
      exceptMessageId: exceptMessageId ?? 'none',
      messageId,
    }, 'warn');
    fetchEntry.controller.abort();
    messageBodyFetches.delete(messageId);
  }
}

export function getMailboxSnapshotKey(mailboxId?: string | null) {
  return mailboxId ? `mailbox:${mailboxId}` : 'role:inbox';
}

function getSnapshotKeys(snapshot: JmapMailboxSnapshot, mailboxId?: string | null) {
  const keys = new Set<string>([getMailboxSnapshotKey(mailboxId)]);
  const mailbox = snapshot.mailbox;

  if (mailbox?.id) {
    keys.add(getMailboxSnapshotKey(mailbox.id));
  }

  if (mailbox?.role) {
    keys.add(`role:${mailbox.role}`);
  }

  return keys;
}

function filterHiddenMailboxMessages(
  snapshot: JmapMailboxSnapshot,
  mailboxId: string | null | undefined,
  hiddenMailboxMessageIds: Record<string, Record<string, true>>,
) {
  const hiddenMessageIds = getHiddenMessageIds(snapshot, mailboxId, hiddenMailboxMessageIds);

  if (!hiddenMessageIds.size) {
    return snapshot;
  }

  return {
    ...snapshot,
    messages: snapshot.messages.filter((message) => !hiddenMessageIds.has(message.id)),
  };
}

function getHiddenMessageIds(
  snapshot: JmapMailboxSnapshot,
  mailboxId: string | null | undefined,
  hiddenMailboxMessageIds: Record<string, Record<string, true>>,
) {
  const hiddenMessageIds = new Set<string>();

  for (const key of getSnapshotKeys(snapshot, mailboxId)) {
    const hiddenForMailbox = hiddenMailboxMessageIds[key];

    if (!hiddenForMailbox) {
      continue;
    }

    for (const messageId of Object.keys(hiddenForMailbox)) {
      hiddenMessageIds.add(messageId);
    }
  }

  return hiddenMessageIds;
}

function mapSnapshots(
  snapshots: Record<string, JmapMailboxSnapshot>,
  mapper: (snapshot: JmapMailboxSnapshot) => JmapMailboxSnapshot,
) {
  const nextSnapshots: Record<string, JmapMailboxSnapshot> = {};
  const mappedByReference = new Map<JmapMailboxSnapshot, JmapMailboxSnapshot>();

  for (const [key, snapshot] of Object.entries(snapshots)) {
    let nextSnapshot = mappedByReference.get(snapshot);

    if (!nextSnapshot) {
      nextSnapshot = mapper(snapshot);
      mappedByReference.set(snapshot, nextSnapshot);
    }

    nextSnapshots[key] = nextSnapshot;
  }

  return nextSnapshots;
}

function patchMessage(message: Message, patch: MessagePatch): Message {
  return {
    ...message,
    ...(patch.keywords === undefined ? {} : { keywords: patch.keywords }),
    ...(patch.pinned === undefined ? {} : { pinned: patch.pinned }),
    ...(patch.unread === undefined ? {} : { unread: patch.unread }),
  };
}

function patchThreads(
  threads: Record<string, JmapThread>,
  messageId: string,
  patch: MessagePatch,
) {
  const nextThreads: Record<string, JmapThread> = {};

  for (const [threadId, thread] of Object.entries(threads)) {
    nextThreads[threadId] = {
      ...thread,
      messages: thread.messages.map((message) =>
        message.id === messageId ? patchMessage(message, patch) : message,
      ),
    };
  }

  return nextThreads;
}

function getMessageBodyFromMessage(message: Message): JmapMessageBody | null {
  if (!message.body && !message.htmlBody) {
    return null;
  }

  return {
    attachments: message.attachments ?? [],
    html: message.htmlBody ?? null,
    text: message.body ?? null,
  };
}

function mergeMessageBodies(
  currentBody: JmapMessageBody | undefined,
  nextBody: JmapMessageBody,
): JmapMessageBody {
  if (!currentBody) {
    return nextBody;
  }

  return {
    attachments: nextBody.attachments.length ? nextBody.attachments : currentBody.attachments,
    debug: nextBody.debug ?? currentBody.debug,
    html: getPreferredBodyValue(nextBody.html, currentBody.html),
    text: getPreferredBodyValue(nextBody.text, currentBody.text),
  };
}

function getPreferredBodyValue(nextValue: string | null, currentValue: string | null) {
  return nextValue?.trim() ? nextValue : currentValue;
}
