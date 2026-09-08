export const FOREGROUND_MESSAGE_BODY_FETCH_MAX_ATTEMPTS = 5;
export const FOREGROUND_MESSAGE_BODY_FETCH_RETRY_DELAYS_MS = [250, 1000, 2500, 5000];

export function isRetriableMessageBodyFetchError(error: unknown) {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();

  return (
    message.includes('network connection was lost') ||
    message.includes('network request failed') ||
    message.includes('fetch failed') ||
    message.includes('timed out') ||
    message.includes('the request timed out') ||
    message.includes('offline') ||
    message.includes('connection reset') ||
    message.includes('connection closed') ||
    /http 50[0234]\b/.test(message)
  );
}
