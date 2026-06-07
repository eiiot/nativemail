import {
  dismissInboxNotificationForMessage,
  setInboxUnreadBadgeCount,
} from '@/lib/inbox-notifications';
import {
  writeCachedInboxNotificationMessage,
  writeCachedInboxStateSnapshot,
  type CachedInboxStateMessageInput,
} from '@/lib/mail-cache';
import { hydrateMailboxSnapshotFromCache } from '@/lib/mail-store';
import * as Notifications from 'expo-notifications';

const inboxNotificationBackgroundTaskName = 'nativemail-inbox-notification-background';
const dismissMessageNotificationType = 'dismiss-message-notification';
const syncInboxBadgeType = 'sync-inbox-badge';
const syncInboxStateType = 'sync-inbox-state';
const sqliteLockRetryDelays = [80, 160, 320];

type TaskManagerModule = typeof import('expo-task-manager');

const TaskManager = loadTaskManager();
let inboxNotificationPayloadQueue = Promise.resolve();

if (TaskManager && !TaskManager.isTaskDefined(inboxNotificationBackgroundTaskName)) {
  TaskManager.defineTask<Notifications.NotificationTaskPayload>(
    inboxNotificationBackgroundTaskName,
    async ({ data, error }) => {
      if (error) {
        return Notifications.BackgroundNotificationTaskResult.Failed;
      }

      try {
        return await handleInboxNotificationPayload(getNotificationTaskData(data))
          ? Notifications.BackgroundNotificationTaskResult.NewData
          : Notifications.BackgroundNotificationTaskResult.NoData;
      } catch {
        return Notifications.BackgroundNotificationTaskResult.NoData;
      }
    },
  );
}

export async function handleInboxNotificationPayload(payload: Record<string, unknown> | null) {
  const work = inboxNotificationPayloadQueue
    .catch(() => {})
    .then(() => handleInboxNotificationPayloadNow(payload));

  inboxNotificationPayloadQueue = work.then(() => undefined, () => undefined);

  return work;
}

async function handleInboxNotificationPayloadNow(payload: Record<string, unknown> | null) {
  const messageId = getDismissMessageId(payload);

  if (messageId) {
    await dismissInboxNotificationForMessage(messageId);

    return true;
  }

  const inboxState = getInboxStateSnapshot(payload);

  if (inboxState) {
    await runWithSqliteLockRetry(async () => {
      await writeCachedInboxStateSnapshot(inboxState);
      await hydrateMailboxSnapshotFromCache(inboxState.mailboxId);
    });

    if (typeof inboxState.inboxUnreadEmails === 'number') {
      await setInboxUnreadBadgeCount(inboxState.inboxUnreadEmails);
    }

    return true;
  }

  const badgeCount = getSyncInboxBadgeCount(payload);

  if (badgeCount !== null) {
    await setInboxUnreadBadgeCount(badgeCount);

    return true;
  }

  const inboxMessage = getInboxNotificationMessage(payload);

  if (!inboxMessage) {
    return false;
  }

  await runWithSqliteLockRetry(async () => {
    await writeCachedInboxNotificationMessage(inboxMessage);
    await hydrateMailboxSnapshotFromCache(inboxMessage.mailboxId);
  });

  if (typeof inboxMessage.inboxUnreadEmails === 'number') {
    await setInboxUnreadBadgeCount(inboxMessage.inboxUnreadEmails);
  }

  return true;
}

async function runWithSqliteLockRetry<T>(operation: () => Promise<T>) {
  for (let attempt = 0; attempt <= sqliteLockRetryDelays.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const delayMs = sqliteLockRetryDelays[attempt];

      if (!delayMs || !isSqliteLockedError(error)) {
        throw error;
      }

      await delay(delayMs);
    }
  }

  throw new Error('SQLite lock retry exhausted');
}

function isSqliteLockedError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  return /database is locked|Error code 5|SQLITE_BUSY/i.test(message);
}

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function registerInboxNotificationBackgroundTask() {
  if (!TaskManager) {
    return false;
  }

  const isAvailable = await TaskManager.isAvailableAsync().catch(() => false);

  if (!isAvailable) {
    return false;
  }

  const isRegistered = await TaskManager.isTaskRegisteredAsync(
    inboxNotificationBackgroundTaskName,
  ).catch(() => false);

  if (!isRegistered) {
    await Notifications.registerTaskAsync(inboxNotificationBackgroundTaskName);
  }

  return true;
}

function loadTaskManager(): TaskManagerModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Old dev clients may not have this native module yet.
    return require('expo-task-manager') as TaskManagerModule;
  } catch {
    return null;
  }
}

