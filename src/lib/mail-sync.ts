import {
  applyJmapEmailSetBatch,
  archiveJmapEmail,
  getJmapMailboxIdsForRole,
  trashJmapEmail,
  unarchiveJmapEmail,
  type JmapEmailSetNotUpdated,
  type JmapEmailSetPatch,
  type JmapMailbox,
  type JmapMessageActionResult,
} from '@/lib/jmap-client';
import { getForegroundMessageBodyFetchStatus } from '@/lib/mail-store';
import { observeDuration, observeError, observeEvent } from '@/lib/observability';

const mailMutationFlushDebounceMs = 500;
const mailMutationIdleTimeoutMs = 5000;
const mailMutationForegroundBodyQuietMs = 2500;
const mailMutationForegroundBodyPollMs = 250;

type MailMutationRole = 'archive' | 'inbox' | 'trash';

export type MailSyncMutation =
  | {
      currentKeywords?: Record<string, true> | null;
      messageId: string;
      seen: boolean;
      type: 'set-seen';
    }
  | {
      currentKeywords?: Record<string, true> | null;
      flagged: boolean;
      messageId: string;
      type: 'set-flagged';
    }
  | {
      mailboxIds?: Record<string, true> | null;
      mailboxes?: JmapMailbox[] | null;
      messageId: string;
      role: MailMutationRole;
      type: 'move-to-role';
    };

type PendingResolver = {
  reject: (error: unknown) => void;
  resolve: (result: JmapMessageActionResult) => void;
};

type PendingMessageMutation = {
  kinds: Set<string>;
  messageId: string;
  patch: JmapEmailSetPatch;
  resolvers: PendingResolver[];
  result: JmapMessageActionResult;
};

