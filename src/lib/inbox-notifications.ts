import { getFastmailDomainAvatarUrl, getFastmailProfilePhotoUrl } from '@/lib/avatar-photos';
import { getFastmailJmapToken } from '@/lib/fastmail-token';
import { archiveJmapEmail, fetchJmapMailboxes, fetchJmapMessageNotificationStates } from '@/lib/jmap-client';
import { removeCachedEmailFromMailbox } from '@/lib/mail-cache';
import { recordLocalMailAction, useMailStore } from '@/lib/mail-store';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const notificationDeviceIdKey = 'notifications.deviceId';
const notificationRelayUrlKey = 'notifications.relayUrl';
const defaultNotificationRelayUrl =
  process.env.EXPO_PUBLIC_NOTIFICATION_RELAY_URL ?? 'https://staging-nativemail-notifications.tuft.host';
export const inboxMessageNotificationCategoryId = 'nativemailInboxMessage';
export const archiveInboxNotificationActionId = 'archiveInboxMessage';
const secureStoreOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export type InboxNotificationRegistrationResult = {
  deviceId: string;
  expoPushToken: string;
  relayUrl: string;
  status: string;
};

export type InboxNotificationRegistrationStatus = {
  registered: boolean;
  relayUrl: string;
  status: string;
};

export type InboxNotificationDismissResult = {
  dismissed: number;
  matched: number;
  matchedIdentifiers: string[];
  presented: number;
  presentedMessageIds: string[];
};

export type InboxNotificationSyncResult = InboxNotificationDismissResult & {
  activeMessageIds: string[];
  staleMessageIds: string[];
};

export type InboxNotificationArchiveActionResult = {
  messageId: string;
};

type InboxUnreadMailboxSource = {
  name: string;
  role?: string | null;
  unreadEmails?: number | null;
};

export async function registerInboxNotificationCategories() {
  await Notifications.setNotificationCategoryAsync(
    inboxMessageNotificationCategoryId,
    [
      {
        buttonTitle: 'Archive',
        identifier: archiveInboxNotificationActionId,
        options: {
          isAuthenticationRequired: false,
          opensAppToForeground: true,
        },
      },
    ],
  );
}

export function isArchiveInboxNotificationResponse(
  response: Notifications.NotificationResponse | null,
): boolean {
  return response?.actionIdentifier === archiveInboxNotificationActionId;
}

export async function archiveInboxNotificationResponse(
  response: Notifications.NotificationResponse,
): Promise<InboxNotificationArchiveActionResult | null> {
  const data = response.notification.request.content.data;
  const messageId = getString(data?.messageId);

  if (!messageId) {
    return null;
  }

  const mailboxId = getString(data?.mailboxId);

  recordLocalMailAction();
  useMailStore.getState().removeMessageFromMailbox(messageId, mailboxId || undefined);
  void removeCachedEmailFromMailbox(messageId, mailboxId || undefined).catch(() => {});
  void dismissInboxNotificationForMessage(messageId).catch(() => {});
  void adjustInboxUnreadBadgeCount(-1).catch(() => {});
  void recordInboxNotificationLocalAction(messageId).catch(() => {});

  await archiveJmapEmail(messageId);

  return { messageId };
}

export async function getNotificationRelayUrl() {
  const storedUrl = await SecureStore.getItemAsync(notificationRelayUrlKey, secureStoreOptions);

  return normalizeRelayUrl(storedUrl || defaultNotificationRelayUrl);
}

export async function saveNotificationRelayUrl(url: string) {
  const normalizedUrl = normalizeRelayUrl(url);

  await SecureStore.setItemAsync(notificationRelayUrlKey, normalizedUrl, secureStoreOptions);

  return normalizedUrl;
}

