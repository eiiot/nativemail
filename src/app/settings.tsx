import {
  clearFastmailJmapToken,
  hasFastmailJmapToken,
  saveFastmailJmapToken,
} from '@/lib/fastmail-token';
import { setDebugMode, useDebugMode } from '@/lib/debug-mode';
import {
  getNotificationRelayUrl,
  registerForInboxNotifications,
  sendInboxNotificationTest,
  unregisterInboxNotifications,
} from '@/lib/inbox-notifications';
import { describeJmapError, diagnoseFastmailJmap } from '@/lib/jmap-client';
import * as Updates from 'expo-updates';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  Switch,
  useColorScheme,
} from 'react-native';

const UPDATE_LABEL = 'settings-restored-1';

export default function SettingsScreen() {
  const dark = useColorScheme() === 'dark';
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [token, setToken] = useState('');
  const [status, setStatus] = useState('');
  const [diagnostic, setDiagnostic] = useState('');
  const [testing, setTesting] = useState(false);
  const [notificationBusy, setNotificationBusy] = useState(false);
  const [notificationRegistered, setNotificationRegistered] = useState(false);
  const [relayUrl, setRelayUrl] = useState('');
  const [notificationStatus, setNotificationStatus] = useState('');
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateStatus, setUpdateStatus] = useState('');
  const debugMode = useDebugMode();

  useEffect(() => {
    hasFastmailJmapToken()
      .then((value) => {
        setConfigured(value);
        setStatus(value ? 'Token configured' : 'No token configured');
      })
      .catch(() => setStatus('Secure storage unavailable'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    getNotificationRelayUrl()
      .then(setRelayUrl)
      .catch((error: unknown) => setNotificationStatus(describeJmapError(error)));
  }, []);

  const save = async () => {
    if (!token.trim() || saving) return;
    setSaving(true);
    try {
      await saveFastmailJmapToken(token);
      setToken('');
      setConfigured(true);
      setStatus('Token saved');
    } catch {
      setStatus('Could not save token');
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await clearFastmailJmapToken();
      setToken('');
      setConfigured(false);
      setStatus('Token cleared');
    } catch {
      setStatus('Could not clear token');
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    if (!configured || testing) return;
    setTesting(true);
    setDiagnostic('Testing Fastmail JMAP connection…');
    try {
      const report = await diagnoseFastmailJmap();
      setDiagnostic(report.steps.map((step) => `${step.status.toUpperCase()} ${step.label}\n${step.detail}`).join('\n\n'));
    } catch (error) {
      setDiagnostic(describeJmapError(error, { includeStack: true }));
    } finally {
      setTesting(false);
    }
  };

  const registerNotifications = async () => {
    if (!configured || !relayUrl.trim() || notificationBusy) return;
    setNotificationBusy(true);
    setNotificationStatus('Registering device…');
    try {
      const result = await registerForInboxNotifications(relayUrl);
      setRelayUrl(result.relayUrl);
      setNotificationRegistered(true);
      setNotificationStatus(result.status);
    } catch (error) {
      setNotificationRegistered(false);
      setNotificationStatus(describeJmapError(error));
    } finally {
      setNotificationBusy(false);
    }
  };

  const testNotifications = async () => {
    if (!relayUrl.trim() || notificationBusy) return;
    setNotificationBusy(true);
    setNotificationStatus('Sending test notification…');
    try {
      setNotificationStatus(await sendInboxNotificationTest(relayUrl));
    } catch (error) {
      setNotificationStatus(describeJmapError(error));
    } finally {
      setNotificationBusy(false);
    }
  };

  const stopNotifications = async () => {
    if (!relayUrl.trim() || notificationBusy) return;
    setNotificationBusy(true);
    try {
      setNotificationStatus(await unregisterInboxNotifications(relayUrl));
      setNotificationRegistered(false);
    } catch (error) {
      setNotificationStatus(describeJmapError(error));
    } finally {
      setNotificationBusy(false);
    }
  };

  const checkForUpdate = async () => {
    if (updateBusy) return;
    setUpdateBusy(true);
    setUpdateStatus('Checking for EAS update…');
    try {
      if (!Updates.isEnabled) {
        setUpdateStatus('EAS Updates are not enabled in this build.');
        return;
      }
      const result = await Updates.checkForUpdateAsync();
      if (!result.isAvailable) {
        setUpdateStatus('No update available.');
        return;
      }
      setUpdateStatus('Downloading update…');
      await Updates.fetchUpdateAsync();
      setUpdateStatus('Update downloaded. Reloading…');
      await Updates.reloadAsync();
    } catch (error) {
      setUpdateStatus(describeJmapError(error));
    } finally {
      setUpdateBusy(false);
    }
  };

  const colors = dark
    ? { background: '#090909', card: '#1c1c1e', text: '#f5f5f5', secondary: '#a8a8ae', input: '#2a2a2c' }
    : { background: '#f2f2f7', card: '#ffffff', text: '#111111', secondary: '#6e6e73', input: '#eeeeF0' };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.topRow}>
          <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.closeButton}>
            <Text style={styles.closeText}>×</Text>
          </Pressable>
          <Text style={[styles.updateLabel, { color: colors.secondary }]}>{UPDATE_LABEL}</Text>
        </View>

        <Text style={[styles.title, { color: colors.text }]}>Settings</Text>
        <View style={[styles.card, { backgroundColor: colors.card }]}>
          <Text style={[styles.cardTitle, { color: colors.text }]}>Fastmail API</Text>
          <Text style={[styles.subtitle, { color: colors.secondary }]}>JMAP token</Text>

          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={setToken}
            placeholder={configured ? 'Paste token to replace' : 'Paste Fastmail JMAP token'}
            placeholderTextColor={colors.secondary}
            secureTextEntry
            style={[styles.input, { backgroundColor: colors.input, color: colors.text }]}
            value={token}
          />

          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              disabled={!token.trim() || saving}
              onPress={save}
              style={[styles.primaryButton, (!token.trim() || saving) && styles.disabled]}>
              <Text style={styles.primaryText}>{saving ? 'Saving…' : 'Save Token'}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" disabled={saving} onPress={clear} style={styles.secondaryButton}>
              <Text style={[styles.secondaryText, { color: colors.text }]}>Clear</Text>
            </Pressable>
          </View>

          <View style={styles.statusRow}>
            {loading ? <ActivityIndicator size="small" /> : null}
            <Text style={[styles.status, { color: colors.secondary }]}>{status}</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            disabled={!configured || testing}
            onPress={testConnection}
            style={[styles.wideButton, (!configured || testing) && styles.disabled]}>
            <Text style={[styles.secondaryText, { color: colors.text }]}>{testing ? 'Testing…' : 'Test Connection'}</Text>
          </Pressable>
          {diagnostic ? <Text selectable style={[styles.report, { backgroundColor: colors.input, color: colors.text }]}>{diagnostic}</Text> : null}
        </View>

        <View style={[styles.card, { backgroundColor: colors.card }]}>
          <Text style={[styles.cardTitle, { color: colors.text }]}>Inbox notifications</Text>
          <Text style={[styles.subtitle, { color: colors.secondary }]}>Fly push relay for new Inbox mail</Text>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={setRelayUrl}
            placeholder="Notification relay URL"
            placeholderTextColor={colors.secondary}
            style={[styles.input, { backgroundColor: colors.input, color: colors.text }]}
            value={relayUrl}
          />
          <Pressable
            accessibilityRole="button"
            disabled={!configured || !relayUrl.trim() || notificationBusy}
            onPress={registerNotifications}
            style={[styles.primaryWideButton, (!configured || !relayUrl.trim() || notificationBusy) && styles.disabled]}>
            <Text style={styles.primaryText}>{notificationBusy ? 'Working…' : notificationRegistered ? 'Registered' : 'Register Device'}</Text>
          </Pressable>
          <View style={styles.actions}>
            <Pressable accessibilityRole="button" disabled={notificationBusy} onPress={testNotifications} style={styles.flexButton}>
              <Text style={[styles.secondaryText, { color: colors.text }]}>Send Test</Text>
            </Pressable>
            <Pressable accessibilityRole="button" disabled={notificationBusy} onPress={stopNotifications} style={styles.flexButton}>
              <Text style={[styles.secondaryText, { color: colors.text }]}>Stop</Text>
            </Pressable>
          </View>
          {notificationStatus ? <Text selectable style={[styles.report, { backgroundColor: colors.input, color: colors.text }]}>{notificationStatus}</Text> : null}
        </View>

        <View style={[styles.card, { backgroundColor: colors.card }]}>
          <Text style={[styles.cardTitle, { color: colors.text }]}>App updates</Text>
          <Text style={[styles.subtitle, { color: colors.secondary }]}>Pull the latest EAS update</Text>
          <Pressable accessibilityRole="button" disabled={updateBusy} onPress={checkForUpdate} style={styles.wideButton}>
            <Text style={[styles.secondaryText, { color: colors.text }]}>{updateBusy ? 'Checking…' : 'Check for EAS Update'}</Text>
          </Pressable>
          <Text selectable style={[styles.report, { backgroundColor: colors.input, color: colors.text }]}>
            {updateStatus || `channel: ${Updates.channel ?? 'none'}\nruntime: ${Updates.runtimeVersion ?? 'none'}\nupdate: ${Updates.updateId ?? 'embedded'}`}
          </Text>
        </View>

        <View style={[styles.card, styles.debugRow, { backgroundColor: colors.card }]}>
          <View style={styles.debugText}>
            <Text style={[styles.cardTitle, { color: colors.text }]}>Debug mode</Text>
            <Text style={[styles.subtitle, { color: colors.secondary }]}>Show render and navigation diagnostics</Text>
          </View>
          <Switch accessibilityLabel="Debug mode" onValueChange={setDebugMode} value={debugMode} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { flexGrow: 1, padding: 18, paddingTop: 12 },
  topRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between', minHeight: 52 },
  closeButton: { alignItems: 'center', backgroundColor: '#e5e5ea', borderRadius: 22, height: 44, justifyContent: 'center', width: 44 },
  closeText: { color: '#111111', fontSize: 36, fontWeight: '300', lineHeight: 39 },
  updateLabel: { fontSize: 12 },
  title: { fontSize: 32, fontWeight: '700', marginBottom: 22, marginTop: 18 },
  card: { borderRadius: 24, marginBottom: 14, padding: 18 },
  cardTitle: { fontSize: 17, fontWeight: '600' },
  subtitle: { fontSize: 14, marginBottom: 16, marginTop: 2 },
  input: { borderRadius: 14, fontSize: 15, minHeight: 48, paddingHorizontal: 14, paddingVertical: 12 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 14 },
  primaryButton: { alignItems: 'center', backgroundColor: '#0a84ff', borderRadius: 14, flex: 1, justifyContent: 'center', minHeight: 46 },
  disabled: { opacity: 0.35 },
  primaryText: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
  secondaryButton: { alignItems: 'center', backgroundColor: 'rgba(118,118,128,0.18)', borderRadius: 14, justifyContent: 'center', minHeight: 46, paddingHorizontal: 18 },
  secondaryText: { fontSize: 15, fontWeight: '600' },
  statusRow: { alignItems: 'center', flexDirection: 'row', gap: 8, marginTop: 16 },
  status: { fontSize: 13 },
  wideButton: { alignItems: 'center', backgroundColor: 'rgba(118,118,128,0.18)', borderRadius: 14, justifyContent: 'center', marginTop: 12, minHeight: 46 },
  primaryWideButton: { alignItems: 'center', backgroundColor: '#0a84ff', borderRadius: 14, justifyContent: 'center', marginTop: 12, minHeight: 46 },
  flexButton: { alignItems: 'center', backgroundColor: 'rgba(118,118,128,0.18)', borderRadius: 14, flex: 1, justifyContent: 'center', minHeight: 46 },
  report: { borderRadius: 12, fontFamily: 'Menlo', fontSize: 11, lineHeight: 15, marginTop: 12, padding: 12 },
  debugRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  debugText: { flex: 1, paddingRight: 12 },
});
