import { ProgressiveBlurView } from '@/components/progressive-blur-view';
import { GradientAvatar } from '@/components/gradient-avatar';
import {
  archiveJmapEmail,
  describeJmapError,
  fetchJmapMailboxSnapshot,
  setJmapEmailPinned,
  setJmapEmailUnread,
  trashJmapEmail,
} from '@/lib/jmap-client';
import { messages, type Message } from '@/lib/mock-mail';
import {
  GlassEffectContainer,
  HStack,
  Host,
  Image as SwiftImage,
  List,
  Namespace,
  RNHostView,
  Rectangle,
  Button as SwiftButton,
  Circle,
  Spacer,
  SwipeActions,
  Text as SwiftText,
  TextField,
  VStack,
  ZStack,
  type TextFieldRef,
  useNativeState,
} from '@expo/ui/swift-ui';
import {
  Animation,
  animation,
  autocorrectionDisabled,
  blur as swiftBlur,
  cornerRadius,
  font,
  foregroundColor,
  frame,
  glassEffect,
  glassEffectId,
  listRowSeparator,
  listStyle,
  lineLimit,
  onTapGesture,
  offset as swiftOffset,
  opacity as swiftOpacity,
  padding,
  scrollContentBackground,
  shapes,
  background,
  submitLabel,
  textInputAutocapitalization,
  truncationMode,
  useScrollGeometryChange,
} from '@expo/ui/swift-ui/modifiers';
import { LinearGradient } from 'expo-linear-gradient';
import {
  GlassView,
  isGlassEffectAPIAvailable,
  isLiquidGlassAvailable,
} from 'expo-glass-effect';
import * as Haptics from 'expo-haptics';
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { ComponentProps, PropsWithChildren, useCallback, useId, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
  useWindowDimensions,
} from 'react-native';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const tint = '#0A84FF';
const textScale = { maxFontSizeMultiplier: 1.12 };
const titleRevealStart = 0.5;
const titleRevealEnd = 8;
const systemFont = Platform.select({ ios: 'system-ui', default: undefined });
const roundedFont = Platform.select({ ios: 'ui-rounded', default: undefined });
const pressHaptic = () => {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
};
type InboxSwipeAction = 'archive' | 'delete' | 'toggle-pin' | 'toggle-unread';

function interpolate(value: number, inputMin: number, inputMax: number, outputMin: number, outputMax: number) {
  const progress = Math.max(0, Math.min(1, (value - inputMin) / (inputMax - inputMin)));
  return outputMin + (outputMax - outputMin) * progress;
}