type IdleWaiter = {
  resolve: (didBecomeIdle: boolean) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const pendingMutationsByMessageId = new Map<string, PendingMessageMutation>();
const idleWaiters: IdleWaiter[] = [];

let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushInFlight = false;
let fallbackMutationCount = 0;

export function enqueueMailMutation(
  mutation: MailSyncMutation,
): Promise<JmapMessageActionResult> {
  const mutationStartedAt = Date.now();
  const queuedMutation = buildQueuedMutation(mutation);

  if (!queuedMutation) {
    return runFallbackMutation(mutation, mutationStartedAt);
  }

  return new Promise<JmapMessageActionResult>((resolve, reject) => {
    const pending =
      pendingMutationsByMessageId.get(mutation.messageId) ??
      createPendingMessageMutation(mutation.messageId);
    const normalizedQueuedMutation = normalizeQueuedMutationForPending(
      queuedMutation,
      pending,
      mutation,
    );

    Object.assign(pending.patch, normalizedQueuedMutation.patch);
    pending.result = mergeActionResults(pending.result, normalizedQueuedMutation.result);
    pending.kinds.add(mutation.type);
    pending.resolvers.push({ reject, resolve });
    pendingMutationsByMessageId.set(mutation.messageId, pending);

    observeEvent('mail-sync.mutation.enqueue', {
      kind: mutation.type,
      messageId: mutation.messageId,
      pendingMessages: pendingMutationsByMessageId.size,
      pendingResolvers: pending.resolvers.length,
    });

    scheduleFlush();
  }).finally(() => {
    observeDuration('mail-sync.mutation.finished', mutationStartedAt, {
      kind: mutation.type,
      messageId: mutation.messageId,
    });
  });
}

export function isMailMutationQueueDirty() {
  return (
    pendingMutationsByMessageId.size > 0 ||
    flushInFlight ||
    fallbackMutationCount > 0 ||
    flushTimer !== null
  );
}

export function waitForMailMutationQueueIdle(timeoutMs = mailMutationIdleTimeoutMs) {
  if (!isMailMutationQueueDirty()) {
    return Promise.resolve(true);
  }

  const startedAt = Date.now();

  return new Promise<boolean>((resolve) => {
    const waiter: IdleWaiter = {
      resolve: (didBecomeIdle) => {
        observeDuration('mail-sync.idle.wait.finished', startedAt, {
          didBecomeIdle,
          pendingMessages: pendingMutationsByMessageId.size,
        });
        resolve(didBecomeIdle);
      },
      timeout: setTimeout(() => {
        removeIdleWaiter(waiter);
        waiter.resolve(false);
      }, timeoutMs),
    };

    idleWaiters.push(waiter);
    observeEvent('mail-sync.idle.wait.start', {
      pendingMessages: pendingMutationsByMessageId.size,
      timeoutMs,
    });
  });
}

function buildQueuedMutation(mutation: MailSyncMutation):
  | {
      patch: JmapEmailSetPatch;
      result: JmapMessageActionResult;
    }
  | null {
  switch (mutation.type) {
    case 'set-seen': {
      const keywords = updateKeyword(mutation.currentKeywords, '$seen', mutation.seen);

      return {
        patch: { 'keywords/$seen': mutation.seen ? true : null },
        result: {
          keywords,
          unread: !mutation.seen,
        },
      };
    }
    case 'set-flagged': {
      const keywords = updateKeyword(
        mutation.currentKeywords,
        '$flagged',
        mutation.flagged,
      );

      return {
        patch: { 'keywords/$flagged': mutation.flagged ? true : null },
        result: {
          keywords,
          pinned: mutation.flagged,
        },
      };
    }
    case 'move-to-role': {
      const mailboxIds = getJmapMailboxIdsForRole({
        currentMailboxIds: mutation.mailboxIds,
        mailboxes: mutation.mailboxes,
        role: mutation.role,
      });

      if (!mailboxIds) {
        return null;
      }

      return {
        patch: { mailboxIds },
        result: { mailboxIds },
      };
    }
  }
}

function normalizeQueuedMutationForPending(
  queuedMutation: {
    patch: JmapEmailSetPatch;
    result: JmapMessageActionResult;
  },
  pending: PendingMessageMutation,
  mutation: MailSyncMutation,
) {
  if (mutation.type === 'set-seen') {
    return {
      ...queuedMutation,
      result: {
        keywords: updateKeyword(
          pending.result.keywords ?? mutation.currentKeywords,
          '$seen',
          mutation.seen,
        ),
        unread: !mutation.seen,
      },
    };
  }

  if (mutation.type === 'set-flagged') {
    return {
      ...queuedMutation,
      result: {
        keywords: updateKeyword(
          pending.result.keywords ?? mutation.currentKeywords,
          '$flagged',
          mutation.flagged,
        ),
        pinned: mutation.flagged,
      },
    };
  }

  return queuedMutation;
}

function runFallbackMutation(
  mutation: MailSyncMutation,
  mutationStartedAt: number,
): Promise<JmapMessageActionResult> {
  if (mutation.type !== 'move-to-role') {
    return Promise.reject(new Error(`Unsupported mail sync fallback: ${mutation.type}`));
  }

  fallbackMutationCount += 1;
  observeEvent('mail-sync.mutation.fallback.start', {
    messageId: mutation.messageId,
    role: mutation.role,
  });

  const request =
    mutation.role === 'archive'
      ? archiveJmapEmail(mutation.messageId)
      : mutation.role === 'trash'
        ? trashJmapEmail(mutation.messageId)
        : unarchiveJmapEmail(mutation.messageId);

  return request
    .then((result) => {
      observeDuration('mail-sync.mutation.fallback.success', mutationStartedAt, {
        messageId: mutation.messageId,
        role: mutation.role,
      });
      return result;
    })
    .catch((error: unknown) => {
      observeError('mail-sync.mutation.fallback.failed', error, {
        messageId: mutation.messageId,
        role: mutation.role,
      });
      throw error;
    })
    .finally(() => {
      fallbackMutationCount = Math.max(0, fallbackMutationCount - 1);
      notifyIdleWaitersIfIdle();
    });
}

function createPendingMessageMutation(messageId: string): PendingMessageMutation {
  return {
    kinds: new Set(),
    messageId,
    patch: {},
    resolvers: [],
    result: {},
  };
}

function scheduleFlush() {
  if (flushTimer || flushInFlight) {
    return;
  }

  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushPendingMutations();
  }, mailMutationFlushDebounceMs);
}

function scheduleDeferredFlush(delayMs: number) {
  if (flushTimer || flushInFlight) {
    return;
  }

  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushPendingMutations();
  }, delayMs);
}

