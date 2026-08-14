import { startConnectionKeepAlive } from '@/lib/connection-keepalive';
import { hydrateMailboxSnapshotFromCache } from '@/lib/mail-store';
import {
  handleInboxNotificationPayload,
  registerInboxNotificationBackgroundTask,
} from '@/lib/notification-background-task';
import {
  archiveInboxNotificationResponse,
  fetchInboxStateFromNotificationRelay,
  getNotificationMessageRoute,
  isArchiveInboxNotificationResponse,
  registerInboxNotificationCategories,
  repairInboxNotificationRegistration,
  syncInboxUnreadBadgeCount,
  syncPresentedInboxNotifications,
} from '@/lib/inbox-notifications';
import * as Notifications from 'expo-notifications';
import { Stack, ThemeProvider, DarkTheme, DefaultTheme, router, usePathname } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import {
  AppState,
  Text,
  TextInput,
  View,
  useColorScheme,
  type AppStateStatus,
  type GestureResponderEvent,
  type TextInputProps,
  type TextProps,
} from 'react-native';
import { KeyboardProvider } from 'react-native-keyboard-controller';

type TextWithDefaults = typeof Text & { defaultProps?: Partial<TextProps> };
type TextInputWithDefaults = typeof TextInput & { defaultProps?: Partial<TextInputProps> };

const APP_MAX_FONT_SIZE_MULTIPLIER = 1.12;
const DefaultText = Text as TextWithDefaults;
const DefaultTextInput = TextInput as TextInputWithDefaults;

DefaultText.defaultProps = {
  ...DefaultText.defaultProps,
  maxFontSizeMultiplier: APP_MAX_FONT_SIZE_MULTIPLIER,
};
DefaultTextInput.defaultProps = {
  ...DefaultTextInput.defaultProps,
  maxFontSizeMultiplier: APP_MAX_FONT_SIZE_MULTIPLIER,
};

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: false,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export const unstable_settings = {
  initialRouteName: 'folders',
};

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const pathname = usePathname();
  const settingsGestureGuardRef = useRef(false);

  const openSettingsSheet = useCallback(() => {
    if (pathname === '/settings' || settingsGestureGuardRef.current) {
      return;
    }

    settingsGestureGuardRef.current = true;
    router.push('/settings');
    setTimeout(() => {
      settingsGestureGuardRef.current = false;
    }, 800);
  }, [pathname]);

  const handleGlobalStartShouldSetResponderCapture = useCallback(
    (event: GestureResponderEvent) => {
      if (event.nativeEvent.touches.length >= 3) {
        openSettingsSheet();
      }

      return false;
    },
    [openSettingsSheet],
  );

  useEffect(() => {
    void hydrateMailboxSnapshotFromCache().catch(() => {});
  }, []);
  useEffect(() => {
    void registerInboxNotificationBackgroundTask().catch(() => {});
  }, []);
  useEffect(() => {
    void registerInboxNotificationCategories().catch(() => {});
    void repairInboxNotificationRegistration().catch(() => {});
  }, []);
  useEffect(() => {
    const subscription = Notifications.addNotificationReceivedListener((notification) => {
      const data = notification.request.content.data ?? null;

      void handleInboxNotificationPayload(data).catch(() => {});
    });

    return () => {
      subscription.remove();
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const syncNotificationState = (signal?: AbortSignal) => {
      void syncInboxUnreadBadgeCount(signal).catch(() => {});
      void syncPresentedInboxNotifications(signal).catch(() => {});
      void fetchInboxStateFromNotificationRelay(signal)
        .then((payload) => handleInboxNotificationPayload(payload))
        .catch(() => {});
    };
    const handleAppStateChange = (nextState: AppStateStatus) => {
      if (nextState === 'active') {
        syncNotificationState();
      }
    };

    syncNotificationState(controller.signal);
    const subscription = AppState.addEventListener('change', handleAppStateChange);

    return () => {
      controller.abort();
      subscription.remove();
    };
  }, []);
  useEffect(() => startConnectionKeepAlive(), []);
  useEffect(() => {
    const openNotificationMessage = (response: Notifications.NotificationResponse | null) => {
      if (response && isArchiveInboxNotificationResponse(response)) {
        Notifications.clearLastNotificationResponse();
        void archiveInboxNotificationResponse(response).catch(() => {});
        return;
      }

      const data = response?.notification.request.content.data;
      const route = data ? getNotificationMessageRoute(data) : null;

      if (route) {
        Notifications.clearLastNotificationResponse();
        void handleInboxNotificationPayload(data ?? null).catch(() => {});
        router.push(route);
      }
    };
    const subscription = Notifications.addNotificationResponseReceivedListener(openNotificationMessage);

    Notifications.getLastNotificationResponseAsync()
      .then(openNotificationMessage)
      .catch(() => {});

    return () => {
      subscription.remove();
    };
  }, []);

  return (
    <KeyboardProvider>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <View onStartShouldSetResponderCapture={handleGlobalStartShouldSetResponderCapture} style={{ flex: 1 }}>
          <Stack screenOptions={{ gestureEnabled: true, headerShown: false }}>
            <Stack.Screen name="folders" options={{ animation: 'slide_from_left' }} />
            <Stack.Screen name="index" />
            <Stack.Screen name="message/[id]" />
            <Stack.Screen name="search-pill-lab" />
            <Stack.Screen
              name="settings"
              options={{
                presentation: 'formSheet',
                sheetAllowedDetents: [0.88, 1],
                sheetCornerRadius: 34,
                sheetExpandsWhenScrolledToEdge: false,
                sheetGrabberVisible: true,
                sheetInitialDetentIndex: 0,
              }}
            />
            <Stack.Screen
              name="compose"
              options={{
                presentation: 'formSheet',
                sheetAllowedDetents: [1],
                sheetCornerRadius: 34,
                sheetExpandsWhenScrolledToEdge: false,
                sheetGrabberVisible: true,
                sheetInitialDetentIndex: 0,
              }}
            />
          </Stack>
        </View>
      </ThemeProvider>
    </KeyboardProvider>
  );
}
