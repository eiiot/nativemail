import { Stack, ThemeProvider, DarkTheme, DefaultTheme } from 'expo-router';
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

export const unstable_settings = {
  initialRouteName: 'folders',
};

export default function RootLayout() {
  const colorScheme = useColorScheme();

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