async function flushPendingMutations() {
  if (flushInFlight) {
    scheduleFlush();
    return;
  }

  if (!pendingMutationsByMessageId.size) {
    notifyIdleWaitersIfIdle();
    return;
  }

  const foregroundBodyFetch = getForegroundMessageBodyFetchStatus();
  const msSinceForegroundBodyActivity =
    foregroundBodyFetch.lastActivityAt > 0
      ? Date.now() - foregroundBodyFetch.lastActivityAt
      : Number.POSITIVE_INFINITY;

  if (
    foregroundBodyFetch.activeCount > 0 ||
    msSinceForegroundBodyActivity < mailMutationForegroundBodyQuietMs
  ) {
    observeEvent('mail-sync.flush.deferred-for-foreground-body', {
      activeForegroundBodyFetches: foregroundBodyFetch.activeCount,
      msSinceForegroundBodyActivity: Number.isFinite(msSinceForegroundBodyActivity)
        ? Math.max(0, msSinceForegroundBodyActivity)
        : -1,
      pendingMessages: pendingMutationsByMessageId.size,
    });
    scheduleDeferredFlush(mailMutationForegroundBodyPollMs);
    return;
  }

  const startedAt = Date.now();
  const batch = Array.from(pendingMutationsByMessageId.values());
  const updates: Record<string, JmapEmailSetPatch> = {};

  pendingMutationsByMessageId.clear();
  flushInFlight = true;

  for (const mutation of batch) {
    updates[mutation.messageId] = mutation.patch;
  }

  observeEvent('mail-sync.flush.start', {
    messageCount: batch.length,
    mutationKinds: formatMutationKinds(batch),
  });

  try {
    const result = await applyJmapEmailSetBatch(updates);

    for (const mutation of batch) {
      const error = result.notUpdated[mutation.messageId];

      if (error) {
        rejectMutation(mutation, createEmailSetNotUpdatedError(error));
      } else {
        resolveMutation(mutation, mutation.result);
      }
    }

    observeDuration('mail-sync.flush.success', startedAt, {
      messageCount: batch.length,
      notUpdated: Object.keys(result.notUpdated).length,
      updated: result.updatedIds.length,
    });
  } catch (error: unknown) {
    for (const mutation of batch) {
      rejectMutation(mutation, error);
    }

    observeError('mail-sync.flush.failed', error, {
      messageCount: batch.length,
    });
  } finally {
    flushInFlight = false;

    if (pendingMutationsByMessageId.size) {
      scheduleFlush();
    } else {
      notifyIdleWaitersIfIdle();
    }
  }
}

function resolveMutation(
  mutation: PendingMessageMutation,
  result: JmapMessageActionResult,
) {
  for (const resolver of mutation.resolvers) {
    resolver.resolve(result);
  }
}

function rejectMutation(mutation: PendingMessageMutation, error: unknown) {
  for (const resolver of mutation.resolvers) {
    resolver.reject(error);
  }
}

function mergeActionResults(
  current: JmapMessageActionResult,
  next: JmapMessageActionResult,
): JmapMessageActionResult {
  return {
    ...current,
    ...next,
    keywords: next.keywords ?? current.keywords,
  };
}

function updateKeyword(
  keywords: Record<string, true> | null | undefined,
  keyword: '$flagged' | '$seen',
  enabled: boolean,
) {
  const nextKeywords = { ...(keywords ?? {}) };

  if (enabled) {
    nextKeywords[keyword] = true as true;
  } else {
    delete nextKeywords[keyword];
  }

  return nextKeywords;
}

function createEmailSetNotUpdatedError(error: JmapEmailSetNotUpdated) {
  const detail = error.description ? `: ${error.description}` : '';

  return new Error(`JMAP Email/set ${error.type ?? 'notUpdated'}${detail}`);
}

function formatMutationKinds(batch: PendingMessageMutation[]) {
  return Array.from(
    new Set(batch.flatMap((mutation) => Array.from(mutation.kinds))),
  ).join(',');
}

function notifyIdleWaitersIfIdle() {
  if (isMailMutationQueueDirty()) {
    return;
  }

  while (idleWaiters.length) {
    const waiter = idleWaiters.shift();

    if (!waiter) {
      continue;
    }

    clearTimeout(waiter.timeout);
    waiter.resolve(true);
  }
}

function removeIdleWaiter(waiter: IdleWaiter) {
  const index = idleWaiters.indexOf(waiter);

  if (index >= 0) {
    idleWaiters.splice(index, 1);
  }
}
