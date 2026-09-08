import { describe, expect, it } from 'vitest';

import {
  FOREGROUND_MESSAGE_BODY_FETCH_MAX_ATTEMPTS,
  isRetriableMessageBodyFetchError,
} from '../message-body-retry';

describe('message body retry policy', () => {
  it('keeps foreground recovery alive through a transient relay outage', () => {
    expect(FOREGROUND_MESSAGE_BODY_FETCH_MAX_ATTEMPTS).toBe(5);
    expect(isRetriableMessageBodyFetchError(new Error('Message relay failed with HTTP 500.'))).toBe(true);
    expect(isRetriableMessageBodyFetchError(new Error('Fastmail proxy request timed out'))).toBe(true);
    expect(isRetriableMessageBodyFetchError(new Error('Network request failed'))).toBe(true);
  });

  it('does not retry permanent client errors', () => {
    expect(isRetriableMessageBodyFetchError(new Error('Message relay failed with HTTP 401.'))).toBe(false);
    expect(isRetriableMessageBodyFetchError(new Error('JMAP Email/get: notFound'))).toBe(false);
  });
});