export default function InboxScreen() {
  const { mailboxId, mailboxName } = useLocalSearchParams<{
    mailboxId?: string;
    mailboxName?: string;
  }>();
  const insets = useSafeAreaInsets();
  const colors = lightColors;
  const initialScrollOffsetYRef = useRef<number | null>(null);
  const [jmapLoading, setJmapLoading] = useState(true);
  const [jmapStatus, setJmapStatus] = useState('');
  const [liveMailboxName, setLiveMailboxName] = useState<string | null>(null);
  const [liveMessages, setLiveMessages] = useState<Message[] | null>(null);
  const [scrollY, setScrollY] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const activeMailboxName = liveMailboxName ?? mailboxName ?? 'Inbox';
  const sourceMessages = liveMessages ?? messages;
  const visibleMessages = searchQuery.trim()
    ? sourceMessages.filter((message) => {
        const query = searchQuery.trim().toLowerCase();

        return (
          message.sender.toLowerCase().includes(query) ||
          message.subject.toLowerCase().includes(query) ||
          message.preview.toLowerCase().includes(query)
        );
      })
    : sourceMessages;
  const handleMessageSwipeAction = (item: Message, action: InboxSwipeAction) => {
    pressHaptic();

    if (!liveMessages) {
      return;
    }

    const previousMessages = liveMessages;
    const restoreMessages = () => {
      setLiveMessages(previousMessages);
    };

    if (action === 'archive' || action === 'delete') {
      setLiveMessages((currentMessages) =>
        currentMessages?.filter((message) => message.id !== item.id) ?? null,
      );

      const request = action === 'archive'
        ? archiveJmapEmail(item.id)
        : trashJmapEmail(item.id);

      request.catch(restoreMessages);
      return;
    }

    if (action === 'toggle-pin') {
      const nextPinned = !item.pinned;
      setLiveMessages((currentMessages) =>
        updateLiveMessage(currentMessages, item.id, {
          keywords: updateMessageKeyword(item.keywords, '$flagged', nextPinned),
          pinned: nextPinned,
        }),
      );

      setJmapEmailPinned(item.id, nextPinned)
        .then((result) => {
          setLiveMessages((currentMessages) =>
            updateLiveMessage(currentMessages, item.id, {
              keywords: result.keywords,
              pinned: result.pinned,
              unread: result.unread,
            }),
          );
        })
        .catch(restoreMessages);
      return;
    }

    const nextUnread = !item.unread;
    setLiveMessages((currentMessages) =>
      updateLiveMessage(currentMessages, item.id, {
        keywords: updateMessageKeyword(item.keywords, '$seen', !nextUnread),
        unread: nextUnread,
      }),
    );

    setJmapEmailUnread(item.id, nextUnread)
      .then((result) => {
        setLiveMessages((currentMessages) =>
          updateLiveMessage(currentMessages, item.id, {
            keywords: result.keywords,
            pinned: result.pinned,
            unread: result.unread,
          }),
        );
      })
      .catch(restoreMessages);
  };
  const scrollGeometryModifier = useScrollGeometryChange(
    useCallback((geometry) => {
      if (initialScrollOffsetYRef.current === null) {
        initialScrollOffsetYRef.current = geometry.contentOffsetY;
      }

      setScrollY(Math.max(0, geometry.contentOffsetY - initialScrollOffsetYRef.current));
    }, []),
  );
  useFocusEffect(
    useCallback(() => {
      const controller = new AbortController();
      initialScrollOffsetYRef.current = null;
      setScrollY(0);

      Promise.resolve().then(() => {
        if (!controller.signal.aborted) {
          setJmapLoading(true);
          setJmapStatus('');
        }
      });

      fetchJmapMailboxSnapshot({ mailboxId, signal: controller.signal })
        .then((snapshot) => {
          setLiveMailboxName(snapshot.mailbox?.name ?? null);
          setLiveMessages(snapshot.messages);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) {
            return;
          }

          setLiveMailboxName(null);
          setLiveMessages(null);
          setJmapStatus(error instanceof Error && error.name === 'FastmailJmapTokenMissingError'
            ? ''
            : `Using mock inbox: ${describeJmapError(error)}`);
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setJmapLoading(false);
          }
        });

      return () => {
        controller.abort();
      };
    }, [mailboxId]),
  );
  const headerBackdropHeight = insets.top + 70;
  const headerOpacity = interpolate(scrollY, 0, titleRevealEnd, 0, 1);
  const navTitleVisible = scrollY >= titleRevealStart;
  const openCompose = () => {
    router.push('/compose');
  };
  const openFolders = () => {
    pressHaptic();
    if (router.canGoBack()) {
      router.back();
    } else {
      router.push('/folders');
    }
  };
  const updateSearchQuery = (eventOrText: unknown) => {
    if (typeof eventOrText === 'string') {
      setSearchQuery(eventOrText);
      return;
    }

    const text = (eventOrText as { nativeEvent?: { text?: string } })?.nativeEvent?.text;
    setSearchQuery(text ?? '');
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
      <Stack.Title asChild>
        <NativeNavTitle colors={colors} title={activeMailboxName} visible={navTitleVisible} />
      </Stack.Title>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button
          icon="chevron.left"
          onPress={openFolders}
          separateBackground
          tintColor={colors.text}
        />
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          onPress={pressHaptic}
          separateBackground
          style={{ color: colors.text, fontFamily: systemFont, fontSize: 16, fontWeight: '600' }}
          tintColor={colors.text}>
          Select
        </Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Stack.SearchBar
        allowToolbarIntegration
        hideNavigationBar={false}
        obscureBackground={false}
        onCancelButtonPress={() => setSearchQuery('')}
        onChangeText={updateSearchQuery}
        placeholder="Search"
        textColor={colors.text}
        tintColor={tint}
      />
      <Stack.Toolbar placement="bottom">
        <Stack.Toolbar.Button
          icon="line.3.horizontal"
          onPress={pressHaptic}
          separateBackground
          tintColor={colors.text}
        />
        <Stack.Toolbar.Spacer width={0} />
        <Stack.Toolbar.SearchBarSlot />
        <Stack.Toolbar.Spacer width={0} />
        <Stack.Toolbar.Button
          icon="square.and.pencil"
          onPress={() => {
            pressHaptic();
            openCompose();
          }}
          separateBackground
          tintColor={colors.text}
        />
      </Stack.Toolbar>

      <View style={[styles.root, { backgroundColor: colors.background }]}>
        <Host useViewportSizeMeasurement style={styles.inboxListHost}>
          <List
            modifiers={[
              listStyle('plain'),
              scrollContentBackground('hidden'),
              ...(scrollGeometryModifier ? [scrollGeometryModifier] : []),
            ]}>
            <HStack modifiers={[listRowSeparator('hidden')]}>
              <RNHostView matchContents>
                <InboxListHeader
                  activeMailboxName={activeMailboxName}
                  colors={colors}
                  jmapLoading={jmapLoading}
                  jmapStatus={jmapStatus}
                />
              </RNHostView>
            </HStack>
            {visibleMessages.map((item) => (
              <MessageRow
                colors={colors}
                item={item}
                key={item.id}
                onSwipeAction={(action) => handleMessageSwipeAction(item, action)}
                onPress={() => {
                  router.push({
                    pathname: '/message/[id]',
                    params: getMessageRouteParams(item, activeMailboxName, liveMessages ? 'jmap' : 'mock'),
                  });
                }}
              />
            ))}
            <HStack modifiers={[listRowSeparator('hidden')]}>
              <RNHostView matchContents>
                <View style={{ height: insets.bottom + 92 }} />
              </RNHostView>
            </HStack>
          </List>
        </Host>
        <View
          pointerEvents="none"
          style={[
            styles.headerBackdrop,
            { height: headerBackdropHeight, opacity: headerOpacity },
          ]}>
          <HeaderGlassBackdrop colors={colors} height={headerBackdropHeight} />
        </View>
      </View>
    </>
  );
}

