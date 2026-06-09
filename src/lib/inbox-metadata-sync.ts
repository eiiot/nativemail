import { getInboxUnreadCountFromMailboxes, setInboxUnreadBadgeCount } from '@/lib/inbox-notifications';
import { fetchJmapMailboxSnapshot, type JmapMailboxSnapshot } from '@/lib/jmap-client';
import { writeCachedMailboxSnapshot } from '@/lib/mail-cache';
import {
  getLocalMailActionRefreshSuppressionRemainingMs,
  isLocalMailActionRefreshSuppressed,
  selectMailboxSnapshot,
  useMailStore,
} from '@/lib/mail-store';
import { observeDuration, observeError, observeEvent } from '@/lib/observability';

const inboxMetadataSyncLimit = 50;

let inboxMetadataSyncInFlight: Promise<JmapMailboxSnapshot | null> | null = null;

export async function syncInboxMetadataFromServer({
  limit = inboxMetadataSyncLimit,
  reason,
  respectLocalActionSuppression = true,
  signal,
}: {
  limit?: number;
  reason: string;
  respectLocalActionSuppression?: boolean;
  signal?: AbortSignal;
}) {
  if (respectLocalActionSuppression && isLocalMailActionRefreshSuppressed()) {
    observeEvent('inbox.metadata-sync.skipped-local-action', {
      reason,
      suppressionMs: Math.ceil(getLocalMailActionRefreshSuppressionRemainingMs()),
    });
    return null;
  }

  if (inboxMetadataSyncInFlight) {
    observeEvent('inbox.metadata-sync.join', {
      limit,
      reason,
    });
    return inboxMetadataSyncInFlight;
  }

  const startedAt = Date.now();

  observeEvent('inbox.metadata-sync.start', {
    limit,
    reason,
  });

  const sync = fetchJmapMailboxSnapshot({
    limit,
    mailboxId: null,
    position: 0,
    signal,
  })
    .then(async (snapshot) => {
      const currentSnapshot = selectMailboxSnapshot(useMailStore.getState(), snapshot.mailbox?.id ?? null);
      const nextSnapshot = currentSnapshot
        ? mergeInboxMetadataPage(currentSnapshot, snapshot, limit)
        : snapshot;

      useMailStore.getState().applyMailboxSnapshot(nextSnapshot, snapshot.mailbox?.id ?? null);
      await writeCachedMailboxSnapshot(nextSnapshot);
      await setInboxUnreadBadgeCount(getInboxUnreadCountFromMailboxes(snapshot.mailboxes));

      observeDuration('inbox.metadata-sync.success', startedAt, {
        limit,
        mailboxId: snapshot.mailbox?.id ?? 'inbox',
        messages: snapshot.messages.length,
        nextMessages: nextSnapshot.messages.length,
        reason,
        total: snapshot.total ?? -1,
      });

      return nextSnapshot;
    })
    .catch((error: unknown) => {
      observeError('inbox.metadata-sync.failed', error, {
        limit,
        reason,
      });
      throw error;
    })
    .finally(() => {
      if (inboxMetadataSyncInFlight === sync) {
        inboxMetadataSyncInFlight = null;
      }
    });

  inboxMetadataSyncInFlight = sync;
  return sync;
}

function mergeInboxMetadataPage(
  currentSnapshot: JmapMailboxSnapshot,
  pageSnapshot: JmapMailboxSnapshot,
  pageSize: number,
): JmapMailboxSnapshot {
  if ((pageSnapshot.position ?? 0) !== 0 || currentSnapshot.messages.length <= pageSnapshot.messages.length) {
    return pageSnapshot;
  }

  const pageMessageIds = new Set(pageSnapshot.messages.map((message) => message.id));
  const preservedMessages = currentSnapshot.messages
    .slice(pageSize)
    .filter((message) => !pageMessageIds.has(message.id));

  return {
    ...pageSnapshot,
    messages: [...pageSnapshot.messages, ...preservedMessages],
    threads: {
      ...(currentSnapshot.threads ?? {}),
      ...(pageSnapshot.threads ?? {}),
    },
  };
}
