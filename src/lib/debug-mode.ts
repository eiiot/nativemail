import { useSyncExternalStore } from 'react';

let debugModeEnabled = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return debugModeEnabled;
}

export function setDebugMode(enabled: boolean) {
  if (debugModeEnabled === enabled) {
    return;
  }

  debugModeEnabled = enabled;
  listeners.forEach((listener) => listener());
}

export function useDebugMode() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