function getMessageRouteParams(item: Message, mailboxName: string, source: 'jmap' | 'mock') {
  return {
    avatar: item.avatar ?? '',
    avatarColor: item.avatarColor,
    count: item.count ? String(item.count) : '',
    date: item.date,
    fromEmail: item.fromEmail ?? '',
    hasAttachment: item.hasAttachment ? '1' : '0',
    id: item.id,
    keywords: JSON.stringify(item.keywords ?? {}),
    mailboxIds: JSON.stringify(item.mailboxIds ?? {}),
    mailboxName: item.mailboxName ?? mailboxName,
    pinned: item.pinned ? '1' : '0',
    preview: item.preview,
    sender: item.sender,
    source,
    subject: item.subject,
    to: item.to ?? '',
    unread: item.unread ? '1' : '0',
  };
}

function updateLiveMessage(
  messages: Message[] | null,
  messageId: string,
  patch: Pick<Partial<Message>, 'keywords' | 'pinned' | 'unread'>,
) {
  if (!messages) {
    return null;
  }

  return messages.map((message) => {
    if (message.id !== messageId) {
      return message;
    }

    return {
      ...message,
      ...(patch.keywords === undefined ? {} : { keywords: patch.keywords }),
      ...(patch.pinned === undefined ? {} : { pinned: patch.pinned }),
      ...(patch.unread === undefined ? {} : { unread: patch.unread }),
    };
  });
}

function updateMessageKeyword(
  keywords: Message['keywords'],
  keyword: '$flagged' | '$seen',
  enabled: boolean,
) {
  const nextKeywords: Record<string, true> = { ...(keywords ?? {}) };

  if (enabled) {
    nextKeywords[keyword] = true;
  } else {
    delete nextKeywords[keyword];
  }

  return nextKeywords;
}

function InboxListHeader({
  activeMailboxName,
  colors,
  jmapLoading,
  jmapStatus,
}: {
  activeMailboxName: string;
  colors: ColorSet;
  jmapLoading: boolean;
  jmapStatus: string;
}) {
  const { width } = useWindowDimensions();

  return (
    <View style={[styles.header, { width }]}>
      <Text
        {...textScale}
        numberOfLines={1}
        style={[styles.title, { color: colors.text }]}>
        {activeMailboxName}
      </Text>
      {jmapLoading ? (
        <ActivityIndicator color={tint} size="small" style={styles.headerSpinner} />
      ) : null}
      {jmapStatus ? (
        <Text {...textScale} style={[styles.headerStatus, { color: colors.secondaryText }]}>
          {jmapStatus}
        </Text>
      ) : null}
    </View>
  );
}

function NativeNavTitle({
  colors,
  title,
  visible,
}: {
  colors: ColorSet;
  title: string;
  visible: boolean;
}) {
  return (
    <Host pointerEvents="none" style={styles.navTitleHost}>
      <SwiftText
        modifiers={[
          font({ size: 17, weight: 'bold' }),
          foregroundColor(colors.text),
          lineLimit(1),
          truncationMode('tail'),
          frame({ height: 44, maxWidth: 1000, alignment: 'center' }),
          swiftOpacity(visible ? 1 : 0),
          swiftBlur(visible ? 0 : 7),
          swiftOffset({ y: visible ? 0 : 9 }),
          animation(Animation.easeOut({ duration: 0.22 }), visible),
        ]}>
        {title}
      </SwiftText>
    </Host>
  );
}

