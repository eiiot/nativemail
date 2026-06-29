import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import * as Updates from 'expo-updates';
import { Platform } from 'react-native';

const observabilityDeviceIdKey = 'notifications.deviceId';
const defaultObservabilityRelayUrl =
  process.env.EXPO_PUBLIC_NOTIFICATION_RELAY_URL ?? 'https://s-nativemail-telemetry.tuft.host';
const maxQueuedEvents = 200;
const maxBatchSize = 25;
const flushDelayMs = 750;
const secureStoreOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

type ObservabilityValue = boolean | number | string | null | undefined;
type ObservabilityProperties = Record<string, ObservabilityValue>;
type ObservabilityLevel = 'debug' | 'error' | 'info' | 'warn';

type ObservabilityEvent = {
  at: string;
  id: string;
  level: ObservabilityLevel;
  name: string;
  properties: Record<string, boolean | number | string | null>;
};

let queuedEvents: ObservabilityEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushInFlight = false;

export function observeEvent(
  name: string,
  properties: ObservabilityProperties = {},
  level: ObservabilityLevel = 'info',
) {
  queuedEvents.push({
    at: new Date().toISOString(),
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    level,
    name,
    properties: sanitizeProperties(properties),
  });

  if (queuedEvents.length > maxQueuedEvents) {
    queuedEvents = queuedEvents.slice(-maxQueuedEvents);
  }

  scheduleObservabilityFlush();
}

export function observeDuration(
  name: string,
  startedAt: number,
  properties: ObservabilityProperties = {},
  level: ObservabilityLevel = 'info',
) {
  observeEvent(name, {
    ...properties,
    durationMs: Math.max(0, Date.now() - startedAt),
  }, level);
}

export function observeError(
  name: string,
  error: unknown,
  properties: ObservabilityProperties = {},
) {
  observeEvent(name, {
    ...properties,
    error: error instanceof Error ? error.message : String(error),
    errorName: error instanceof Error ? error.name : null,
  }, 'error');
}

export async function flushObservabilityEvents() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  if (flushInFlight || !queuedEvents.length) {
    return;
  }

  flushInFlight = true;
  const batch = queuedEvents.splice(0, maxBatchSize);

  try {
    const relayUrl = await getObservabilityRelayUrl();
    const deviceId = await getObservabilityDeviceId();

    await fetch(`${relayUrl}/observability`, {
      body: JSON.stringify({
        // The OTA update id suffix identifies which bundle produced these events.
        appVersion: `${Constants.expoConfig?.version ?? '0'}+${Updates.updateId?.slice(0, 8) ?? 'embedded'}`,
        deviceId,
        events: batch,
        platform: Platform.OS,
      }),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      method: 'POST',
    }).then((response) => {
      if (!response.ok) {
        throw new Error(`Observability upload failed with HTTP ${response.status}`);
      }
    });
  } catch {
    queuedEvents = [...batch, ...queuedEvents].slice(0, maxQueuedEvents);
  } finally {
    flushInFlight = false;

    if (queuedEvents.length) {
      scheduleObservabilityFlush();
    }
  }
}

function scheduleObservabilityFlush() {
  if (flushTimer) {
    return;
  }

  flushTimer = setTimeout(() => {
    void flushObservabilityEvents();
  }, flushDelayMs);
}

async function getObservabilityRelayUrl() {
  // Always use the current default observability endpoint, ignoring any URL
  // stored from push-notification registration: a device may have a stale
  // relay URL persisted (e.g. an orphaned tunnel route), which would silently
  // drop all telemetry. Push registration still uses its own stored URL.
  return normalizeRelayUrl(defaultObservabilityRelayUrl);
}

async function getObservabilityDeviceId() {
  const storedDeviceId = await SecureStore.getItemAsync(observabilityDeviceIdKey, secureStoreOptions);

  return storedDeviceId || `unregistered-${Platform.OS}`;
}

function normalizeRelayUrl(url: string) {
  return url.trim().replace(/\/+$/, '');
}

function sanitizeProperties(properties: ObservabilityProperties) {
  const sanitized: Record<string, boolean | number | string | null> = {};

  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined) {
      continue;
    }

    if (typeof value === 'string') {
      sanitized[key] = value.slice(0, 300);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}