function getNotificationTaskData(data: Notifications.NotificationTaskPayload) {
  if (!isRecord(data) || 'actionIdentifier' in data) {
    return null;
  }

  const directData = isRecord(data.data) ? data.data : {};
  const stringData = typeof directData.dataString === 'string'
    ? parseDataString(directData.dataString)
    : {};
  const notificationData = isRecord(data.notification?.data) ? data.notification.data : {};

  return {
    ...notificationData,
    ...directData,
    ...stringData,
  };
}

function parseDataString(dataString: string) {
  try {
    const parsed = JSON.parse(dataString);

    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function getDismissMessageId(payload: Record<string, unknown> | null) {
  if (!payload) {
    return null;
  }

  const body = isRecord(payload.body) ? payload.body : {};
  const action = getString(payload.action) || getString(payload.type) || getString(body.action) || getString(body.type);
  const messageId = getString(payload.messageId) || getString(body.messageId);

  return action === dismissMessageNotificationType && messageId ? messageId : null;
}

function getSyncInboxBadgeCount(payload: Record<string, unknown> | null) {
  if (!payload) {
    return null;
  }

  const body = isRecord(payload.body) ? payload.body : {};
  const action = getString(payload.action) || getString(payload.type) || getString(body.action) || getString(body.type);
  const inboxUnreadEmails = getNumber(payload.inboxUnreadEmails) ?? getNumber(body.inboxUnreadEmails);

  return action === syncInboxBadgeType ? inboxUnreadEmails : null;
}

function getInboxStateSnapshot(payload: Record<string, unknown> | null) {
  if (!payload) {
    return null;
  }

  const body = isRecord(payload.body) ? payload.body : {};
  const action = getString(payload.action) || getString(payload.type) || getString(body.action) || getString(body.type);
  const accountId = getString(payload.accountId) || getString(body.accountId);
  const mailboxId = getString(payload.mailboxId) || getString(body.mailboxId);
  const messagesValue = Array.isArray(payload.messages) ? payload.messages : body.messages;
  const messages = Array.isArray(messagesValue)
    ? messagesValue
        .map((message) => getInboxStateMessage(message, accountId, mailboxId))
        .filter((message): message is CachedInboxStateMessageInput => Boolean(message))
    : [];

  if (action !== syncInboxStateType || !accountId || !mailboxId) {
    return null;
  }

  return {
    accountId,
    inboxUnreadEmails: getNumber(payload.inboxUnreadEmails) ?? getNumber(body.inboxUnreadEmails),
    mailboxId,
    mailboxName: getString(payload.mailboxName) || getString(body.mailboxName),
    messages,
  };
}

function getInboxNotificationMessage(payload: Record<string, unknown> | null) {
  if (!payload) {
    return null;
  }

  const body = isRecord(payload.body) ? payload.body : {};
  const action = getString(payload.action) || getString(payload.type) || getString(body.action) || getString(body.type);
  const accountId = getString(payload.accountId) || getString(body.accountId);
  const mailboxId = getString(payload.mailboxId) || getString(body.mailboxId);
  const messageId = getString(payload.messageId) || getString(body.messageId);

  if (action || !accountId || !mailboxId || !messageId) {
    return null;
  }

  return {
    accountId,
    date: getString(payload.date) || getString(body.date),
    fromEmail: getString(payload.fromEmail) || getString(body.fromEmail),
    inboxUnreadEmails: getNumber(payload.inboxUnreadEmails) ?? getNumber(body.inboxUnreadEmails),
    mailboxId,
    mailboxName: getString(payload.mailboxName) || getString(body.mailboxName),
    messageId,
    preview: getString(payload.preview) || getString(body.preview),
    sender: getString(payload.sender) || getString(body.sender),
    subject: getString(payload.subject) || getString(body.subject),
    threadId: getString(payload.threadId) || getString(body.threadId),
  };
}

function getInboxStateMessage(
  value: unknown,
  accountId: string,
  mailboxId: string,
): CachedInboxStateMessageInput | null {
  if (!isRecord(value)) {
    return null;
  }

  const messageId = getString(value.messageId);

  if (!messageId) {
    return null;
  }

  return {
    accountId,
    date: getString(value.date),
    fromEmail: getString(value.fromEmail),
    keywords: isRecord(value.keywords) ? value.keywords : {},
    mailboxId,
    mailboxIds: isRecord(value.mailboxIds) ? value.mailboxIds : { [mailboxId]: true },
    messageId,
    preview: getString(value.preview),
    sender: getString(value.sender),
    subject: getString(value.subject),
    threadId: getString(value.threadId),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function getString(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function getNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}