function HeaderGlassBackdrop({ colors, height }: { colors: ColorSet; height: number }) {
  const blurRampHeight = height + 32;

  return (
    <View style={StyleSheet.absoluteFill}>
      <ProgressiveBlurView
        direction="blurredTopClearBottom"
        maxBlurRadius={8}
        pointerEvents="none"
        startOffset={0}
        style={[
          styles.progressiveBlurLayer,
          {
            height: blurRampHeight,
            top: height - blurRampHeight,
          },
        ]}
        tintColor="transparent"
      />
      <LinearGradient
        colors={[colors.headerTintTop, colors.headerTintMiddle, colors.headerTintBottom]}
        end={{ x: 0.5, y: 1 }}
        locations={[0, 0.5, 1]}
        pointerEvents="none"
        start={{ x: 0.5, y: 0 }}
        style={StyleSheet.absoluteFill}
      />
    </View>
  );
}

function TopNavigationCluster({
  colors,
  expanded,
  onBack,
}: {
  colors: ColorSet;
  expanded: boolean;
  onBack?: () => void;
}) {
  const namespaceId = useId();
  const clusterAnimation = Animation.spring({ duration: 0.25 });
  const clusterWidth = expanded ? 156 : 44;
  const glass = {
    glass: { variant: 'regular' as const, interactive: true, tint: colors.glassTint },
    shape: 'capsule' as const,
  };
  const tapBack = () => {
    pressHaptic();
    onBack?.();
  };

  return (
    <Host pointerEvents="box-none" style={[styles.topNavClusterHost, { width: clusterWidth }]}>
      <Namespace id={namespaceId}>
        <GlassEffectContainer spacing={8} modifiers={[animation(clusterAnimation, expanded)]}>
          <HStack
            alignment="center"
            spacing={8}
            modifiers={[
              frame({ width: clusterWidth, height: 44, alignment: 'leading' }),
              animation(clusterAnimation, expanded),
            ]}>
            {!expanded ? (
              <SwiftImage
                systemName="chevron.left"
                color={colors.text}
                size={21}
                modifiers={[
                  frame({ width: 26, height: 26 }),
                  padding({ all: 9 }),
                  glassEffect(glass),
                  glassEffectId('top-list-back', namespaceId),
                  cornerRadius(22),
                  onTapGesture(tapBack),
                ]}
              />
            ) : null}
            {expanded ? (
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
            ) : null}
            {expanded ? (
              <HStack
                alignment="center"
                spacing={0}
                modifiers={[
                  frame({ width: 104, height: 44 }),
                  glassEffect(glass),
                  glassEffectId('top-message-nav', namespaceId),
                  cornerRadius(22),
                  animation(clusterAnimation, expanded),
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
            ) : null}
          </HStack>
        </GlassEffectContainer>
      </Namespace>
    </Host>
  );
}

function MessageActionDock({ bottom, colors }: { bottom: number; colors: ColorSet }) {
  return (
    <View pointerEvents="box-none" style={[styles.messageDock, { bottom }]}>
      <GlassIconGroup colors={colors} symbols={['archivebox', 'envelope.badge', 'pin']} width={182} />
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
          key={index}
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
  const sender = message.id === '6' ? 'donotreply1@cbp.dhs.gov' : message.sender;
  const date = message.id === '6' ? '5/29/26' : message.date;

  return (
    <ScrollView
      contentContainerStyle={[
        styles.messageDetailContent,
        { paddingBottom: 128, paddingTop: insetsTop + 108 },
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
          size={50}
          style={styles.detailAvatar}
          textSize={(message.avatar?.length ?? 1) > 1 ? 18 : 26}
        />
        <View style={styles.messageSenderBlock}>
          <Text {...textScale} numberOfLines={1} style={[styles.messageSender, { color: colors.text }]}>
            {sender}
          </Text>
          <View style={styles.messageRecipientRow}>
            <Text {...textScale} style={[styles.messageRecipient, { color: colors.secondaryText }]}>To: me</Text>
            <SymbolView name="chevron.down" tintColor={colors.secondaryText} size={12} weight="semibold" />
          </View>
        </View>
        <Text {...textScale} style={[styles.messageDetailDate, { color: colors.secondaryText }]}>{date}</Text>
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

function MessageRow({
  item,
  colors,
  onSwipeAction,
  onPress,
}: {
  item: Message;
  colors: ColorSet;
  onSwipeAction: (action: InboxSwipeAction) => void;
  onPress: () => void;
}) {
  const attachments = item.attachments ?? [];
  const avatarTextSize = (item.avatar?.length ?? 1) > 1 ? 16 : 22;
  const tapRow = () => {
    pressHaptic();
    onPress();
  };

  return (
    <SwipeActions>
      <HStack
        alignment="top"
        spacing={10}
        modifiers={[frame({ maxWidth: 1000, alignment: 'leading' }), onTapGesture(tapRow)]}>
        <ZStack modifiers={[frame({ width: 8, height: 44 })]}>
          {item.unread ? (
            <Circle modifiers={[frame({ width: 8, height: 8 }), foregroundColor(tint)]} />
          ) : null}
        </ZStack>
        <RNHostView matchContents>
          <GradientAvatar
            color={item.avatarColor}
            label={item.avatar}
            size={44}
            style={styles.swiftRowAvatar}
            textSize={avatarTextSize}
          />
        </RNHostView>
        <VStack alignment="leading" spacing={1} modifiers={[frame({ maxWidth: 1000, alignment: 'leading' })]}>
          <HStack alignment="firstTextBaseline" spacing={5}>
            <SwiftText
              modifiers={[
                font({ size: 16, weight: 'bold' }),
                foregroundColor(colors.text),
                frame({ maxWidth: 1000, alignment: 'leading' }),
                lineLimit(1),
                truncationMode('tail'),
              ]}>
              {item.sender}
            </SwiftText>
            <Spacer minLength={5} />
            {item.count ? (
              <SwiftText
                modifiers={[font({ size: 14, weight: 'bold' }), foregroundColor(colors.secondaryText)]}>
                {item.count}
              </SwiftText>
            ) : null}
            {item.pinned ? (
              <SwiftImage systemName="pin.fill" color={colors.pin} size={12} />
            ) : null}
            <SwiftText
              modifiers={[
                font({ size: 14, weight: 'medium' }),
                foregroundColor(item.unread ? tint : colors.secondaryText),
                lineLimit(1),
              ]}>
              {item.date}
            </SwiftText>
          </HStack>
          <SwiftText
            modifiers={[
              font({ size: 15, weight: 'regular' }),
              foregroundColor(colors.text),
              lineLimit(1),
              truncationMode('tail'),
            ]}>
            {item.subject}
          </SwiftText>
          <SwiftText
            modifiers={[
              font({ size: 14, weight: 'regular' }),
              foregroundColor(colors.secondaryText),
              lineLimit(1),
              truncationMode('tail'),
            ]}>
            {item.preview}
          </SwiftText>
          <SwiftInboxAttachmentPreview attachments={attachments} colors={colors} />
        </VStack>
      </HStack>
      <SwipeActions.Actions edge="leading" allowsFullSwipe>
        <SwiftButton
          label={item.unread ? 'Read' : 'Unread'}
          onPress={() => onSwipeAction('toggle-unread')}
          systemImage={item.unread ? 'envelope.open' : 'envelope.badge'}
        />
        <SwiftButton
          label={item.pinned ? 'Unpin' : 'Pin'}
          onPress={() => onSwipeAction('toggle-pin')}
          systemImage={item.pinned ? 'pin.slash' : 'pin'}
        />
      </SwipeActions.Actions>
      <SwipeActions.Actions edge="trailing" allowsFullSwipe>
        <SwiftButton
          label="Archive"
          onPress={() => onSwipeAction('archive')}
          systemImage="archivebox"
        />
        <SwiftButton
          label="Delete"
          onPress={() => onSwipeAction('delete')}
          role="destructive"
          systemImage="trash"
        />
      </SwipeActions.Actions>
    </SwipeActions>
  );
}

function SwiftInboxAttachmentPreview({
  attachments,
  colors,
}: {
  attachments: NonNullable<Message['attachments']>;
  colors: ColorSet;
}) {
  const firstAttachment = attachments[0];

  if (!firstAttachment) {
    return null;
  }

  return (
    <HStack spacing={6} modifiers={[padding({ top: 4 })]}>
      <HStack
        alignment="center"
        spacing={4}
        modifiers={[
          padding({ horizontal: 6, vertical: 3 }),
          background(colors.messageChip, shapes.roundedRectangle({ cornerRadius: 4 })),
        ]}>
        <SwiftImage
          systemName={getAttachmentPreviewSwiftSymbol(firstAttachment)}
          color={getAttachmentPreviewTint(firstAttachment, colors)}
          size={15}
        />
        <SwiftText
          modifiers={[
            font({ size: 13, weight: 'regular' }),
            foregroundColor(colors.text),
            lineLimit(1),
            truncationMode('tail'),
          ]}>
          {firstAttachment.name}
        </SwiftText>
      </HStack>
      {attachments.length > 1 ? (
        <SwiftText
          modifiers={[
            font({ size: 13, weight: 'regular' }),
            foregroundColor(colors.secondaryText),
            lineLimit(1),
          ]}>
          & {attachments.length - 1} more
        </SwiftText>
      ) : null}
    </HStack>
  );
}

function getAttachmentPreviewSwiftSymbol(
  attachment: NonNullable<Message['attachments']>[number],
): 'photo' | 'doc.richtext' | 'doc' {
  const type = attachment.type.toLowerCase();

  if (type.startsWith('image/')) {
    return 'photo';
  }

  if (type === 'application/pdf') {
    return 'doc.richtext';
  }

  return 'doc';
}

function InboxAttachmentPreview({
  attachments,
  colors,
}: {
  attachments: NonNullable<Message['attachments']>;
  colors: ColorSet;
}) {
  const firstAttachment = attachments[0];

  if (!firstAttachment) {
    return null;
  }

  return (
    <View style={styles.inboxAttachmentRow}>
      <View style={[styles.inboxAttachmentChip, { borderColor: colors.attachmentChipBorder }]}>
        <SymbolView
          name={getAttachmentPreviewSymbol(firstAttachment)}
          tintColor={getAttachmentPreviewTint(firstAttachment, colors)}
          size={17}
          weight="semibold"
        />
        <Text
          {...textScale}
          numberOfLines={1}
          style={[styles.inboxAttachmentName, { color: colors.text }]}>
          {firstAttachment.name}
        </Text>
      </View>
      {attachments.length > 1 ? (
        <Text
          {...textScale}
          numberOfLines={1}
          style={[styles.inboxAttachmentMore, { color: colors.secondaryText }]}>
          & {attachments.length - 1} more
        </Text>
      ) : null}
    </View>
  );
}

function getAttachmentPreviewSymbol(attachment: NonNullable<Message['attachments']>[number]): ComponentProps<typeof SymbolView>['name'] {
  const type = attachment.type.toLowerCase();

  if (type.startsWith('image/')) {
    return 'photo';
  }

  if (type === 'application/pdf') {
    return 'doc.richtext';
  }

  return 'doc';
}

function getAttachmentPreviewTint(attachment: NonNullable<Message['attachments']>[number], colors: ColorSet) {
  if (attachment.type.toLowerCase().startsWith('image/')) {
    return colors.attachmentImage;
  }

  return colors.secondaryText;
}

function FloatingDock({
  bottom,
  colors,
  onComposePress,
  onQueryChange,
  onSearchClose,
  onSearchPress,
  searchActive,
  searchQuery,
}: {
  bottom: number;
  colors: ColorSet;
  onComposePress: () => void;
  onQueryChange: (value: string) => void;
  onSearchClose: () => void;
  onSearchPress: () => void;
  searchActive: boolean;
  searchQuery: string;
}) {
  return (
    <KeyboardStickyView
      offset={{ opened: 6 }}
      pointerEvents="box-none"
      style={[styles.dock, { bottom }]}>
      <SwiftGlassDock
        colors={colors}
        onComposePress={onComposePress}
        onQueryChange={onQueryChange}
        onSearchClose={onSearchClose}
        onSearchPress={onSearchPress}
        searchActive={searchActive}
        searchQuery={searchQuery}
      />
    </KeyboardStickyView>
  );
}

function SwiftGlassDock({
  colors,
  onComposePress,
  onQueryChange,
  onSearchClose,
  onSearchPress,
  searchActive,
  searchQuery,
}: {
  colors: ColorSet;
  onComposePress: () => void;
  onQueryChange: (value: string) => void;
  onSearchClose: () => void;
  onSearchPress: () => void;
  searchActive: boolean;
  searchQuery: string;
}) {
  const namespaceId = useId();
  const textFieldRef = useRef<TextFieldRef>(null);
  const textState = useNativeState(searchQuery);
  const { width } = useWindowDimensions();
  const rowGap = 14;
  const circleSize = 52;
  const horizontalInset = searchActive ? 16 : 40;
  const rowWidth = Math.max(280, width - horizontalInset);
  const expandedSearchWidth = rowWidth - circleSize - rowGap;
  const defaultSearchWidth = expandedSearchWidth - circleSize - rowGap;
  const searchWidth = searchActive ? expandedSearchWidth : defaultSearchWidth;
  const searchContentWidth = Math.max(80, searchWidth - 36);
  const leftClusterWidth = expandedSearchWidth;
  const leftGlassSpacing = searchActive ? 30 : 8;
  const dockAnimation = Animation.spring({ duration: 0.25 });
  const glass = {
    glass: { variant: 'regular' as const, interactive: true, tint: colors.glassTint },
    shape: 'capsule' as const,
  };
  const focusSearch = () => {
    pressHaptic();
    onSearchPress();
    setTimeout(() => {
      textFieldRef.current?.focus();
    }, 40);
  };
  const closeSearch = () => {
    pressHaptic();
    textFieldRef.current?.clear();
    textFieldRef.current?.blur();
    onSearchClose();
  };
  const tapCompose = () => {
    pressHaptic();
    onComposePress();
  };

  return (
    <Host pointerEvents="box-none" style={styles.swiftDockHost}>
      <Namespace id={namespaceId}>
        <HStack
          alignment="center"
          spacing={rowGap}
          modifiers={[frame({ width: rowWidth, height: 52 }), animation(dockAnimation, searchActive)]}>
          <GlassEffectContainer
            spacing={leftGlassSpacing}
            modifiers={[animation(dockAnimation, searchActive)]}>
            <HStack
              alignment="center"
              spacing={rowGap}
              modifiers={[
                frame({ width: leftClusterWidth, height: 52, alignment: 'trailing' }),
                animation(dockAnimation, searchActive),
              ]}>
              {!searchActive && (
                <SwiftImage
                  systemName="line.3.horizontal"
                  color={colors.text}
                  size={22}
                  modifiers={[
                    frame({ width: 34, height: 34 }),
                    padding({ all: 9 }),
                    glassEffect(glass),
                    glassEffectId('left-menu', namespaceId),
                    cornerRadius(26),
                    onTapGesture(pressHaptic),
                  ]}
                />
              )}
              <HStack
                alignment="center"
                spacing={8}
                modifiers={[
                  frame({ width: searchContentWidth, height: 34, alignment: 'leading' }),
                  padding({ horizontal: 18, vertical: 9 }),
                  glassEffect(glass),
                  glassEffectId('search-bar', namespaceId),
                  cornerRadius(26),
                  animation(dockAnimation, searchWidth),
                  // eslint-disable-next-line react-hooks/refs
                  onTapGesture(focusSearch),
                ]}>
                <SwiftImage systemName="magnifyingglass" color={colors.text} size={19} />
                <TextField
                  ref={textFieldRef}
                  text={textState}
                  onFocusChange={(focused) => {
                    if (focused) {
                      onSearchPress();
                    }
                  }}
                  onTextChange={onQueryChange}
                  placeholder="Search"
                  modifiers={[
                    frame({ width: Math.max(40, searchContentWidth - 27), height: 34, alignment: 'leading' }),
                    font({ size: 16, weight: 'medium' }),
                    foregroundColor(colors.text),
                    lineLimit(1),
                    submitLabel('search'),
                    autocorrectionDisabled(true),
                    textInputAutocapitalization('never'),
                    truncationMode('tail'),
                  ]}>
                  <TextField.Placeholder>
                    <SwiftText modifiers={[font({ size: 16, weight: 'medium' }), foregroundColor(colors.tertiaryText)]}>
                      Search
                    </SwiftText>
                  </TextField.Placeholder>
                </TextField>
              </HStack>
            </HStack>
          </GlassEffectContainer>

          <GlassEffectContainer spacing={30} modifiers={[animation(dockAnimation, searchActive)]}>
            <SwiftImage
              systemName={searchActive ? 'xmark' : 'square.and.pencil'}
              color={colors.text}
              size={22}
              modifiers={[
                frame({ width: 34, height: 34 }),
                padding({ all: 9 }),
                glassEffect(glass),
                glassEffectId('right-compose', namespaceId),
                cornerRadius(26),
                animation(dockAnimation, searchActive),
                // eslint-disable-next-line react-hooks/refs
                onTapGesture(searchActive ? closeSearch : tapCompose),
              ]}
            />
          </GlassEffectContainer>
        </HStack>
      </Namespace>
    </Host>
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

function GlassPill({
  children,
  style,
  colors,
}: PropsWithChildren<{ style?: StyleProp<ViewStyle>; colors: ColorSet }>) {
  return (
    <GlassSurface style={[styles.glassPill, style]} colors={colors}>
      {children}
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

type ColorSet = typeof lightColors;

const lightColors = {
  background: '#FFFFFF',
  text: '#050505',
  secondaryText: '#7E7E82',
  tertiaryText: '#8B8B91',
  separator: '#E2E2E5',
  groupDivider: 'rgba(60, 60, 67, 0.16)',
  messageChip: 'rgba(118, 118, 128, 0.16)',
  attachmentChipBorder: '#C9C9CD',
  attachmentImage: '#FF3B30',
  pin: '#FF3B30',
  headerTintTop: 'rgba(255, 255, 255, 1)',
  headerTintMiddle: 'rgba(255, 255, 255, 0.8)',
  headerTintBottom: 'rgba(255, 255, 255, 0)',
  glassTint: 'rgba(255, 255, 255, 0.62)',
  fallbackGlass: 'rgba(255, 255, 255, 0.86)',
  fallbackBorder: 'rgba(255, 255, 255, 0.65)',
};

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  listContent: {
  },
  inboxListHost: {
    flex: 1,
  },
  headerBackdrop: {
    left: 0,
    overflow: 'hidden',
    position: 'absolute',
    right: 0,
    top: 0,
    zIndex: 8,
  },
  progressiveBlurLayer: {
    left: 0,
    position: 'absolute',
    right: 0,
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
  navTitleHost: {
    alignItems: 'center',
    height: 44,
    justifyContent: 'center',
    width: 180,
  },
  header: {
    paddingBottom: 8,
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  title: {
    fontFamily: systemFont,
    fontSize: 32,
    fontWeight: '700',
    letterSpacing: 0,
    lineHeight: 36,
  },
  headerSpinner: {
    alignSelf: 'flex-start',
    marginTop: 8,
  },
  headerStatus: {
    fontFamily: systemFont,
    fontSize: 13,
    fontWeight: '500',
    lineHeight: 18,
    marginTop: 6,
  },
  selectText: {
    fontFamily: systemFont,
    fontSize: 16,
    fontWeight: '600',
  },
  rowPressable: {
    flexDirection: 'row',
    minHeight: 72,
    paddingLeft: 4,
    paddingRight: 18,
    width: '100%',
  },
  pressed: {
    opacity: 0.74,
  },
  unreadSlot: {
    alignItems: 'center',
    paddingTop: 25,
    width: 20,
  },
  unreadDot: {
    backgroundColor: tint,
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  avatar: {
    alignItems: 'center',
    borderRadius: 22,
    height: 44,
    justifyContent: 'center',
    marginTop: 8,
    width: 44,
  },
  avatarText: {
    color: '#fff',
    fontFamily: roundedFont,
    fontSize: 15,
    fontWeight: '700',
  },
  swiftRowAvatar: {
    alignItems: 'center',
    borderRadius: 22,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  messageBody: {
    flex: 1,
    marginLeft: 10,
    paddingBottom: 8,
    paddingTop: 7,
  },
  rowTop: {
    alignItems: 'baseline',
    flexDirection: 'row',
    gap: 5,
  },
  sender: {
    flex: 1,
    fontFamily: systemFont,
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 20,
  },
  threadCount: {
    fontFamily: systemFont,
    fontSize: 14,
    fontWeight: '700',
  },
  date: {
    fontFamily: systemFont,
    fontSize: 14,
    fontWeight: '500',
    lineHeight: 18,
    marginLeft: 6,
  },
  subject: {
    fontFamily: systemFont,
    fontSize: 15,
    fontWeight: '400',
    lineHeight: 19,
  },
  preview: {
    fontFamily: systemFont,
    fontSize: 14,
    fontWeight: '400',
    lineHeight: 18,
  },
  inboxAttachmentRow: {
    alignItems: 'center',
    flexDirection: 'row',
    marginTop: 4,
    maxWidth: '100%',
    minHeight: 24,
    overflow: 'hidden',
  },
  inboxAttachmentChip: {
    alignItems: 'center',
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    flexShrink: 1,
    flexDirection: 'row',
    maxWidth: '100%',
    minHeight: 24,
    minWidth: 0,
    paddingHorizontal: 6,
  },
  inboxAttachmentName: {
    flexShrink: 1,
    fontFamily: systemFont,
    fontSize: 14,
    fontWeight: '400',
    lineHeight: 18,
    marginLeft: 5,
  },
  inboxAttachmentMore: {
    flexShrink: 0,
    fontFamily: systemFont,
    fontSize: 14,
    fontWeight: '400',
    lineHeight: 18,
    marginLeft: 8,
  },
  messageDetailContent: {
    paddingHorizontal: 20,
  },
  messageDetailTitle: {
    fontFamily: systemFont,
    fontSize: 34,
    fontWeight: '800',
    letterSpacing: 0,
    lineHeight: 41,
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
    fontSize: 17,
    fontWeight: '500',
    lineHeight: 22,
  },
  messageHeaderRow: {
    alignItems: 'center',
    flexDirection: 'row',
    marginTop: 22,
  },
  detailAvatar: {
    alignItems: 'center',
    borderRadius: 25,
    height: 50,
    justifyContent: 'center',
    width: 50,
  },
  detailAvatarText: {
    color: '#FFFFFF',
    fontFamily: roundedFont,
    fontSize: 24,
    fontWeight: '600',
  },
  messageSenderBlock: {
    flex: 1,
    marginLeft: 14,
  },
  messageSender: {
    fontFamily: systemFont,
    fontSize: 19,
    fontWeight: '800',
    lineHeight: 24,
  },
  messageRecipientRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 5,
    marginTop: 1,
  },
  messageRecipient: {
    fontFamily: systemFont,
    fontSize: 17,
    fontWeight: '400',
    lineHeight: 22,
  },
  messageDetailDate: {
    fontFamily: systemFont,
    fontSize: 18,
    fontWeight: '500',
    lineHeight: 22,
    marginLeft: 12,
  },
  messageBodyText: {
    fontFamily: systemFont,
    fontSize: 19,
    fontWeight: '400',
    lineHeight: 28,
    marginTop: 30,
  },
  messageBodyBold: {
    fontWeight: '800',
  },
  dock: {
    height: 52,
    left: 0,
    position: 'absolute',
    right: 0,
  },
  swiftDockHost: {
    alignItems: 'center',
    justifyContent: 'center',
    height: 52,
    width: '100%',
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
  glassPill: {
    borderRadius: 22,
    minHeight: 44,
    paddingHorizontal: 17,
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
