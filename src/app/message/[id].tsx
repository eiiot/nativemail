import { GradientAvatar } from '@/components/gradient-avatar';
import { getMessageById, type Message } from '@/lib/mock-mail';
import {
  GlassEffectContainer,
  HStack,
  Host,
  Image as SwiftImage,
  Namespace,
  Rectangle,
} from '@expo/ui/swift-ui';
import {
  Animation,
  animation,
  cornerRadius,
  foregroundColor,
  frame,
  glassEffect,
  glassEffectId,
  onTapGesture,
  padding,
} from '@expo/ui/swift-ui/modifiers';
import {
  GlassView,
  isGlassEffectAPIAvailable,
  isLiquidGlassAvailable,
} from 'expo-glass-effect';
import * as Haptics from 'expo-haptics';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { MenuView, type MenuAction, type NativeActionEvent } from '@expo/ui/community/menu';
import { ComponentProps, PropsWithChildren, useId } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
  useColorScheme,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const textScale = { maxFontSizeMultiplier: 1.12 };
const systemFont = Platform.select({ ios: 'system-ui', default: undefined });
const roundedFont = Platform.select({ ios: 'ui-rounded', default: undefined });
const pressHaptic = () => {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
};
const messageMenuActions: MenuAction[] = [
  {
    id: 'reply-actions',
    title: '',
    displayInline: true,
    subactions: [
      { id: 'reply', title: 'Reply', image: 'arrowshape.turn.up.left' },
      { id: 'reply-all', title: 'Reply All', image: 'arrowshape.turn.up.left.2' },
      { id: 'forward', title: 'Forward', image: 'arrowshape.turn.up.right' },
    ],
  },
  {
    id: 'status-actions',
    title: '',
    displayInline: true,
    subactions: [
      { id: 'mark-unread', title: 'Mark as Unread', image: 'envelope.badge' },
      { id: 'add-star', title: 'Add Star', image: 'star' },
      { id: 'mark-important', title: 'Mark as Important', image: 'chevron.forward.2' },
    ],
  },
  {
    id: 'file-actions',
    title: '',
    displayInline: true,
    subactions: [
      { id: 'archive', title: 'Archive', image: 'archivebox' },
      { id: 'trash', title: 'Trash', image: 'trash', attributes: { destructive: true } },
      { id: 'spam', title: 'Report Spam', image: 'exclamationmark.octagon' },
    ],
  },
  {
    id: 'organize-actions',
    title: '',
    displayInline: true,
    subactions: [
      { id: 'label', title: 'Label', image: 'tag' },
      { id: 'move', title: 'Move', image: 'folder' },
    ],
  },
];

