import { hydrateMailboxSnapshotFromCache } from '@/lib/mail-store';
import { getNotificationMessageRoute } from '@/lib/inbox-notifications';
import * as Notifications from 'expo-notifications';
import { Stack, ThemeProvider, DarkTheme, DefaultTheme, router } from 'expo-router';
import { useEffect } from 'react';
import { Text, TextInput, useColorScheme, type TextInputProps, type TextProps } from 'react-native';
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
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export const unstable_settings = {
  initialRouteName: 'folders',
};

export default function RootLayout() {
  const colorScheme = useColorScheme();

  useEffect(() => {
    void hydrateMailboxSnapshotFromCache().catch(() => {});
  }, []);
  useEffect(() => {
    const openNotificationMessage = (response: Notifications.NotificationResponse | null) => {
      const data = response?.notification.request.content.data;
      const route = data ? getNotificationMessageRoute(data) : null;

      if (route) {
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
        <Stack screenOptions={{ gestureEnabled: true, headerShown: false }}>
          <Stack.Screen name="folders" options={{ animation: 'slide_from_left' }} />
          <Stack.Screen name="index" />
          <Stack.Screen name="message/[id]" />
          <Stack.Screen name="settings" />
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
      </ThemeProvider>
    </KeyboardProvider>
  );
}