export async function registerForInboxNotifications(
  relayUrlInput?: string,
): Promise<InboxNotificationRegistrationResult> {
  if (!Device.isDevice) {
    throw new Error('Push notifications require a physical device.');
  }

  const jmapToken = await getFastmailJmapToken();

  if (!jmapToken) {
    throw new Error('Save a Fastmail JMAP token before registering notifications.');
  }

  const relayUrl = relayUrlInput
    ? await saveNotificationRelayUrl(relayUrlInput)
    : await getNotificationRelayUrl();
  const permissions = await ensureNotificationPermissions();

  if (!permissions.granted) {
    throw new Error('Notification permission was not granted.');
  }

  const projectId = getExpoProjectId();

  if (!projectId) {
    throw new Error('Expo project id is missing from app config.');
  }

  const deviceId = await getNotificationDeviceId();
  const expoPushToken = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  const response = await fetch(`${relayUrl}/register`, {
    body: JSON.stringify({
      deviceId,
      expoPushToken,
      jmapToken,
    }),
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(payload?.error ?? `Notification relay failed with HTTP ${response.status}.`);
  }

  return {
    deviceId,
    expoPushToken,
    relayUrl,
    status: formatRelaySubscriberStatus(payload?.subscriber),
  };
}

export async function sendInboxNotificationTest(relayUrlInput?: string) {
  const relayUrl = relayUrlInput
    ? await saveNotificationRelayUrl(relayUrlInput)
    : await getNotificationRelayUrl();
  const deviceId = await getNotificationDeviceId();
  const response = await fetch(`${relayUrl}/test`, {
    body: JSON.stringify({ deviceId }),
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(payload?.error ?? `Notification relay test failed with HTTP ${response.status}.`);
  }

  return 'Test notification sent';
}

export async function recordInboxNotificationLocalAction(
  messageId: string,
  relayUrlInput?: string,
) {
  const relayUrl = relayUrlInput
    ? await saveNotificationRelayUrl(relayUrlInput)
    : await getNotificationRelayUrl();
  const deviceId = await getStoredNotificationDeviceId();

  if (!deviceId) {
    return;
  }

  const response = await fetch(`${relayUrl}/local-action`, {
    body: JSON.stringify({
      deviceId,
      messageId,
    }),
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(payload?.error ?? `Notification relay local action failed with HTTP ${response.status}.`);
  }
}

export async function dismissInboxNotificationForMessage(
  messageId: string,
): Promise<InboxNotificationDismissResult> {
  const presentedNotifications = await Notifications.getPresentedNotificationsAsync();
  const matchingNotifications = presentedNotifications.filter((notification) => {
    return getNotificationMessageIds(notification).includes(messageId);
  });
  const matchedIdentifiers = matchingNotifications.map((notification) => notification.request.identifier);

  await Promise.all(
    matchedIdentifiers.map((identifier) => Notifications.dismissNotificationAsync(identifier)),
  );

  return {
    dismissed: matchedIdentifiers.length,
    matched: matchingNotifications.length,
    matchedIdentifiers,
    presented: presentedNotifications.length,
    presentedMessageIds: Array.from(
      new Set(presentedNotifications.flatMap((notification) => getNotificationMessageIds(notification))),
    ),
  };
}

export async function syncPresentedInboxNotifications(
  signal?: AbortSignal,
): Promise<InboxNotificationSyncResult> {
  const presentedNotifications = await Notifications.getPresentedNotificationsAsync();
  const presentedMessageIds = Array.from(
    new Set(presentedNotifications.flatMap((notification) => getNotificationMessageIds(notification))),
  );

  if (!presentedMessageIds.length) {
    return {
      activeMessageIds: [],
      dismissed: 0,
      matched: 0,
      matchedIdentifiers: [],
      presented: presentedNotifications.length,
      presentedMessageIds,
      staleMessageIds: [],
    };
  }

  const states = await fetchJmapMessageNotificationStates(presentedMessageIds, signal);
  const staleMessageIds = presentedMessageIds.filter((messageId) => {
    const state = states[messageId];

    return !state || !state.exists || !state.inInbox || !state.unread;
  });
  const staleMessageIdSet = new Set(staleMessageIds);
  const matchingNotifications = presentedNotifications.filter((notification) => {
    const messageIds = getNotificationMessageIds(notification);

    return messageIds.length > 0 && messageIds.every((messageId) => staleMessageIdSet.has(messageId));
  });
  const matchedIdentifiers = matchingNotifications.map((notification) => notification.request.identifier);

  await Promise.all(
    matchedIdentifiers.map((identifier) => Notifications.dismissNotificationAsync(identifier)),
  );

  return {
    activeMessageIds: presentedMessageIds.filter((messageId) => !staleMessageIdSet.has(messageId)),
    dismissed: matchedIdentifiers.length,
    matched: matchingNotifications.length,
    matchedIdentifiers,
    presented: presentedNotifications.length,
    presentedMessageIds,
    staleMessageIds,
  };
}

export function getInboxUnreadCountFromMailboxes(mailboxes: InboxUnreadMailboxSource[]) {
  const inboxMailbox =
    mailboxes.find((mailbox) => mailbox.role?.toLowerCase() === 'inbox') ??
    mailboxes.find((mailbox) => normalizeMailboxName(mailbox.name) === 'inbox');

  return normalizeBadgeCount(inboxMailbox?.unreadEmails ?? 0);
}

export async function setInboxUnreadBadgeCount(unreadCount: number) {
  return Notifications.setBadgeCountAsync(normalizeBadgeCount(unreadCount));
}

export async function adjustInboxUnreadBadgeCount(delta: number) {
  const currentCount = await Notifications.getBadgeCountAsync();

  return setInboxUnreadBadgeCount(currentCount + delta);
}

export async function syncInboxUnreadBadgeCount(signal?: AbortSignal) {
  const mailboxes = await fetchJmapMailboxes(signal);

  return setInboxUnreadBadgeCount(getInboxUnreadCountFromMailboxes(mailboxes));
}

export async function getPresentedInboxNotificationDebugReport() {
  const presentedNotifications = await Notifications.getPresentedNotificationsAsync();
  const report = {
    count: presentedNotifications.length,
    notifications: presentedNotifications.map((notification) => {
      const trigger = notification.request.trigger as { payload?: unknown; type?: string } | null;
      const contentData = notification.request.content.data;
      const triggerPayload = trigger?.payload;

      return {
        identifier: notification.request.identifier,
        title: notification.request.content.title ?? null,
        subtitle: notification.request.content.subtitle ?? null,
        body: notification.request.content.body ?? null,
        triggerType: trigger?.type ?? null,
        messageIds: getNotificationMessageIds(notification),
        contentData,
        triggerPayload,
      };
    }),
  };

  return JSON.stringify(report, null, 2);
}

export async function getInboxNotificationRegistrationStatus(
  relayUrlInput?: string,
): Promise<InboxNotificationRegistrationStatus> {
  const relayUrl = relayUrlInput
    ? await saveNotificationRelayUrl(relayUrlInput)
    : await getNotificationRelayUrl();
  const deviceId = await getStoredNotificationDeviceId();

  if (!deviceId) {
    return {
      registered: false,
      relayUrl,
      status: 'This device has not registered for Inbox notifications yet.',
    };
  }

  const response = await fetch(`${relayUrl}/register/${encodeURIComponent(deviceId)}`, {
    headers: {
      Accept: 'application/json',
    },
    method: 'GET',
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(payload?.error ?? `Notification relay status failed with HTTP ${response.status}.`);
  }

  if (!payload?.registered) {
    return {
      registered: false,
      relayUrl,
      status: 'This device is not registered with the notification relay.',
    };
  }

  return {
    registered: true,
    relayUrl,
    status: formatRelaySubscriberStatus(payload.subscriber),
  };
}

export async function unregisterInboxNotifications(relayUrlInput?: string) {
  const relayUrl = relayUrlInput
    ? await saveNotificationRelayUrl(relayUrlInput)
    : await getNotificationRelayUrl();
  const deviceId = await getNotificationDeviceId();

  await fetch(`${relayUrl}/register/${encodeURIComponent(deviceId)}`, {
    method: 'DELETE',
  }).catch(() => {});

  return 'Notifications unregistered';
}

export function getNotificationMessageRoute(data: Record<string, unknown>) {
  const messageId = typeof data.messageId === 'string' ? data.messageId : null;
  const fromEmail = getString(data.fromEmail);

  if (!messageId) {
    return null;
  }

  return {
    pathname: '/message/[id]' as const,
    params: {
      avatarUrl: getFastmailDomainAvatarUrl(fromEmail) ?? getFastmailProfilePhotoUrl(fromEmail) ?? '',
      date: getString(data.date),
      fromEmail,
      id: messageId,
      mailboxName: getString(data.mailboxName) || 'Inbox',
      preview: getString(data.preview),
      sender: getString(data.sender) || 'New mail',
      source: 'jmap',
      subject: getString(data.subject) || '(No subject)',
      threadId: getString(data.threadId),
      unread: '1',
      wasUnreadOnOpen: '1',
    },
  };
}

function getNotificationMessageIds(notification: Notifications.Notification) {
  return Array.from(
    new Set(
      [
        getNotificationContentMessageId(notification),
        getNotificationTriggerBodyMessageId(notification),
      ].filter((messageId): messageId is string => Boolean(messageId)),
    ),
  );
}

function getNotificationContentMessageId(notification: Notifications.Notification) {
  const data = notification.request.content.data;

  return typeof data?.messageId === 'string' ? data.messageId : null;
}

function getNotificationTriggerBodyMessageId(notification: Notifications.Notification) {
  const trigger = notification.request.trigger as { payload?: { body?: { messageId?: unknown } } } | null;
  const messageId = trigger?.payload?.body?.messageId;

  return typeof messageId === 'string' ? messageId : null;
}

async function ensureNotificationPermissions() {
  const currentPermissions = await Notifications.getPermissionsAsync();

  if (currentPermissions.granted) {
    return currentPermissions;
  }

  return Notifications.requestPermissionsAsync({
    ios: {
      allowAlert: true,
      allowBadge: true,
      allowSound: true,
    },
  });
}

async function getNotificationDeviceId() {
  const existingId = await SecureStore.getItemAsync(notificationDeviceIdKey, secureStoreOptions);

  if (existingId) {
    return existingId;
  }

  const nextId = [
    'nativemail',
    Platform.OS,
    Date.now().toString(36),
    Math.random().toString(36).slice(2, 12),
  ].join('-');

  await SecureStore.setItemAsync(notificationDeviceIdKey, nextId, secureStoreOptions);

  return nextId;
}

async function getStoredNotificationDeviceId() {
  return SecureStore.getItemAsync(notificationDeviceIdKey, secureStoreOptions);
}

function getExpoProjectId() {
  const easConfig = Constants.easConfig as { projectId?: string } | null;
  const expoConfig = Constants.expoConfig as { extra?: { eas?: { projectId?: string } } } | null;

  return easConfig?.projectId ?? expoConfig?.extra?.eas?.projectId ?? null;
}

function normalizeRelayUrl(url: string) {
  const trimmedUrl = url.trim().replace(/\/+$/, '');

  if (!/^https?:\/\//i.test(trimmedUrl)) {
    throw new Error('Notification relay URL must start with http:// or https://.');
  }

  return trimmedUrl;
}

function normalizeMailboxName(name: string) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function normalizeBadgeCount(count: number) {
  return Math.max(0, Math.floor(Number.isFinite(count) ? count : 0));
}

function formatRelaySubscriberStatus(subscriber: unknown) {
  if (!subscriber || typeof subscriber !== 'object') {
    return 'Registered for Inbox notifications';
  }

  const value = subscriber as {
    eventSource?: boolean;
    mailboxName?: string;
    pollingMs?: number | null;
    status?: string;
    username?: string;
  };
  const mode = value.eventSource ? 'JMAP event source' : 'server polling fallback';

  return [
    `Registered ${value.username ?? 'account'} ${value.mailboxName ?? 'Inbox'}`,
    `Mode: ${mode}`,
    value.pollingMs ? `Fallback poll: ${Math.round(value.pollingMs / 1000)}s` : null,
    value.status ? `Status: ${value.status}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function getString(value: unknown) {
  return typeof value === 'string' ? value : '';
}