export default function MessageScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const scheme = useColorScheme();
  const colors = scheme === 'dark' ? darkColors : lightColors;
  const message = getMessageById(id);

  return (
    <>
      <Stack.Screen.BackButton hidden />
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
          onPress={() => {
            pressHaptic();
            router.back();
          }}
          separateBackground
          tintColor={colors.text}
        />
        <Stack.Toolbar.Button icon="chevron.up" onPress={pressHaptic} tintColor={colors.text} />
        <Stack.Toolbar.Button icon="chevron.down" onPress={pressHaptic} tintColor={colors.text} />
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button icon="tag" onPress={pressHaptic} tintColor={colors.text} />
        <Stack.Toolbar.Button icon="folder" onPress={pressHaptic} tintColor={colors.text} />
        <Stack.Toolbar.Menu icon="ellipsis" separateBackground tintColor={colors.text}>
          <Stack.Toolbar.Menu inline palette>
            <Stack.Toolbar.MenuAction icon="arrowshape.turn.up.left" onPress={pressHaptic}>
              Reply
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction icon="arrowshape.turn.up.left.2" onPress={pressHaptic}>
              Reply All
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction icon="arrowshape.turn.up.right" onPress={pressHaptic}>
              Forward
            </Stack.Toolbar.MenuAction>
          </Stack.Toolbar.Menu>
          <Stack.Toolbar.Menu inline>
            <Stack.Toolbar.MenuAction icon="envelope.badge" onPress={pressHaptic}>
              Mark as Unread
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction icon="star" onPress={pressHaptic}>
              Add Star
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction icon="chevron.forward.2" onPress={pressHaptic}>
              Mark as Important
            </Stack.Toolbar.MenuAction>
          </Stack.Toolbar.Menu>
          <Stack.Toolbar.Menu inline>
            <Stack.Toolbar.MenuAction icon="archivebox" onPress={pressHaptic}>
              Archive
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction destructive icon="trash" onPress={pressHaptic}>
              Trash
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction icon="exclamationmark.octagon" onPress={pressHaptic}>
              Report Spam
            </Stack.Toolbar.MenuAction>
          </Stack.Toolbar.Menu>
          <Stack.Toolbar.Menu inline>
            <Stack.Toolbar.MenuAction icon="tag" onPress={pressHaptic}>
              Label
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction icon="folder" onPress={pressHaptic}>
              Move
            </Stack.Toolbar.MenuAction>
          </Stack.Toolbar.Menu>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
      <Stack.Toolbar placement="bottom">
        <Stack.Toolbar.Button icon="archivebox" onPress={pressHaptic} tintColor={colors.text} />
        <Stack.Toolbar.Button icon="envelope.badge" onPress={pressHaptic} tintColor={colors.text} />
        <Stack.Toolbar.Button icon="star" onPress={pressHaptic} tintColor={colors.text} />
        <Stack.Toolbar.Spacer width={1} />
        <Stack.Toolbar.Button
          icon="arrowshape.turn.up.left"
          onPress={pressHaptic}
          separateBackground
          tintColor={colors.text}
        />
        <Stack.Toolbar.Spacer />
        <Stack.Toolbar.Button
          icon="trash"
          onPress={pressHaptic}
          separateBackground
          tintColor={colors.text}
        />
      </Stack.Toolbar>

      <View style={[styles.root, { backgroundColor: colors.background }]}>
        <MessageDetail colors={colors} insetsTop={insets.top} message={message} />
      </View>
    </>
  );
}

function TopNavigationCluster({
  colors,
  onBack,
}: {
  colors: ColorSet;
  onBack: () => void;
}) {
  const namespaceId = useId();
  const clusterAnimation = Animation.spring({ duration: 0.25 });
  const glass = {
    glass: { variant: 'regular' as const, interactive: true, tint: colors.glassTint },
    shape: 'capsule' as const,
  };
  const tapBack = () => {
    pressHaptic();
    onBack();
  };

  return (
    <Host pointerEvents="box-none" style={[styles.topNavClusterHost, { width: 156 }]}>
      <Namespace id={namespaceId}>
        <GlassEffectContainer spacing={8}>
          <HStack
            alignment="center"
            spacing={8}
            modifiers={[frame({ width: 156, height: 44, alignment: 'leading' })]}>
            <SwiftImage
              systemName="chevron.left"
              color={colors.text}
              size={21}
              modifiers={[
                frame({ width: 26, height: 26 }),
                padding({ all: 9 }),
                glassEffect(glass),
                glassEffectId('top-email-back', namespaceId),
                cornerRadius(22),
                onTapGesture(tapBack),
              ]}
            />
            <HStack
              alignment="center"
              spacing={0}
              modifiers={[
                frame({ width: 104, height: 44 }),
                glassEffect(glass),
                glassEffectId('top-message-nav', namespaceId),
                cornerRadius(22),
                animation(clusterAnimation, true),
              ]}>
              <SwiftImage
                systemName="chevron.up"
                color={colors.text}
                size={21}
                modifiers={[frame({ width: 51, height: 44 }), onTapGesture(pressHaptic)]}
              />
              <Rectangle
                modifiers={[
                  frame({ width: 1, height: 24 }),
                  foregroundColor(colors.groupDivider),
                ]}
              />
              <SwiftImage
                systemName="chevron.down"
                color={colors.text}
                size={21}
                modifiers={[frame({ width: 51, height: 44 }), onTapGesture(pressHaptic)]}
              />
            </HStack>
          </HStack>
        </GlassEffectContainer>
      </Namespace>
    </Host>
  );
}

