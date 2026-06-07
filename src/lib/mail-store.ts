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

type MessagePatch = Pick<Partial<Message>, 'keywords' | 'pinned' | 'unread'>;

const LOCAL_ACTION_REFRESH_SUPPRESSION_MS = 8000;

const messageBodyFetches = new Map<string, Promise<JmapMessageBody | null>>();
let localMailActionSuppressUntil = 0;

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
    refresh = false,
  }: {
    refresh?: boolean;
  } = {},
) {
  if (!refresh) {
    const cachedOrMemoryBody = await hydrateMessageBodyFromCache(messageId);

    if (cachedOrMemoryBody) {
      return cachedOrMemoryBody;
    }
  }

  const existingFetch = messageBodyFetches.get(messageId);

  if (existingFetch) {
    return existingFetch;
  }

  const fetchPromise = fetchJmapMessageBody(messageId)
    .then(async (body) => {
      if (body) {
        useMailStore.getState().applyMessageBody(messageId, body);
        await writeCachedEmailBody(messageId, body).catch(() => {});
      }

      return body;
    })
    .finally(() => {
      messageBodyFetches.delete(messageId);
    });

  messageBodyFetches.set(messageId, fetchPromise);

  return fetchPromise;
}

export async function prefetchMessageBodies(
  messageIds: string[],
  {
    concurrency = 2,
    limit = 8,
  }: {
    concurrency?: number;
    limit?: number;
  } = {},
) {
  const uniqueIds = Array.from(new Set(messageIds));
  const pendingIds = uniqueIds
    .filter((messageId) => !selectMessageBody(useMailStore.getState(), messageId))
    .slice(0, limit);
  let loaded = 0;
  let failed = 0;
  let cursor = 0;

  async function runNext() {
    while (cursor < pendingIds.length) {
      const messageId = pendingIds[cursor];
      cursor += 1;

      if (!messageId) {
        continue;
      }

      try {
        const body = await loadMessageBody(messageId);

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
