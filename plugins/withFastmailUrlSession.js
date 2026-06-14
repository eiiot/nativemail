const { withAppDelegate } = require('@expo/config-plugins');

const MARKER = 'fastmail-url-session-config';

// Registers a custom URLSessionConfiguration for expo/fetch (the engine behind
// the global `fetch` on SDK 56) so dead, reused HTTP/2 connections fail fast
// instead of black-holing for seconds-to-minutes.
//
// timeoutIntervalForRequest is an INACTIVITY timer (it resets on every byte
// received), not a wall-clock cap. A connection that iOS reclaimed during
// background — or that a NAT dropped — delivers zero bytes, so it hits this
// timeout and iOS evicts it; the retry then opens a fresh connection (~240ms).
// A healthy slow response keeps the timer alive because bytes keep arriving,
// so this does not falsely abort legitimate transfers.
const REGISTRATION = `    // ${MARKER}
    MainActor.assumeIsolated {
      ExpoFetchCustomExtension.setCustomURLSessionConfigurationProvider {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 5
        configuration.waitsForConnectivity = true
        configuration.httpShouldSetCookies = true
        configuration.httpCookieAcceptPolicy = .always
        configuration.httpCookieStorage = HTTPCookieStorage.shared
        return configuration
      }
    }
`;

const ANCHOR = 'let delegate = ReactNativeDelegate()';

function withFastmailUrlSession(config) {
  return withAppDelegate(config, (config) => {
    let contents = config.modResults.contents;

    if (contents.includes(MARKER)) {
      return config;
    }

    if (!contents.includes(ANCHOR)) {
      throw new Error(
        `withFastmailUrlSession: could not find AppDelegate anchor "${ANCHOR}"`,
      );
    }

    contents = contents.replace(ANCHOR, `${REGISTRATION}\n    ${ANCHOR}`);
    config.modResults.contents = contents;
    return config;
  });
}

module.exports = withFastmailUrlSession;