function MessageActionDock({ bottom, colors }: { bottom: number; colors: ColorSet }) {
  return (
    <View pointerEvents="box-none" style={[styles.messageDock, { bottom }]}>
      <GlassIconGroup colors={colors} symbols={['archivebox', 'envelope.badge', 'star']} width={182} />
      <GlassButton colors={colors} size={56} symbol="arrowshape.turn.up.left" />
      <GlassButton colors={colors} size={56} symbol="trash" />
    </View>
  );
}

function GlassIconGroup({
  colors,
  height = 56,
  symbolSize = 24,
  symbols,
  width,
}: {
  colors: ColorSet;
  height?: number;
  symbolSize?: number;
  symbols: ComponentProps<typeof SymbolView>['name'][];
  width: number;
}) {
  return (
    <GlassSurface colors={colors} style={[styles.glassIconGroup, { borderRadius: height / 2, height, width }]}>
      {symbols.map((symbol, index) => (
        <Pressable
          accessibilityRole="button"
          key={symbol}
          onPress={pressHaptic}
          style={styles.glassGroupButton}>
          <SymbolView name={symbol} tintColor={colors.text} size={symbolSize} weight="semibold" />
          {index < symbols.length - 1 ? (
            <View style={[styles.glassGroupDivider, { backgroundColor: colors.groupDivider }]} />
          ) : null}
        </Pressable>
      ))}
    </GlassSurface>
  );
}

function GlassButton({
  symbol,
  size,
  colors,
  onPress,
}: {
  symbol: ComponentProps<typeof SymbolView>['name'];
  size: number;
  colors: ColorSet;
  onPress?: () => void;
}) {
  const handlePress = () => {
    pressHaptic();
    onPress?.();
  };
  const content = (
    <View pointerEvents="none" style={styles.glassButtonContent}>
      <SymbolView name={symbol} tintColor={colors.text} size={Math.round(size * 0.42)} weight="semibold" />
    </View>
  );

  return (
    <GlassSurface style={[styles.glassButton, { height: size, width: size }]} colors={colors}>
      {onPress ? (
        <Pressable accessibilityRole="button" onPress={handlePress} style={styles.glassButtonContent}>
          {content}
        </Pressable>
      ) : (
        content
      )}
    </GlassSurface>
  );
}

function GlassSurface({
  children,
  style,
  colors,
}: PropsWithChildren<{
  style?: StyleProp<ViewStyle>;
  colors: ColorSet;
}>) {
  const canUseGlass = Platform.OS === 'ios' && isLiquidGlassAvailable() && isGlassEffectAPIAvailable();

  if (canUseGlass) {
    return (
      <GlassView
        isInteractive
        tintColor={colors.glassTint}
        glassEffectStyle="regular"
        style={[styles.glassBase, style]}>
        {children}
      </GlassView>
    );
  }

  return (
    <View
      style={[
        styles.glassBase,
        {
          backgroundColor: colors.fallbackGlass,
          borderColor: colors.fallbackBorder,
          borderWidth: StyleSheet.hairlineWidth,
        },
        style,
      ]}>
      {children}
    </View>
  );
}

