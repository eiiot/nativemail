import * as Haptics from 'expo-haptics';
import { Stack, router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { ComponentProps, useState } from 'react';
import {
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
  count?: string;
  color: string;
  muted?: boolean;
};

const textScale = { maxFontSizeMultiplier: 1.12 };
const systemFont = Platform.select({ ios: 'system-ui', default: undefined });
const pressHaptic = () => {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
};

const inboxRows: FolderRow[] = [
  { id: 'primary', icon: 'tray', label: 'Primary', count: '1069', color: '#007AFF' },
  { id: 'social', icon: 'person.crop.square.stack', label: 'Social', count: '300+', color: '#05B8C8' },
  { id: 'promotions', icon: 'newspaper', label: 'Promotions', count: '300+', color: '#12A22A' },
  { id: 'notifications', icon: 'doc.text.magnifyingglass', label: 'Notifications', count: '300+', color: '#FF8A00' },
  { id: 'forums', icon: 'bubble.left.and.bubble.right', label: 'Forums', count: '32', color: '#8E00D8' },
];

const favoriteRows: FolderRow[] = [
  { id: 'starred', icon: 'star', label: 'Starred', count: '9', color: '#C7A000' },
  { id: 'drafts', icon: 'doc.text', label: 'Drafts', count: '56', color: '#08AFC4' },
  { id: 'sent', icon: 'paperplane', label: 'Sent', color: '#079520' },
  { id: 'all', icon: 'tray.full', label: 'All Mail', color: '#8E00D8' },
  { id: 'spam', icon: 'exclamationmark.octagon', label: 'Spam', count: '124', color: '#8A5A2B' },
  { id: 'trash', icon: 'trash', label: 'Trash', color: '#D77A7A', muted: true },
];

export default function FoldersScreen() {
  const insets = useSafeAreaInsets();
  const scheme = useColorScheme();
  const colors = scheme === 'dark' ? darkColors : lightColors;
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
  const openCompose = () => {
    pressHaptic();
    router.push('/compose');
  };
  const openInbox = () => {
    pressHaptic();
    if (router.canGoBack()) {
      router.back();
    } else {
      router.push('/');
    }
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
          icon="gearshape"
          onPress={pressHaptic}
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

          <FolderSection
            collapsed={collapsedSections.inboxes}
            colors={colors}
            id="inboxes"
            label="Inboxes"
            onPrimaryPress={openInbox}
            rows={inboxRows}
            onToggle={toggleSection}
          />
          <FolderSection
            collapsed={collapsedSections.favorites}
            colors={colors}
            id="favorites"
            label="Favorites"
            rows={favoriteRows}
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
  id,
  label,
  onPrimaryPress,
  onToggle,
  rows,
}: {
  collapsed?: boolean;
  colors: ColorSet;
  id: string;
  label: string;
  onPrimaryPress?: () => void;
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
          {rows.map((row, index) => (
            <FolderListRow
              colors={colors}
              isLast={index === rows.length - 1}
              key={row.id}
              onPress={row.id === 'primary' ? onPrimaryPress : undefined}
              row={row}
            />
          ))}
        </View>
      )}
    </View>
  );
}

function FolderListRow({
  colors,
  isLast,
  onPress,
  row,
}: {
  colors: ColorSet;
  isLast: boolean;
  onPress?: () => void;
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
    <Pressable onPress={onPress} style={({ pressed }) => [styles.folderRow, pressed && styles.pressed]}>
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
});
