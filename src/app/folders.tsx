import { describeJmapError, fetchJmapMailboxes, type JmapMailbox } from '@/lib/jmap-client';
import {
  getInboxUnreadCountFromMailboxes,
  setInboxUnreadBadgeCount,
} from '@/lib/inbox-notifications';
import { markNavigationTrace, startNavigationTrace } from '@/lib/navigation-debug';
import * as Haptics from 'expo-haptics';
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { ComponentProps, useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  InteractionManager,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useColorScheme,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type FolderRow = {
  id: string;
  icon: ComponentProps<typeof SymbolView>['name'];
  label: string;
  mailboxId?: string;
  role?: string | null;
  systemKey?: SystemMailboxKey;
  count?: string;
  color: string;
  muted?: boolean;
};

type FolderSections = {
  folders: FolderRow[];
  mailboxes: FolderRow[];
};

type SystemMailboxKey =
  | 'inbox'
  | 'snoozed'
  | 'archive'
  | 'drafts'
  | 'scheduled'
  | 'sent'
  | 'spam'
  | 'trash';

const textScale = { maxFontSizeMultiplier: 1.12 };
const systemFont = Platform.select({ ios: 'system-ui', default: undefined });
const pressHaptic = () => {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
};
const prefetchedMailboxTimes = new Map<string, number>();
const mailboxNavigationGuardMs = 2500;

const systemMailboxOrder: SystemMailboxKey[] = [
  'inbox',
  'snoozed',
  'archive',
  'drafts',
  'scheduled',
  'sent',
  'spam',
  'trash',
];

const systemMailboxConfig: Record<
  SystemMailboxKey,
  {
    color: string;
    icon: ComponentProps<typeof SymbolView>['name'];
    label: string;
    muted?: boolean;
  }
> = {
  inbox: { color: '#007AFF', icon: 'tray', label: 'Inbox' },
  snoozed: { color: '#A05CE5', icon: 'clock', label: 'Snoozed' },
  archive: { color: '#8E00D8', icon: 'archivebox', label: 'Archive' },
  drafts: { color: '#08AFC4', icon: 'doc.text', label: 'Drafts' },
  scheduled: { color: '#FF8A00', icon: 'calendar', label: 'Scheduled' },
  sent: { color: '#079520', icon: 'paperplane', label: 'Sent' },
  spam: { color: '#8A5A2B', icon: 'exclamationmark.octagon', label: 'Spam' },
  trash: { color: '#D77A7A', icon: 'trash', label: 'Trash', muted: true },
};

const systemRoleToKey: Record<string, SystemMailboxKey> = {
  archive: 'archive',
  drafts: 'drafts',
  inbox: 'inbox',
  junk: 'spam',
  scheduled: 'scheduled',
  sent: 'sent',
  snoozed: 'snoozed',
  trash: 'trash',
};

const systemNameToKey: Record<string, SystemMailboxKey> = {
  allarchive: 'archive',
  archive: 'archive',
  drafts: 'drafts',
  inbox: 'inbox',
  junk: 'spam',
  junkmail: 'spam',
  scheduled: 'scheduled',
  scheduledmail: 'scheduled',
  scheduledmessages: 'scheduled',
  scheduledsend: 'scheduled',
  sent: 'sent',
  sentmail: 'sent',
  snoozed: 'snoozed',
  snoozedmail: 'snoozed',
  snoozedmessages: 'snoozed',
  spam: 'spam',
  trash: 'trash',
};

const mockMailboxRows: FolderRow[] = systemMailboxOrder.map((systemKey) => ({
  color: systemMailboxConfig[systemKey].color,
  icon: systemMailboxConfig[systemKey].icon,
  id: systemKey,
  label: systemMailboxConfig[systemKey].label,
  muted: systemMailboxConfig[systemKey].muted,
  role: systemKey === 'spam' ? 'junk' : systemKey,
  systemKey,
}));

const mockFolderRows: FolderRow[] = [
  { id: 'projects', icon: 'folder', label: 'Projects', color: '#707070' },
  { id: 'receipts', icon: 'folder', label: 'Receipts', color: '#707070' },
  { id: 'travel', icon: 'folder', label: 'Travel', color: '#707070' },
];

export default function FoldersScreen() {
  const { returnMailboxId, returnMailboxRole } = useLocalSearchParams<{
    returnMailboxId?: string;
    returnMailboxRole?: string;
  }>();
  const insets = useSafeAreaInsets();
  const scheme = useColorScheme();
  const colors = scheme === 'dark' ? darkColors : lightColors;
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
  const [jmapLoading, setJmapLoading] = useState(true);
  const [jmapStatus, setJmapStatus] = useState('');
  const [liveSections, setLiveSections] = useState<FolderSections | null>(null);
  const pendingMailboxNavigationKeyRef = useRef<string | null>(null);
  const pendingMailboxNavigationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mailboxRows = liveSections?.mailboxes ?? mockMailboxRows;
  const folderRows = liveSections?.folders ?? mockFolderRows;
  const clearPendingMailboxNavigation = useCallback(() => {
    pendingMailboxNavigationKeyRef.current = null;

    if (pendingMailboxNavigationTimerRef.current) {
      clearTimeout(pendingMailboxNavigationTimerRef.current);
      pendingMailboxNavigationTimerRef.current = null;
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      clearPendingMailboxNavigation();
    }, [clearPendingMailboxNavigation]),
  );
  useEffect(() => clearPendingMailboxNavigation, [clearPendingMailboxNavigation]);

  useEffect(() => {
    const controller = new AbortController();

    Promise.resolve().then(() => {
      if (!controller.signal.aborted) {
        setJmapLoading(true);
        setJmapStatus('');
      }
    });

    fetchJmapMailboxes(controller.signal)
      .then((mailboxes) => {
        setLiveSections(getFolderSections(mailboxes));
        void setInboxUnreadBadgeCount(getInboxUnreadCountFromMailboxes(mailboxes)).catch(() => {});
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }

        setLiveSections(null);
        setJmapStatus(error instanceof Error && error.name === 'FastmailJmapTokenMissingError'
          ? ''
          : `Using mock folders: ${describeJmapError(error)}`);
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setJmapLoading(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, []);
  useEffect(() => {
    if (returnMailboxId || returnMailboxRole) {
      return;
    }

    const inboxRow = liveSections?.mailboxes.find((row) => row.systemKey === 'inbox' || row.role === 'inbox');

    if (!inboxRow) {
      return;
    }

    const prefetchTask = InteractionManager.runAfterInteractions(() => {
      prefetchMailbox(inboxRow, 'folders idle');
    });

    return () => {
      prefetchTask.cancel();
    };
  }, [liveSections, returnMailboxId, returnMailboxRole]);

  const openCompose = () => {
    pressHaptic();
    router.push('/compose');
  };
  const openSettings = () => {
    pressHaptic();
    router.navigate({ pathname: '/settings' });
  };
  const openMailbox = (row: FolderRow) => {
    const mailboxId = row.mailboxId ?? row.id;
    const mailboxRole = row.role ?? row.systemKey ?? null;
    const navigationKey = getMailboxNavigationKey(row);
    const traceDetail = getFolderNavigationTraceDetail(row);

    if (pendingMailboxNavigationKeyRef.current === navigationKey) {
      markNavigationTrace('duplicate mailbox tap ignored', traceDetail);
      return;
    }

    pendingMailboxNavigationKeyRef.current = navigationKey;

    if (pendingMailboxNavigationTimerRef.current) {
      clearTimeout(pendingMailboxNavigationTimerRef.current);
    }

    pendingMailboxNavigationTimerRef.current = setTimeout(() => {
      clearPendingMailboxNavigation();
    }, mailboxNavigationGuardMs);

    pressHaptic();
    const canReturn = router.canGoBack();
    const isReturnMailbox =
      returnMailboxId === mailboxId || Boolean(returnMailboxRole && returnMailboxRole === mailboxRole);

    markNavigationTrace('press released', traceDetail);
    markNavigationTrace(
      'router decision',
      `canGoBack=${canReturn} isReturnMailbox=${isReturnMailbox} returnId=${returnMailboxId ?? 'none'} returnRole=${returnMailboxRole ?? 'none'}`,
    );

    if (canReturn && isReturnMailbox) {
      markNavigationTrace('router.back start', traceDetail);
      router.back();
      markNavigationTrace('router.back returned', traceDetail);
      return;
    }

    markNavigationTrace('router.push start', traceDetail);
    router.push({
      pathname: '/',
      params: {
        mailboxId,
        mailboxName: row.label,
      },
    });
    markNavigationTrace('router.push returned', traceDetail);
  };
  const beginMailboxPress = (row: FolderRow) => {
    if (pendingMailboxNavigationKeyRef.current === getMailboxNavigationKey(row)) {
      return;
    }

    startNavigationTrace('Folders -> Mailbox', getFolderNavigationTraceDetail(row));
  };
  const toggleSection = (id: string) => {
    pressHaptic();
    setCollapsedSections((current) => ({ ...current, [id]: !current[id] }));
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
          accessibilityLabel="Settings"
          icon="gearshape"
          onPress={openSettings}
          separateBackground
          tintColor={colors.text}
        />
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          onPress={pressHaptic}
          separateBackground
          style={{ color: colors.text, fontFamily: systemFont, fontSize: 16, fontWeight: '500' }}
          tintColor={colors.text}>
          Edit
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Stack.Toolbar placement="bottom">
        <Stack.Toolbar.Spacer />
        <Stack.Toolbar.Button
          icon="square.and.pencil"
          onPress={openCompose}
          separateBackground
          tintColor={colors.text}
        />
      </Stack.Toolbar>

      <View style={[styles.root, { backgroundColor: colors.background }]}>
        <ScrollView
          contentContainerStyle={[
            styles.content,
            {
              paddingBottom: Math.max(126, insets.bottom + 96),
              paddingTop: insets.top + 70,
            },
          ]}
          showsVerticalScrollIndicator={false}>
          <Text {...textScale} style={[styles.title, { color: colors.text }]}>Folders</Text>
          {jmapLoading ? (
            <ActivityIndicator color="#007AFF" size="small" style={styles.statusIndicator} />
          ) : null}
          {jmapStatus ? (
            <Text {...textScale} style={[styles.statusText, { color: colors.secondaryText }]}>
              {jmapStatus}
            </Text>
          ) : null}

          <FolderSection
            collapsed={collapsedSections.mailboxes}
            colors={colors}
            id="mailboxes"
            label="Mailboxes"
            onRowPressIn={liveSections ? beginMailboxPress : undefined}
            onRowPress={liveSections ? openMailbox : undefined}
            rows={mailboxRows}
            onToggle={toggleSection}
          />
          <FolderSection
            collapsed={collapsedSections.folders}
            colors={colors}
            emptyLabel="No folders"
            id="folders"
            label="Folders"
            onRowPressIn={liveSections ? beginMailboxPress : undefined}
            onRowPress={liveSections ? openMailbox : undefined}
            rows={folderRows}
            onToggle={toggleSection}
          />
        </ScrollView>
      </View>
    </>
  );
}

function FolderSection({
  collapsed,
  colors,
  emptyLabel,
  id,
  label,
  onRowPress,
  onRowPressIn,
  onToggle,
  rows,
}: {
  collapsed?: boolean;
  colors: ColorSet;
  emptyLabel?: string;
  id: string;
  label: string;
  onRowPress?: (row: FolderRow) => void;
  onRowPressIn?: (row: FolderRow) => void;
  onToggle: (id: string) => void;
  rows: FolderRow[];
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text {...textScale} style={[styles.sectionLabel, { color: colors.secondaryText }]}>{label}</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => onToggle(id)}
          style={({ pressed }) => [styles.sectionChevron, pressed && styles.pressed]}>
          <SymbolView
            name={collapsed ? 'chevron.right' : 'chevron.down'}
            tintColor="#FFFFFF"
            size={9}
            weight="bold"
          />
        </Pressable>
      </View>
      {collapsed ? null : (
        <View style={[styles.card, { backgroundColor: colors.card }]}>
          {rows.length ? (
            rows.map((row, index) => (
              <FolderListRow
                colors={colors}
                isLast={index === rows.length - 1}
                key={row.id}
                onPressIn={onRowPressIn ? () => onRowPressIn(row) : undefined}
                onPress={onRowPress ? () => onRowPress(row) : undefined}
                row={row}
              />
            ))
          ) : (
            <Text {...textScale} style={[styles.emptyText, { color: colors.secondaryText }]}>
              {emptyLabel ?? 'No mailboxes'}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

function getFolderSections(mailboxes: JmapMailbox[]): FolderSections {
  const systemRows = new Map<SystemMailboxKey, FolderRow>();
  const folderRows: FolderRow[] = [];

  for (const mailbox of mailboxes) {
    const systemKey = getSystemMailboxKey(mailbox);
    const row = mapMailboxToRow(mailbox, systemKey);

    if (systemKey) {
      systemRows.set(systemKey, row);
    } else {
      folderRows.push(row);
    }
  }

  return {
    folders: folderRows,
    mailboxes: systemMailboxOrder
      .map((systemKey) => systemRows.get(systemKey))
      .filter((row): row is FolderRow => Boolean(row)),
  };
}

function getFolderNavigationTraceDetail(row: FolderRow) {
  const mailboxId = row.mailboxId ?? row.id;
  const mailboxRole = row.role ?? row.systemKey ?? null;
  const prefetchedAt = prefetchedMailboxTimes.get(mailboxId);
  const prefetchDetail = prefetchedAt
    ? `prefetched=${Math.round(nowMs() - prefetchedAt)}ms`
    : 'prefetched=no';

  return `mailbox=${row.label} id=${mailboxId} role=${mailboxRole ?? 'none'} ${prefetchDetail}`;
}

function getMailboxNavigationKey(row: FolderRow) {
  return row.mailboxId ?? row.id;
}

function getMailboxHref(row: FolderRow) {
  return {
    pathname: '/' as const,
    params: {
      mailboxId: row.mailboxId ?? row.id,
      mailboxName: row.label,
    },
  };
}

function prefetchMailbox(row: FolderRow, reason: string) {
  const mailboxId = row.mailboxId ?? row.id;
  const traceDetail = getFolderNavigationTraceDetail(row);

  markNavigationTrace(`router.prefetch ${reason} start`, traceDetail);
  router.prefetch(getMailboxHref(row));
  prefetchedMailboxTimes.set(mailboxId, nowMs());
  markNavigationTrace(`router.prefetch ${reason} returned`, traceDetail);
}

function nowMs() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function getSystemMailboxKey(mailbox: JmapMailbox): SystemMailboxKey | null {
  const role = mailbox.role?.toLowerCase();

  if (role && systemRoleToKey[role]) {
    return systemRoleToKey[role];
  }

  return systemNameToKey[normalizeMailboxName(mailbox.name)] ?? null;
}

function normalizeMailboxName(name: string) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function mapMailboxToRow(mailbox: JmapMailbox, systemKey: SystemMailboxKey | null): FolderRow {
  const systemConfig = systemKey ? systemMailboxConfig[systemKey] : null;

  return {
    color: systemConfig?.color ?? '#707070',
    count: formatMailboxCount(mailbox.unreadEmails),
    icon: systemConfig?.icon ?? 'folder',
    id: mailbox.id,
    label: systemConfig?.label ?? mailbox.name,
    mailboxId: mailbox.id,
    muted: systemConfig?.muted,
    role: mailbox.role,
    systemKey: systemKey ?? undefined,
  };
}

function formatMailboxCount(count: number) {
  if (!count) {
    return undefined;
  }

  return count > 300 ? '300+' : String(count);
}

function FolderListRow({
  colors,
  isLast,
  onPress,
  onPressIn,
  row,
}: {
  colors: ColorSet;
  isLast: boolean;
  onPress?: () => void;
  onPressIn?: () => void;
  row: FolderRow;
}) {
  const content = (
    <>
      <View style={styles.folderIconSlot}>
        <SymbolView name={row.icon} tintColor={row.muted ? colors.mutedIcon : row.color} size={30} weight="regular" />
      </View>
      <View
        style={[
          styles.folderTextCell,
          !isLast && {
            borderBottomColor: colors.separator,
            borderBottomWidth: StyleSheet.hairlineWidth,
          },
        ]}>
        <Text
          {...textScale}
          numberOfLines={1}
          style={[styles.folderLabel, { color: row.muted ? colors.secondaryText : colors.text }]}>
          {row.label}
        </Text>
        <View style={styles.folderTrailing}>
          {row.count ? (
            <Text {...textScale} style={[styles.folderCount, { color: colors.secondaryText }]}>
              {row.count}
            </Text>
          ) : null}
          <SymbolView name="chevron.right" tintColor={colors.chevron} size={18} weight="semibold" />
        </View>
      </View>
    </>
  );

  return onPress ? (
    <Pressable
      onPress={onPress}
      onPressIn={onPressIn}
      style={({ pressed }) => [styles.folderRow, pressed && styles.pressed]}>
      {content}
    </Pressable>
  ) : (
    <View style={styles.folderRow}>{content}</View>
  );
}

type ColorSet = typeof lightColors;

const lightColors = {
  background: '#F5F5F8',
  card: '#FFFFFF',
  text: '#050505',
  secondaryText: '#8E8E95',
  separator: '#E4E4E8',
  chevron: '#C4C4C8',
  mutedIcon: '#D97979',
};

const darkColors = {
  background: '#090909',
  card: '#1C1C1E',
  text: '#F5F5F5',
  secondaryText: '#9A9AA0',
  separator: '#2D2D31',
  chevron: '#6F6F75',
  mutedIcon: '#B65D5D',
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
  statusIndicator: {
    alignSelf: 'flex-start',
    marginBottom: 14,
    marginLeft: 18,
    marginTop: -10,
  },
  statusText: {
    fontFamily: systemFont,
    fontSize: 13,
    fontWeight: '500',
    lineHeight: 18,
    marginBottom: 14,
    marginLeft: 18,
    marginTop: -10,
  },
  section: {
    marginBottom: 24,
  },
  sectionHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 9,
    paddingHorizontal: 18,
  },
  sectionLabel: {
    fontFamily: systemFont,
    fontSize: 16,
    fontWeight: '600',
    lineHeight: 21,
  },
  sectionChevron: {
    alignItems: 'center',
    backgroundColor: '#000000',
    borderRadius: 8,
    height: 16,
    justifyContent: 'center',
    width: 16,
  },
  card: {
    borderRadius: 24,
    overflow: 'hidden',
  },
  folderRow: {
    alignItems: 'center',
    flexDirection: 'row',
    minHeight: 52,
    paddingLeft: 20,
  },
  pressed: {
    opacity: 0.72,
  },
  folderIconSlot: {
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 16,
    width: 30,
  },
  folderTextCell: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    minHeight: 52,
    paddingRight: 16,
  },
  folderLabel: {
    flex: 1,
    fontFamily: systemFont,
    fontSize: 16,
    fontWeight: '400',
    lineHeight: 21,
  },
  folderTrailing: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 9,
    marginLeft: 12,
  },
  folderCount: {
    fontFamily: systemFont,
    fontSize: 16,
    fontWeight: '400',
    lineHeight: 21,
  },
  emptyText: {
    fontFamily: systemFont,
    fontSize: 15,
    fontWeight: '400',
    lineHeight: 20,
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
});
