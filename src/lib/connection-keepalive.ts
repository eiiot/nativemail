import { AppState, type AppStateStatus } from 'react-native';

import { hasFastmailJmapToken } from '@/lib/fastmail-token';
import { keepFastmailConnectionWarm } from '@/lib/jmap-client';
import { observeEvent } from '@/lib/observability';

// Ping interval. Must be shorter than the shortest connection idle-death we
// see in the wild (NAT timeouts are often 30-60s; iOS pool staleness can be
// quicker), so 12s keeps a comfortable margin while staying cheap.
const KEEPALIVE_INTERVAL_MS = 12_000;

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
