import { getFastmailJmapToken } from '@/lib/fastmail-token';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const notificationDeviceIdKey = 'notifications.deviceId';
const notificationRelayUrlKey = 'notifications.relayUrl';
const defaultNotificationRelayUrl =
  process.env.EXPO_PUBLIC_NOTIFICATION_RELAY_URL ?? 'https://staging-nativemail-notifications.tuft.host';
const secureStoreOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export type InboxNotificationRegistrationResult = {
  deviceId: string;
  expoPushToken: string;
  relayUrl: string;
  status: string;
};

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

  if (!messageId) {
    return null;
  }

  return {
    pathname: '/message/[id]' as const,
    params: {
      date: getString(data.date),
      fromEmail: getString(data.fromEmail),
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

async function ensureNotificationPermissions() {
  const currentPermissions = await Notifications.getPermissionsAsync();

  if (currentPermissions.granted) {
    return currentPermissions;
  }

  return Notifications.requestPermissionsAsync();
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
