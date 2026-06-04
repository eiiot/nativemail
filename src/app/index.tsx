import { ProgressiveBlurView } from '@/components/progressive-blur-view';
import { GradientAvatar } from '@/components/gradient-avatar';
import { messages, type Message } from '@/lib/mock-mail';
import {
  GlassEffectContainer,
  HStack,
  Host,
  Image as SwiftImage,
  Namespace,
  Rectangle,
  Text as SwiftText,
  TextField,
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
  lineLimit,
  onTapGesture,
  offset as swiftOffset,
  opacity as swiftOpacity,
  padding,
  submitLabel,
  textInputAutocapitalization,
  truncationMode,
} from '@expo/ui/swift-ui/modifiers';
import { LinearGradient } from 'expo-linear-gradient';
import {
  GlassView,
  isGlassEffectAPIAvailable,
  isLiquidGlassAvailable,
} from 'expo-glass-effect';
import * as Haptics from 'expo-haptics';
import { Stack, router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { ComponentProps, PropsWithChildren, useId, useRef, useState } from 'react';
import {
  Animated,
  ListRenderItem,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
  useColorScheme,
  useWindowDimensions,
} from 'react-native';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const tint = '#0A84FF';
const textScale = { maxFontSizeMultiplier: 1.12 };
const titleRevealStart = 44;
const titleRevealEnd = 66;
const systemFont = Platform.select({ ios: 'system-ui', default: undefined });
const roundedFont = Platform.select({ ios: 'ui-rounded', default: undefined });
const pressHaptic = () => {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
};
export default function InboxScreen() {
  const insets = useSafeAreaInsets();
  const scheme = useColorScheme();
  const colors = scheme === 'dark' ? darkColors : lightColors;
  const [scrollY] = useState(() => new Animated.Value(0));
  const [navTitleVisible, setNavTitleVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const renderItem: ListRenderItem<Message> = ({ item }) => (
    <MessageRow
      colors={colors}
      item={item}
      onPress={() => {
        router.push({ pathname: '/message/[id]', params: { id: item.id } });
      }}
    />
  );
  const headerBackdropHeight = insets.top + 70;
  const headerOpacity = scrollY.interpolate({
    inputRange: [titleRevealStart - 6, titleRevealEnd],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });
  const largeTitleOpacity = scrollY.interpolate({
    inputRange: [titleRevealStart - 8, titleRevealEnd],
    outputRange: [1, 0.12],
    extrapolate: 'clamp',
  });
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
  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const nextVisible = event.nativeEvent.contentOffset.y >= titleRevealEnd;

    if (nextVisible !== navTitleVisible) {
      setNavTitleVisible(nextVisible);
    }
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
        <NativeNavTitle colors={colors} visible={navTitleVisible} />
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
        <Animated.FlatList
          data={messages}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          onScroll={Animated.event(
            [{ nativeEvent: { contentOffset: { y: scrollY } } }],
            { listener: handleScroll, useNativeDriver: true },
          )}
          scrollEventThrottle={16}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[
            styles.listContent,
            { paddingBottom: insets.bottom + 92, paddingTop: insets.top + 56 },
          ]}
          ListHeaderComponent={
            <View style={styles.header}>
              <Animated.Text
                {...textScale}
                numberOfLines={1}
                style={[styles.title, { color: colors.text, opacity: largeTitleOpacity }]}>
                Inbox
              </Animated.Text>
            </View>
          }
        />

      <Animated.View
        pointerEvents="none"
        style={[
          styles.headerBackdrop,
          { height: headerBackdropHeight, opacity: headerOpacity },
        ]}>
        <HeaderGlassBackdrop colors={colors} height={headerBackdropHeight} />
      </Animated.View>

    </View>
    </>
  );
}

function NativeNavTitle({ colors, visible }: { colors: ColorSet; visible: boolean }) {
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
        Inbox
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
  onPress,
}: {
  item: Message;
  colors: ColorSet;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.rowPressable, pressed && styles.pressed]}>
      <View style={styles.unreadSlot}>
        {item.unread ? <View style={styles.unreadDot} /> : null}
      </View>
      <GradientAvatar
        color={item.avatarColor}
        label={item.avatar}
        size={44}
        style={styles.avatar}
        textSize={(item.avatar?.length ?? 1) > 1 ? 16 : 22}
      />
      <View style={[styles.messageBody, { borderBottomColor: colors.separator }]}>
        <View style={styles.rowTop}>
          <Text {...textScale} numberOfLines={1} style={[styles.sender, { color: colors.text }]}>
            {item.sender}
          </Text>
          {item.count ? <Text {...textScale} style={[styles.threadCount, { color: colors.secondaryText }]}>{item.count}</Text> : null}
          <Text {...textScale} style={[styles.date, { color: item.unread ? tint : colors.secondaryText }]}>
            {item.date}
          </Text>
        </View>
        <Text {...textScale} numberOfLines={1} style={[styles.subject, { color: colors.text }]}>
          {item.subject}
        </Text>
        <Text {...textScale} numberOfLines={1} style={[styles.preview, { color: colors.secondaryText }]}>
          {item.preview}
        </Text>
      </View>
    </Pressable>
  );
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
  background: '#F8F8F9',
  text: '#050505',
  secondaryText: '#7E7E82',
  tertiaryText: '#8B8B91',
  separator: '#E2E2E5',
  groupDivider: 'rgba(60, 60, 67, 0.16)',
  messageChip: 'rgba(118, 118, 128, 0.16)',
  headerTintTop: 'rgba(255, 255, 255, 1)',
  headerTintMiddle: 'rgba(255, 255, 255, 0.8)',
  headerTintBottom: 'rgba(255, 255, 255, 0)',
  glassTint: 'rgba(255, 255, 255, 0.62)',
  fallbackGlass: 'rgba(255, 255, 255, 0.86)',
  fallbackBorder: 'rgba(255, 255, 255, 0.65)',
};

const darkColors = {
  background: '#090909',
  text: '#F5F5F5',
  secondaryText: '#A8A8AE',
  tertiaryText: '#8E8E95',
  separator: '#2B2B2F',
  groupDivider: 'rgba(235, 235, 245, 0.16)',
  messageChip: 'rgba(118, 118, 128, 0.24)',
  headerTintTop: 'rgba(9, 9, 9, 1)',
  headerTintMiddle: 'rgba(9, 9, 9, 0.8)',
  headerTintBottom: 'rgba(9, 9, 9, 0)',
  glassTint: 'rgba(36, 36, 38, 0.62)',
  fallbackGlass: 'rgba(36, 36, 38, 0.86)',
  fallbackBorder: 'rgba(255, 255, 255, 0.1)',
};

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  listContent: {
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
  messageBody: {
    borderBottomWidth: StyleSheet.hairlineWidth,
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
