import { useSyncExternalStore } from 'react';

import { isDebugModeEnabled } from '@/lib/debug-mode';

export type NavigationDebugEvent = {
  detail?: string;
  elapsedMs: number;
  label: string;
  sincePreviousMs: number;
};

export type NavigationDebugTrace = {
  events: NavigationDebugEvent[];
  id: number;
  label: string;
  startedAt: string;
  startedAtMs: number;
};

let nextTraceId = 1;
let currentTrace: NavigationDebugTrace | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return currentTrace;
}

function emit() {
  setTimeout(() => {
    listeners.forEach((listener) => listener());
  }, 0);
}

function nowMs() {
  return globalThis.performance?.now?.() ?? Date.now();
}

export function startNavigationTrace(label: string, detail?: string) {
  if (!isDebugModeEnabled()) {
    return;
  }

  currentTrace = {
    events: [],
    id: nextTraceId,
    label,
    startedAt: new Date().toISOString(),
    startedAtMs: nowMs(),
  };
  nextTraceId += 1;
  markNavigationTrace('tap', detail);
}

export function markNavigationTrace(label: string, detail?: string) {
  if (!isDebugModeEnabled() || !currentTrace) {
    return;
  }

  const elapsedMs = nowMs() - currentTrace.startedAtMs;
  const previous = currentTrace.events[currentTrace.events.length - 1];
  currentTrace = {
    ...currentTrace,
    events: [
      ...currentTrace.events,
      {
        detail,
        elapsedMs,
        label,
        sincePreviousMs: previous ? elapsedMs - previous.elapsedMs : elapsedMs,
      },
    ],
  };
  emit();
}

export function useNavigationDebugTrace() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function getNavigationDebugReport(trace = currentTrace) {
  if (!trace) {
    return 'No navigation trace recorded yet.';
  }

  const lastEvent = trace.events[trace.events.length - 1];
  const totalMs = lastEvent?.elapsedMs ?? 0;
  const eventLines = trace.events.map((event) => {
    const detail = event.detail ? ` ${event.detail}` : '';

    return `${formatMs(event.elapsedMs)} (+${formatMs(event.sincePreviousMs)}) ${event.label}${detail}`;
  });

  return [
    `navigation: ${trace.label}`,
    `started: ${trace.startedAt}`,
    `total: ${formatMs(totalMs)}`,
    ...eventLines,
  ].join('\n');
}

function formatMs(value: number) {
  return `${Math.round(value)}ms`;
}
