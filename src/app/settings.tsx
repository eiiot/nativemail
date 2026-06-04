import {
  clearFastmailJmapToken,
  hasFastmailJmapToken,
  saveFastmailJmapToken,
} from '@/lib/fastmail-token';
import { setDebugMode, useDebugMode } from '@/lib/debug-mode';
import { describeJmapError, diagnoseFastmailJmap } from '@/lib/jmap-client';
import * as Haptics from 'expo-haptics';
import { Stack, router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  useColorScheme,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const tint = '#0A84FF';
const textScale = { maxFontSizeMultiplier: 1.12 };
const systemFont = Platform.select({ ios: 'system-ui', default: undefined });
const pressHaptic = () => {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
};

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const scheme = useColorScheme();
  const colors = scheme === 'dark' ? darkColors : lightColors;
  const debugMode = useDebugMode();
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [diagnosticText, setDiagnosticText] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [statusText, setStatusText] = useState('');
  const canSave = tokenInput.trim().length > 0 && !saving;
  const canTest = configured && !saving && !testing;

  useEffect(() => {
    let mounted = true;

    hasFastmailJmapToken()
      .then((nextConfigured) => {
        if (!mounted) {
          return;
        }

        setConfigured(nextConfigured);
        setStatusText(nextConfigured ? 'Token configured' : 'No token configured');
      })
      .catch(() => {
        if (!mounted) {
          return;
        }

        setConfigured(false);
        setStatusText('Secure storage unavailable');
      })
      .finally(() => {
        if (mounted) {
          setLoading(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  const close = () => {
    pressHaptic();
    router.back();
  };
  const save = async () => {
    if (!canSave) {
      return;
    }

    pressHaptic();
    setSaving(true);

    try {
      await saveFastmailJmapToken(tokenInput);
      setTokenInput('');
      setDiagnosticText('');
      setConfigured(true);
      setStatusText('Token saved');
    } catch {
      setStatusText('Could not save token');
    } finally {
      setSaving(false);
    }
  };
  const clear = async () => {
    pressHaptic();
    setSaving(true);

    try {
      await clearFastmailJmapToken();
      setTokenInput('');
      setDiagnosticText('');
      setConfigured(false);
      setStatusText('Token cleared');
    } catch {
      setStatusText('Could not clear token');
    } finally {
      setSaving(false);
    }
  };
  const testConnection = async () => {
    if (!canTest) {
      return;
    }

    pressHaptic();
    setTesting(true);
    setDiagnosticText('Testing Fastmail JMAP connection...');

    try {
      const report = await diagnoseFastmailJmap();
      setDiagnosticText(formatDiagnosticReport(report.steps));
    } catch (error) {
      setDiagnosticText(`ERROR JMAP diagnostic crashed\n${describeJmapError(error, { includeStack: true })}`);
    } finally {
      setTesting(false);
    }
  };
  const updateDebugMode = (enabled: boolean) => {
    pressHaptic();
    setDebugMode(enabled);
  };

  return (
    <>
      <Stack.Header
        transparent
        style={{
          backgroundColor: 'transparent',
          color: colors.text,
          shadowColor: 'transparent',
        }}
      />
      <Stack.Title>{''}</Stack.Title>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button
          icon="chevron.left"
          onPress={close}
          separateBackground
          tintColor={colors.text}
        />
      </Stack.Toolbar>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={[styles.root, { backgroundColor: colors.background }]}>
        <ScrollView
          contentContainerStyle={[
            styles.content,
            {
              paddingBottom: Math.max(40, insets.bottom + 24),
              paddingTop: insets.top + 70,
            },
          ]}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}>
          <Text {...textScale} style={[styles.title, { color: colors.text }]}>Settings</Text>

          <View style={[styles.card, { backgroundColor: colors.card }]}>
            <View style={styles.cardHeader}>
              <View>
                <Text {...textScale} style={[styles.cardTitle, { color: colors.text }]}>
                  Fastmail API
                </Text>
                <Text {...textScale} style={[styles.cardSubtitle, { color: colors.secondaryText }]}>
                  JMAP token for development
                </Text>
              </View>
              <View
                style={[
                  styles.statusBadge,
                  { backgroundColor: configured ? colors.configuredBadge : colors.missingBadge },
                ]}>
                {loading ? (
                  <ActivityIndicator color={configured ? colors.configuredText : colors.missingText} size="small" />
                ) : (
                  <SymbolView
                    name={configured ? 'checkmark' : 'exclamationmark'}
                    tintColor={configured ? colors.configuredText : colors.missingText}
                    size={13}
                    weight="bold"
                  />
                )}
              </View>
            </View>

            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              maxFontSizeMultiplier={1.12}
              onChangeText={setTokenInput}
              placeholder={configured ? 'Paste token to replace' : 'Paste Fastmail JMAP token'}
              placeholderTextColor={colors.placeholder}
              returnKeyType="done"
              secureTextEntry
              selectionColor={tint}
              style={[
                styles.tokenInput,
                {
                  backgroundColor: colors.inputBackground,
                  color: colors.text,
                },
              ]}
              textContentType="password"
              value={tokenInput}
            />

            <View style={styles.actionRow}>
              <Pressable
                accessibilityRole="button"
                disabled={!canSave}
                onPress={save}
                style={({ pressed }) => [
                  styles.primaryButton,
                  { backgroundColor: canSave ? tint : colors.disabledButton },
                  pressed && styles.pressed,
                ]}>
                <Text {...textScale} style={[styles.primaryButtonText, { color: colors.primaryButtonText }]}>
                  {saving ? 'Saving' : 'Save Token'}
                </Text>
              </Pressable>

              <Pressable
                accessibilityRole="button"
                disabled={saving || (!configured && !tokenInput)}
                onPress={clear}
                style={({ pressed }) => [
                  styles.secondaryButton,
                  { backgroundColor: colors.secondaryButton },
                  pressed && styles.pressed,
                ]}>
                <Text {...textScale} style={[styles.secondaryButtonText, { color: colors.text }]}>Clear</Text>
              </Pressable>
            </View>

            <Pressable
              accessibilityRole="button"
              disabled={!canTest}
              onPress={testConnection}
              style={({ pressed }) => [
                styles.testButton,
                { backgroundColor: canTest ? colors.secondaryButton : colors.disabledButton },
                pressed && styles.pressed,
              ]}>
              <Text {...textScale} style={[styles.secondaryButtonText, { color: colors.text }]}>
                {testing ? 'Testing Connection' : 'Test Connection'}
              </Text>
            </Pressable>

            <Text {...textScale} style={[styles.statusText, { color: colors.secondaryText }]}>
              {statusText || 'No token configured'}
            </Text>

            {diagnosticText ? (
              <Text
                {...textScale}
                selectable
                style={[
                  styles.diagnosticText,
                  {
                    backgroundColor: colors.inputBackground,
                    color: colors.text,
                  },
                ]}>
                {diagnosticText}
              </Text>
            ) : null}
          </View>

          <View style={[styles.card, styles.debugCard, { backgroundColor: colors.card }]}>
            <View style={styles.debugRow}>
              <View style={styles.debugTextBlock}>
                <Text {...textScale} style={[styles.cardTitle, { color: colors.text }]}>
                  Debug mode
                </Text>
                <Text {...textScale} style={[styles.cardSubtitle, { color: colors.secondaryText }]}>
                  Show render diagnostics in messages
                </Text>
              </View>
              <Switch
                accessibilityLabel="Debug mode"
                onValueChange={updateDebugMode}
                trackColor={{ false: colors.switchTrackOff, true: colors.switchTrackOn }}
                thumbColor={colors.switchThumb}
                value={debugMode}
              />
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  );
}

function formatDiagnosticReport(steps: Awaited<ReturnType<typeof diagnoseFastmailJmap>>['steps']) {
  return steps
    .map((step) => `${step.status.toUpperCase()} ${step.label}\n${step.detail}`)
    .join('\n\n');
}

type ColorSet = typeof lightColors;

const lightColors = {
  background: '#F8F8F9',
  card: '#FFFFFF',
  text: '#050505',
  secondaryText: '#7E7E82',
  placeholder: '#9B9BA1',
  inputBackground: '#F0F0F3',
  configuredBadge: 'rgba(52, 199, 89, 0.18)',
  configuredText: '#1F8F3A',
  missingBadge: 'rgba(255, 149, 0, 0.2)',
  missingText: '#C46A00',
  disabledButton: 'rgba(118, 118, 128, 0.2)',
  primaryButtonText: '#FFFFFF',
  secondaryButton: 'rgba(118, 118, 128, 0.14)',
  switchThumb: '#FFFFFF',
  switchTrackOff: 'rgba(118, 118, 128, 0.3)',
  switchTrackOn: tint,
};

const darkColors: ColorSet = {
  background: '#090909',
  card: '#1C1C1E',
  text: '#F5F5F5',
  secondaryText: '#A8A8AE',
  placeholder: '#77777D',
  inputBackground: '#2A2A2C',
  configuredBadge: 'rgba(52, 199, 89, 0.24)',
  configuredText: '#4BD966',
  missingBadge: 'rgba(255, 149, 0, 0.24)',
  missingText: '#FFB340',
  disabledButton: 'rgba(118, 118, 128, 0.24)',
  primaryButtonText: '#FFFFFF',
  secondaryButton: 'rgba(118, 118, 128, 0.28)',
  switchThumb: '#FFFFFF',
  switchTrackOff: 'rgba(118, 118, 128, 0.34)',
  switchTrackOn: tint,
};

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 18,
  },
  title: {
    fontFamily: systemFont,
    fontSize: 32,
    fontWeight: '700',
    letterSpacing: 0,
    lineHeight: 36,
    marginBottom: 22,
  },
  card: {
    borderRadius: 24,
    padding: 18,
  },
  debugCard: {
    marginTop: 14,
  },
  debugRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 14,
    justifyContent: 'space-between',
  },
  debugTextBlock: {
    flex: 1,
  },
  cardHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  cardTitle: {
    fontFamily: systemFont,
    fontSize: 17,
    fontWeight: '600',
    lineHeight: 22,
  },
  cardSubtitle: {
    fontFamily: systemFont,
    fontSize: 14,
    fontWeight: '400',
    lineHeight: 18,
    marginTop: 2,
  },
  statusBadge: {
    alignItems: 'center',
    borderRadius: 15,
    height: 30,
    justifyContent: 'center',
    width: 30,
  },
  tokenInput: {
    borderRadius: 14,
    fontFamily: systemFont,
    fontSize: 15,
    fontWeight: '400',
    lineHeight: 20,
    minHeight: 48,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 14,
  },
  primaryButton: {
    alignItems: 'center',
    borderRadius: 14,
    flex: 1,
    justifyContent: 'center',
    minHeight: 46,
    paddingHorizontal: 16,
  },
  primaryButtonText: {
    fontFamily: systemFont,
    fontSize: 15,
    fontWeight: '600',
    lineHeight: 20,
  },
  secondaryButton: {
    alignItems: 'center',
    borderRadius: 14,
    justifyContent: 'center',
    minHeight: 46,
    paddingHorizontal: 18,
  },
  testButton: {
    alignItems: 'center',
    borderRadius: 14,
    justifyContent: 'center',
    marginTop: 10,
    minHeight: 46,
    paddingHorizontal: 16,
  },
  secondaryButtonText: {
    fontFamily: systemFont,
    fontSize: 15,
    fontWeight: '500',
    lineHeight: 20,
  },
  statusText: {
    fontFamily: systemFont,
    fontSize: 13,
    fontWeight: '400',
    lineHeight: 18,
    marginTop: 12,
  },
  diagnosticText: {
    borderRadius: 14,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    fontSize: 12,
    fontWeight: '400',
    lineHeight: 17,
    marginTop: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  pressed: {
    opacity: 0.74,
  },
});
