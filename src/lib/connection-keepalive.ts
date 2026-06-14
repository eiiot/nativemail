import { AppState, type AppStateStatus } from 'react-native';

import { hasFastmailJmapToken } from '@/lib/fastmail-token';
import { keepFastmailConnectionWarm } from '@/lib/jmap-client';
import { observeEvent } from '@/lib/observability';

// Ping interval. Telemetry shows the connection can go idle-dead in under 12s,
// so ping every 8s to keep it warm during active use. A ping that does hit a
// dead connection now fails fast (native 5s idle timeout) and iOS evicts it,
// so the next ping/request opens a fresh one.
const KEEPALIVE_INTERVAL_MS = 8_000;

/**
 * While the app is foregrounded and signed in, sends a tiny JMAP request on an
 * interval so the shared connection to Fastmail never sits idle long enough to
 * be dropped. A warm connection makes message opens ~150ms instead of stalling
 * on a dead reused connection. Returns a cleanup function.
 */
export function startConnectionKeepAlive(): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;

  const ping = async () => {
    if (inFlight) {
      return;
    }

    if (!(await hasFastmailJmapToken())) {
      return;
    }

    inFlight = true;

    try {
      await keepFastmailConnectionWarm();
    } finally {
      inFlight = false;
    }
  };

  const start = () => {
    if (timer) {
      return;
    }

    observeEvent('jmap.keepalive.start', { intervalMs: KEEPALIVE_INTERVAL_MS });
    timer = setInterval(() => {
      void ping();
    }, KEEPALIVE_INTERVAL_MS);
    // Warm immediately on (re)entry to foreground, when the connection is most
    // likely to have gone stale during background.
    void ping();
  };

  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const handleAppStateChange = (nextState: AppStateStatus) => {
    if (nextState === 'active') {
      start();
    } else {
      stop();
    }
  };

  const subscription = AppState.addEventListener('change', handleAppStateChange);

  if (AppState.currentState === 'active') {
    start();
  }

  return () => {
    stop();
    subscription.remove();
  };
}
