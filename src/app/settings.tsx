import {
  clearFastmailJmapToken,
  hasFastmailJmapToken,
  saveFastmailJmapToken,
} from '@/lib/fastmail-token';
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
  useColorScheme,
} from 'react-native';

const UPDATE_LABEL = 'settings-hotfix-2';

export default function SettingsScreen() {
  const dark = useColorScheme() === 'dark';
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [token, setToken] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    hasFastmailJmapToken()
      .then((value) => {
        setConfigured(value);
        setStatus(value ? 'Token configured' : 'No token configured');
      })
      .catch(() => setStatus('Secure storage unavailable'))
      .finally(() => setLoading(false));
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
  card: { borderRadius: 24, padding: 18 },
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
});