function MessageDetail({
  colors,
  insetsTop,
  message,
}: {
  colors: ColorSet;
  insetsTop: number;
  message: Message;
}) {
  const subject = message.id === '6'
    ? 'Important Update for Trusted Travelers: CDC Public Health Order'
    : message.subject;
  const sender = getSenderEmail(message);
  const date = message.id === '6' ? '5/29/26' : message.date;
  const handleMenuAction = (_event: NativeActionEvent) => {
    pressHaptic();
  };

  return (
    <ScrollView
      contentContainerStyle={[
        styles.messageDetailContent,
        { paddingBottom: 128, paddingTop: insetsTop + 82 },
      ]}
      showsVerticalScrollIndicator={false}>
      <Text {...textScale} style={[styles.messageDetailTitle, { color: colors.text }]}>
        {subject}
      </Text>
      <View style={[styles.mailboxChip, { backgroundColor: colors.messageChip }]}>
        <Text {...textScale} style={[styles.mailboxChipText, { color: colors.text }]}>Inbox</Text>
      </View>

      <View style={styles.messageHeaderRow}>
        <GradientAvatar
          color={message.avatarColor}
          label={message.avatar}
          size={38}
          style={styles.detailAvatar}
          textSize={(message.avatar?.length ?? 1) > 1 ? 15 : 20}
        />
        <View style={styles.messageSenderBlock}>
          <View style={styles.messageSenderTopRow}>
            <Text {...textScale} numberOfLines={1} style={[styles.messageSender, { color: colors.text }]}>
              {sender}
            </Text>
            <Text {...textScale} style={[styles.messageDetailDate, { color: colors.secondaryText }]}>{date}</Text>
          </View>
          <View style={styles.messageSenderBottomRow}>
            <View style={styles.messageRecipientRow}>
              <Text {...textScale} style={[styles.messageRecipient, { color: colors.secondaryText }]}>To: Me</Text>
              <SymbolView name="chevron.down" tintColor={colors.secondaryText} size={12} weight="semibold" />
            </View>
            <MenuView
              actions={messageMenuActions}
              onPressAction={handleMenuAction}
              style={styles.messageMenuHost}>
              <View style={styles.messageEllipsisButton}>
                <SymbolView name="ellipsis" tintColor={colors.secondaryText} size={20} weight="semibold" />
              </View>
            </MenuView>
          </View>
        </View>
      </View>

      <Text {...textScale} style={[styles.messageBodyText, { color: colors.text }]}>
        Dear Trusted Traveler Program members,{'\n\n'}
        The Centers for Disease Control and Prevention (CDC) has issued a public health order affecting travelers who have recently been in{' '}
        <Text style={styles.messageBodyBold}>Uganda, Democratic Republic of the Congo (DRC), or South Sudan.</Text>
        {'\n\n'}
        <Text style={styles.messageBodyBold}>What You Need to Know:</Text>
        {'\n\n'}
        {'  \u2022  '}If you have been in <Text style={styles.messageBodyBold}>Uganda, DRC, or South Sudan</Text> within the past 21 days, you may be subject to additional screening and travel procedures when entering the United States.
        {'\n\n'}
        {'  \u2022  '}Designated Airports for Arrival: If you have visited one of these countries in the 21 days before your travel to the US, your flight must arrive to a designated airport for enhanced public health measures.
        {'\n\n'}
        {'       \u00a7 '}<Text style={styles.messageBodyBold}>Washington Dulles International Airport (IAD)</Text>, Dulles, Virginia{'\n\n'}
        {'       \u00a7 '}<Text style={styles.messageBodyBold}>Atlanta International Airport (ATL)</Text>, Atlanta, Georgia
      </Text>
    </ScrollView>
  );
}

function getSenderEmail(message: Message) {
  if (message.id === '6') {
    return 'donotreply1@cbp.dhs.gov';
  }

  if (message.sender.includes('@')) {
    return message.sender;
  }

  const username = message.sender
    .split(',')[0]
    .trim()
    .replace(/[^a-z0-9]+/gi, '.')
    .replace(/^\.+|\.+$/g, '')
    .toLowerCase();

  return `${username || 'sender'}@gmail.com`;
}

type ColorSet = typeof lightColors;

const lightColors = {
  background: '#F8F8F9',
  text: '#050505',
  secondaryText: '#7E7E82',
  groupDivider: 'rgba(60, 60, 67, 0.16)',
  messageChip: 'rgba(118, 118, 128, 0.16)',
  glassTint: 'rgba(255, 255, 255, 0.62)',
  fallbackGlass: 'rgba(255, 255, 255, 0.86)',
  fallbackBorder: 'rgba(255, 255, 255, 0.65)',
};

const darkColors = {
  background: '#090909',
  text: '#F5F5F5',
  secondaryText: '#A8A8AE',
  groupDivider: 'rgba(235, 235, 245, 0.16)',
  messageChip: 'rgba(118, 118, 128, 0.24)',
  glassTint: 'rgba(36, 36, 38, 0.62)',
  fallbackGlass: 'rgba(36, 36, 38, 0.86)',
  fallbackBorder: 'rgba(255, 255, 255, 0.1)',
};

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  topBar: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    left: 0,
    paddingHorizontal: 20,
    position: 'absolute',
    right: 0,
    zIndex: 10,
  },
  topNavClusterHost: {
    height: 44,
  },
  messageTopSpacer: {
    flex: 1,
  },
  messageDetailContent: {
    paddingHorizontal: 20,
  },
  messageDetailTitle: {
    fontFamily: systemFont,
    fontSize: 26,
    fontWeight: '800',
    letterSpacing: 0,
    lineHeight: 32,
  },
  mailboxChip: {
    alignSelf: 'flex-start',
    borderRadius: 4,
    marginTop: 12,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  mailboxChipText: {
    fontFamily: systemFont,
    fontSize: 14,
    fontWeight: '500',
    lineHeight: 18,
  },
  messageHeaderRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    marginTop: 22,
  },
  detailAvatar: {
    alignItems: 'center',
    borderRadius: 19,
    height: 38,
    justifyContent: 'center',
    width: 38,
  },
  detailAvatarText: {
    color: '#FFFFFF',
    fontFamily: roundedFont,
    fontSize: 16,
    fontWeight: '600',
  },
  messageSenderBlock: {
    flex: 1,
    marginLeft: 10,
  },
  messageSenderTopRow: {
    alignItems: 'baseline',
    flexDirection: 'row',
  },
  messageSenderBottomRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  messageSender: {
    flex: 1,
    fontFamily: systemFont,
    fontSize: 15,
    fontWeight: '600',
    lineHeight: 19,
  },
  messageRecipientRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 5,
  },
  messageRecipient: {
    fontFamily: systemFont,
    fontSize: 14,
    fontWeight: '400',
    lineHeight: 18,
  },
  messageDetailDate: {
    fontFamily: systemFont,
    fontSize: 14,
    fontWeight: '500',
    lineHeight: 19,
    marginLeft: 12,
  },
  messageMenuHost: {
    height: 30,
    width: 34,
  },
  messageEllipsisButton: {
    alignItems: 'center',
    height: 30,
    justifyContent: 'center',
    width: 34,
  },
  messageBodyText: {
    fontFamily: systemFont,
    fontSize: 16,
    fontWeight: '400',
    lineHeight: 23,
    marginTop: 20,
  },
  messageBodyBold: {
    fontWeight: '800',
  },
  glassBase: {
    alignItems: 'center',
    backgroundColor: 'transparent',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  glassButton: {
    borderRadius: 26,
  },
  glassButtonContent: {
    alignItems: 'center',
    height: '100%',
    justifyContent: 'center',
    width: '100%',
  },
  glassIconGroup: {
    borderRadius: 28,
    flexDirection: 'row',
    height: 56,
  },
  glassGroupButton: {
    alignItems: 'center',
    flex: 1,
    height: '100%',
    justifyContent: 'center',
  },
  glassGroupDivider: {
    height: 28,
    position: 'absolute',
    right: 0,
    width: StyleSheet.hairlineWidth,
  },
  messageDock: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    left: 0,
    paddingHorizontal: 24,
    position: 'absolute',
    right: 0,
    zIndex: 12,
  },
});
