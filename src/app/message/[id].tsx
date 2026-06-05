import { GradientAvatar } from '@/components/gradient-avatar';
import {
  AttachmentThumbnailView,
  canUseNativeAttachmentThumbnail,
  openNativeAttachmentPreviewAsync,
} from '@/components/attachment-thumbnail-view';
import {
  archiveJmapEmail,
  fetchJmapThreadMessages,
  setJmapEmailPinned,
  setJmapEmailUnread,
  trashJmapEmail,
  type JmapMessageBodyDebug,
  type JmapMessageActionResult,
} from '@/lib/jmap-client';
import { updateCachedEmail } from '@/lib/mail-cache';
import { useDebugMode } from '@/lib/debug-mode';
import {
  clampEmailBodyHeight,
  defaultEmailBodyWidth,
  getEmailBodyHeightScript,
  getEmailHtmlDocument,
  minEmailBodyWebViewHeight,
} from '@/lib/email-html-rendering';
import { splitEmailReplyHtml, splitEmailReplyText } from '@/lib/email-reply-history';
import {
  hydrateMessageBodyFromCache,
  loadMessageBody,
  selectThread,
  useMailStore,
} from '@/lib/mail-store';
import { getMessageById, type Message, type MessageAttachment } from '@/lib/mock-mail';
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
import { Image as ExpoImage } from 'expo-image';
import {
  GlassView,
  isGlassEffectAPIAvailable,
  isLiquidGlassAvailable,
} from 'expo-glass-effect';
import * as Haptics from 'expo-haptics';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { MenuView, type MenuAction, type NativeActionEvent } from '@expo/ui/community/menu';
import { ComponentProps, PropsWithChildren, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Clipboard,
  InteractionManager,
  Linking,
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
import WebView, { type WebViewMessageEvent } from 'react-native-webview';

const textScale = { maxFontSizeMultiplier: 1.12 };
const messageDetailHorizontalPadding = 20;
const messageBodyFetchRevision = 8;
const threadScrollOffset = 12;
const systemFont = Platform.select({ ios: 'system-ui', default: undefined });
const roundedFont = Platform.select({ ios: 'ui-rounded', default: undefined });
const pressHaptic = () => {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
};
type MessageAction = 'archive' | 'reply' | 'reply-all' | 'toggle-pin' | 'toggle-unread' | 'trash';
const copyEmailHtmlAction = 'copy-email-html';

type EmailWebViewImageDebug = {
  imageCount: number;
  images: {
    complete: boolean;
    currentSrcHost: string;
    heightAttr: string;
    naturalHeight: number;
    naturalWidth: number;
    parentTag: string;
    parentWidth: number;
    renderedHeight: number;
    renderedWidth: number;
    srcHost: string;
    srcPrefix: string;
    status: string;
    widthAttr: string;
  }[];
  phase: string;
};

type EmailWebViewDarkModeDebug = {
  backgroundCount: number;
  borderCount: number;
  linkCount: number;
  skippedBackgroundImageCount: number;
  skippedColoredBackgroundCount: number;
  textCount: number;
};

export default function MessageScreen() {
  const params = useLocalSearchParams<{
    avatar?: string;
    avatarColor?: string;
    count?: string;
    date?: string;
    fromEmail?: string;
    hasAttachment?: string;
    id: string;
    keywords?: string;
    mailboxIds?: string;
    mailboxName?: string;
    pinned?: string;
    preview?: string;
    sender?: string;
    source?: string;
    subject?: string;
    threadId?: string;
    to?: string;
    unread?: string;
    wasUnreadOnOpen?: string;
  }>();
  const { id, mailboxName, source } = params;
  const insets = useSafeAreaInsets();
  const scheme = useColorScheme();
  const colors = scheme === 'dark' ? darkColors : lightColors;
  const messageId = Array.isArray(id) ? id[0] : id;
  const fallbackMessage = getMessageById(messageId);
  const routeMessage = getRouteMessage(params, fallbackMessage);
  const routeKeywordsText = getRouteParam(params.keywords) ?? '';
  const wasUnreadOnOpen = getRouteParam(params.wasUnreadOnOpen) === '1';
  const routeThreadId = routeMessage.threadId;
  const messageBodies = useMailStore((state) => state.messageBodies);
  const cachedThread = useMailStore((state) => selectThread(state, routeThreadId));
  const storeMessageBody = messageBodies[messageId] ?? null;
  const applyMessageBody = useMailStore((state) => state.applyMessageBody);
  const patchStoreMessage = useMailStore((state) => state.patchMessage);
  const [localFlags, setLocalFlags] = useState({
    pinned: routeMessage.pinned,
    unread: routeMessage.unread,
  });
  const [pendingAction, setPendingAction] = useState<MessageAction | null>(null);
  const [threadMessages, setThreadMessages] = useState<Message[] | null>(null);
  const [focusedThreadMessageId, setFocusedThreadMessageId] = useState(messageId);
  const [expandedThreadMessageIds, setExpandedThreadMessageIds] = useState<Set<string>>(
    () => new Set([messageId]),
  );
  const cachedThreadMessagesRef = useRef<Message[] | null>(null);
  const jmapBody = source === 'jmap' ? storeMessageBody : null;
  const message = {
    ...routeMessage,
    attachments: jmapBody?.attachments ?? routeMessage.attachments,
    body: jmapBody?.text ?? routeMessage.body,
    hasAttachment: Boolean(
      routeMessage.hasAttachment ||
      routeMessage.attachments?.length ||
      jmapBody?.attachments.length
    ),
    htmlBody: jmapBody?.html ?? routeMessage.htmlBody,
    pinned: localFlags.pinned,
    unread: localFlags.unread,
  };
  const cachedThreadMessages = cachedThread?.messages ?? null;
  const cachedThreadMessageKey = useMemo(
    () => cachedThreadMessages?.map((threadMessage) => threadMessage.id).join('\n') ?? '',
    [cachedThreadMessages],
  );
  const detailMessages = useMemo(
    () => mergeThreadMessagesWithBodies(threadMessages ?? cachedThreadMessages ?? [routeMessage], messageBodies, message),
    [cachedThreadMessages, message, messageBodies, routeMessage, threadMessages],
  );
  const expandedThreadMessageKey = useMemo(
    () => Array.from(expandedThreadMessageIds).sort().join('\n'),
    [expandedThreadMessageIds],
  );

  useEffect(() => {
    cachedThreadMessagesRef.current = cachedThreadMessages;
  }, [cachedThreadMessages]);

  useEffect(() => {
    setLocalFlags({
      pinned: routeMessage.pinned,
      unread: routeMessage.unread,
    });
    setPendingAction(null);
    setThreadMessages(null);
    setFocusedThreadMessageId(messageId);
    setExpandedThreadMessageIds(new Set([messageId]));
  }, [messageId, routeMessage.pinned, routeMessage.unread]);

  useEffect(() => {
    const cachedMessages = cachedThreadMessagesRef.current;

    if (!cachedMessages?.length) {
      return;
    }

    const focusId = getThreadFocusMessageId(cachedMessages, messageId, wasUnreadOnOpen);

    setFocusedThreadMessageId(focusId);
    setExpandedThreadMessageIds(getInitialExpandedThreadMessageIds(cachedMessages, focusId));
  }, [cachedThreadMessageKey, messageId, wasUnreadOnOpen]);

  useEffect(() => {
    if (source !== 'jmap' || !messageId) {
      return;
    }

    if (cachedThreadMessages?.length) {
      return;
    }

    const controller = new AbortController();

    fetchJmapThreadMessages({
      messageId,
      signal: controller.signal,
      threadId: routeMessage.threadId,
    })
      .then((messages) => {
        if (controller.signal.aborted) {
          return;
        }

        const nextMessages = messages.length ? messages : [routeMessage];
        const focusId = getThreadFocusMessageId(nextMessages, messageId, wasUnreadOnOpen);
        const expandedIds = getInitialExpandedThreadMessageIds(nextMessages, focusId);

        setThreadMessages(nextMessages);
        setFocusedThreadMessageId(focusId);
        setExpandedThreadMessageIds(expandedIds);
      })
      .catch(() => {});

    return () => {
      controller.abort();
    };
  }, [cachedThreadMessageKey, cachedThreadMessages, messageId, routeMessage.threadId, source, wasUnreadOnOpen]);

  useEffect(() => {
    const shouldLoadJmap = source === 'jmap';

    if (!messageId || !shouldLoadJmap) {
      return;
    }

    void hydrateMessageBodyFromCache(messageId).catch(() => {});

    void loadMessageBody(messageId, { refresh: true })
      .then((body) => {
        if (body) {
          applyMessageBody(messageId, body);
        }
      })
      .catch(() => {});
  }, [applyMessageBody, messageId, source, messageBodyFetchRevision]);
  useEffect(() => {
    if (source !== 'jmap') {
      return;
    }

    const messageIds = Array.from(expandedThreadMessageIds);

    for (const threadMessageId of messageIds) {
      void hydrateMessageBodyFromCache(threadMessageId).catch(() => {});
      void loadMessageBody(threadMessageId, { refresh: true }).catch(() => {});
    }
  }, [expandedThreadMessageKey, expandedThreadMessageIds, source]);
  useEffect(() => {
    if (source !== 'jmap' || !messageId || !routeMessage.unread) {
      return;
    }

    const nextKeywords = updateMessageKeyword(routeMessage.keywords, '$seen', true);

    setLocalFlags((currentFlags) => ({ ...currentFlags, unread: false }));
    patchStoreMessage(messageId, {
      keywords: nextKeywords,
      unread: false,
    });
    void updateCachedEmail(messageId, {
      keywords: nextKeywords,
      unread: false,
    }).catch(() => {});

    setJmapEmailUnread(messageId, false)
      .then((result) => {
        patchStoreMessage(messageId, {
          keywords: result.keywords,
          pinned: result.pinned,
          unread: result.unread,
        });
        void updateCachedEmail(messageId, {
          keywords: result.keywords,
          pinned: result.pinned,
          unread: result.unread,
        }).catch(() => {});
        setLocalFlags((currentFlags) => ({
          pinned: result.pinned ?? currentFlags.pinned,
          unread: result.unread ?? currentFlags.unread,
        }));
      })
      .catch(() => {
        setLocalFlags((currentFlags) => ({ ...currentFlags, unread: routeMessage.unread }));
        patchStoreMessage(messageId, {
          keywords: routeMessage.keywords,
          unread: routeMessage.unread,
        });
        void updateCachedEmail(messageId, {
          keywords: routeMessage.keywords,
          unread: routeMessage.unread,
        }).catch(() => {});
      });
  }, [messageId, patchStoreMessage, routeKeywordsText, routeMessage.unread, source]);
  const runMessageAction = (action: MessageAction) => {
    pressHaptic();

    if (action === 'reply' || action === 'reply-all') {
      return;
    }

    if (pendingAction || !messageId) {
      return;
    }

    const previousFlags = localFlags;

    if (source !== 'jmap') {
      if (action === 'toggle-pin') {
        setLocalFlags((currentFlags) => ({ ...currentFlags, pinned: !currentFlags.pinned }));
      } else if (action === 'toggle-unread') {
        setLocalFlags((currentFlags) => ({ ...currentFlags, unread: !currentFlags.unread }));
      }

      return;
    }

    setPendingAction(action);

    if (action === 'toggle-pin') {
      setLocalFlags((currentFlags) => ({ ...currentFlags, pinned: !currentFlags.pinned }));
    }

    if (action === 'toggle-unread') {
      setLocalFlags((currentFlags) => ({ ...currentFlags, unread: !currentFlags.unread }));
    }

    const request = getMessageActionRequest(action, messageId, message);

    request
      .then((result) => {
        if (action === 'archive' || action === 'trash') {
          router.back();
          return;
        }

        setLocalFlags((currentFlags) => ({
          pinned: result.pinned ?? currentFlags.pinned,
          unread: result.unread ?? currentFlags.unread,
        }));
      })
      .catch((error: unknown) => {
        setLocalFlags(previousFlags);
      })
      .finally(() => {
        setPendingAction(null);
      });
  };

  const actionDisabled = pendingAction !== null;

  return (
    <>
      <Stack.Screen.BackButton hidden />
      <Stack.Header
        transparent
        style={{
          backgroundColor: 'transparent',
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
        />
        <Stack.Toolbar.Button icon="chevron.up" onPress={pressHaptic} />
        <Stack.Toolbar.Button icon="chevron.down" onPress={pressHaptic} />
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button disabled icon="tag" onPress={pressHaptic} />
        <Stack.Toolbar.Button disabled icon="folder" onPress={pressHaptic} />
        <Stack.Toolbar.Menu icon="ellipsis" separateBackground>
          <Stack.Toolbar.Menu inline palette>
            <Stack.Toolbar.MenuAction
              disabled={actionDisabled}
              icon="arrowshape.turn.up.left"
              onPress={() => runMessageAction('reply')}>
              Reply
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction
              disabled={actionDisabled}
              icon="arrowshape.turn.up.left.2"
              onPress={() => runMessageAction('reply-all')}>
              Reply All
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction disabled icon="arrowshape.turn.up.right" onPress={pressHaptic}>
              Forward
            </Stack.Toolbar.MenuAction>
          </Stack.Toolbar.Menu>
          <Stack.Toolbar.Menu inline>
            <Stack.Toolbar.MenuAction
              disabled={actionDisabled}
              icon={message.unread ? 'envelope.open' : 'envelope.badge'}
              onPress={() => runMessageAction('toggle-unread')}>
              {message.unread ? 'Mark as Read' : 'Mark as Unread'}
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction
              disabled={actionDisabled}
              icon={message.pinned ? 'pin.slash' : 'pin'}
              onPress={() => runMessageAction('toggle-pin')}>
              {message.pinned ? 'Unpin' : 'Pin'}
            </Stack.Toolbar.MenuAction>
          </Stack.Toolbar.Menu>
          <Stack.Toolbar.Menu inline>
            <Stack.Toolbar.MenuAction
              disabled={actionDisabled}
              icon="archivebox"
              onPress={() => runMessageAction('archive')}>
              Archive
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction
              destructive
              disabled={actionDisabled}
              icon="trash"
              onPress={() => runMessageAction('trash')}>
              Trash
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction disabled icon="exclamationmark.octagon" onPress={pressHaptic}>
              Report Spam
            </Stack.Toolbar.MenuAction>
          </Stack.Toolbar.Menu>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
      <Stack.Toolbar placement="bottom">
        <Stack.Toolbar.Button
          disabled={actionDisabled}
          icon="archivebox"
          onPress={() => runMessageAction('archive')}
        />
        <Stack.Toolbar.Button
          disabled={actionDisabled}
          icon={message.unread ? 'envelope.open' : 'envelope.badge'}
          onPress={() => runMessageAction('toggle-unread')}
        />
        <Stack.Toolbar.Button
          disabled={actionDisabled}
          icon={message.pinned ? 'pin.fill' : 'pin'}
          onPress={() => runMessageAction('toggle-pin')}
          tintColor={message.pinned ? colors.pin : undefined}
        />
        <Stack.Toolbar.Spacer width={1} />
        <Stack.Toolbar.Button
          disabled={actionDisabled}
          icon="arrowshape.turn.up.left"
          onPress={() => runMessageAction('reply')}
          separateBackground
        />
        <Stack.Toolbar.Spacer />
        <Stack.Toolbar.Button
          disabled={actionDisabled}
          icon="trash"
          onPress={() => runMessageAction('trash')}
          separateBackground
        />
      </Stack.Toolbar>

      <View style={[styles.root, { backgroundColor: colors.background }]}>
        <MessageDetail
          bodyDebug={jmapBody?.debug}
          colors={colors}
          expandedMessageIds={expandedThreadMessageIds}
          focusedMessageId={focusedThreadMessageId}
          insetsTop={insets.top}
          mailboxName={mailboxName}
          message={message}
          messages={detailMessages}
          onAction={runMessageAction}
          onExpandAll={() => {
            pressHaptic();
            setExpandedThreadMessageIds(new Set(detailMessages.map((detailMessage) => detailMessage.id)));
          }}
          onToggleMessage={(threadMessageId) => {
            pressHaptic();
            setExpandedThreadMessageIds((currentIds) => {
              const nextIds = new Set(currentIds);

              if (nextIds.has(threadMessageId)) {
                nextIds.delete(threadMessageId);
              } else {
                nextIds.add(threadMessageId);
              }

              return nextIds;
            });
          }}
        />
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

function getRouteMessage(
  params: Record<string, string | string[] | undefined>,
  fallbackMessage: Message,
): Message {
  const count = Number.parseInt(getRouteParam(params.count) ?? '', 10);
  const hasAttachment = getRouteParam(params.hasAttachment);
  const pinned = getRouteParam(params.pinned);
  const unread = getRouteParam(params.unread);

  return {
    ...fallbackMessage,
    avatar: getRouteParam(params.avatar) || fallbackMessage.avatar,
    avatarColor: getRouteParam(params.avatarColor) || fallbackMessage.avatarColor,
    count: Number.isFinite(count) ? count : fallbackMessage.count,
    date: getRouteParam(params.date) || fallbackMessage.date,
    fromEmail: getRouteParam(params.fromEmail) || fallbackMessage.fromEmail,
    hasAttachment: hasAttachment ? hasAttachment === '1' : fallbackMessage.hasAttachment,
    id: getRouteParam(params.id) || fallbackMessage.id,
    keywords: getRouteRecord(params.keywords) ?? fallbackMessage.keywords,
    mailboxIds: getRouteRecord(params.mailboxIds) ?? fallbackMessage.mailboxIds,
    mailboxName: getRouteParam(params.mailboxName) || fallbackMessage.mailboxName,
    pinned: pinned ? pinned === '1' : fallbackMessage.pinned,
    preview: getRouteParam(params.preview) || fallbackMessage.preview,
    sender: getRouteParam(params.sender) || fallbackMessage.sender,
    subject: getRouteParam(params.subject) || fallbackMessage.subject,
    threadId: getRouteParam(params.threadId) || fallbackMessage.threadId,
    to: getRouteParam(params.to) || fallbackMessage.to,
    unread: unread ? unread === '1' : fallbackMessage.unread,
  };
}

function mergeThreadMessagesWithBodies(
  messages: Message[],
  bodies: Record<string, { attachments: MessageAttachment[]; html: string | null; text: string | null }>,
  focusedMessage: Message,
) {
  return messages.map((threadMessage) => {
    const body = bodies[threadMessage.id];
    const mergedMessage = {
      ...threadMessage,
      attachments: body?.attachments ?? threadMessage.attachments,
      body: body?.text ?? threadMessage.body,
      hasAttachment: Boolean(
        threadMessage.hasAttachment ||
        threadMessage.attachments?.length ||
        body?.attachments.length
      ),
      htmlBody: body?.html ?? threadMessage.htmlBody,
    };

    return threadMessage.id === focusedMessage.id
      ? {
          ...mergedMessage,
          ...focusedMessage,
          attachments: body?.attachments ?? focusedMessage.attachments ?? mergedMessage.attachments,
          body: body?.text ?? focusedMessage.body ?? mergedMessage.body,
          htmlBody: body?.html ?? focusedMessage.htmlBody ?? mergedMessage.htmlBody,
        }
      : mergedMessage;
  });
}

function getThreadFocusMessageId(
  messages: Message[],
  fallbackMessageId: string,
  preferFallbackMessage: boolean,
) {
  if (preferFallbackMessage && messages.some((message) => message.id === fallbackMessageId)) {
    return fallbackMessageId;
  }

  const unreadMessage = [...messages].reverse().find((message) => message.unread);

  return unreadMessage?.id ?? messages[messages.length - 1]?.id ?? fallbackMessageId;
}

function getInitialExpandedThreadMessageIds(messages: Message[], focusMessageId: string) {
  const unreadIds = messages
    .filter((message) => message.unread)
    .map((message) => message.id);

  const expandedIds = new Set(unreadIds.length ? unreadIds : [focusMessageId]);

  expandedIds.add(focusMessageId);

  return expandedIds;
}

function getRouteParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function getRouteRecord(value: string | string[] | undefined) {
  const text = getRouteParam(value);

  if (!text) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const record: Record<string, true> = {};

    for (const [key, recordValue] of Object.entries(parsed)) {
      if (recordValue === true) {
        record[key] = true;
      }
    }

    return record;
  } catch {
    return undefined;
  }
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

function getMessageMenuActions(message: Message, debugMode: boolean, hasHtmlBody: boolean): MenuAction[] {
  const actions: MenuAction[] = [
    {
      id: 'reply-actions',
      title: '',
      displayInline: true,
      subactions: [
        { id: 'reply', title: 'Reply', image: 'arrowshape.turn.up.left' },
        { id: 'reply-all', title: 'Reply All', image: 'arrowshape.turn.up.left.2' },
        { id: 'forward', title: 'Forward', image: 'arrowshape.turn.up.right', attributes: { disabled: true } },
      ],
    },
    {
      id: 'status-actions',
      title: '',
      displayInline: true,
      subactions: [
        {
          id: 'toggle-unread',
          title: message.unread ? 'Mark as Read' : 'Mark as Unread',
          image: message.unread ? 'envelope.open' : 'envelope.badge',
        },
        {
          id: 'toggle-pin',
          title: message.pinned ? 'Unpin' : 'Pin',
          image: message.pinned ? 'pin.slash' : 'pin',
          state: message.pinned ? 'on' : 'off',
        },
      ],
    },
    {
      id: 'file-actions',
      title: '',
      displayInline: true,
      subactions: [
        { id: 'archive', title: 'Archive', image: 'archivebox' },
        { id: 'trash', title: 'Trash', image: 'trash', attributes: { destructive: true } },
      ],
    },
  ];

  if (debugMode) {
    actions.push({
      id: 'debug-actions',
      title: '',
      displayInline: true,
      subactions: [
        {
          id: copyEmailHtmlAction,
          title: 'Copy Email HTML',
          image: 'doc.on.doc',
          attributes: hasHtmlBody ? undefined : { disabled: true },
        },
      ],
    });
  }

  return actions;
}

function isMessageAction(action: string): action is MessageAction {
  return ['archive', 'reply', 'reply-all', 'toggle-pin', 'toggle-unread', 'trash'].includes(action);
}

function getMessageActionRequest(
  action: MessageAction,
  messageId: string,
  message: Message,
): Promise<JmapMessageActionResult> {
  switch (action) {
    case 'archive':
      return archiveJmapEmail(messageId);
    case 'toggle-pin':
      return setJmapEmailPinned(messageId, !message.pinned);
    case 'toggle-unread':
      return setJmapEmailUnread(messageId, !message.unread);
    case 'trash':
      return trashJmapEmail(messageId);
    case 'reply':
    case 'reply-all':
      return Promise.resolve({});
  }
}

function MessageDetail({
  bodyDebug,
  colors,
  expandedMessageIds,
  focusedMessageId,
  insetsTop,
  mailboxName,
  message,
  messages,
  onAction,
  onExpandAll,
  onToggleMessage,
}: {
  bodyDebug?: JmapMessageBodyDebug;
  colors: ColorSet;
  expandedMessageIds: Set<string>;
  focusedMessageId: string;
  insetsTop: number;
  mailboxName?: string;
  message: Message;
  messages: Message[];
  onAction: (action: MessageAction) => void;
  onExpandAll: () => void;
  onToggleMessage: (messageId: string) => void;
}) {
  const scrollViewRef = useRef<ScrollView>(null);
  const didScrollToFocusedMessageRef = useRef(false);
  const collapsedMessageCount = messages.filter((threadMessage) => !expandedMessageIds.has(threadMessage.id)).length;
  const shouldAutoScrollThread = messages.length > 4;
  const threadTitle = messages[0]?.subject ?? message.subject;
  const canToggleThreadMessages = messages.length > 1;
  const canExpandThread = collapsedMessageCount > 0;

  useEffect(() => {
    didScrollToFocusedMessageRef.current = false;
  }, [focusedMessageId, messages.length]);

  const handleThreadItemLayout = useCallback(
    (threadMessageId: string, y: number) => {
      if (
        !shouldAutoScrollThread ||
        threadMessageId !== focusedMessageId ||
        didScrollToFocusedMessageRef.current
      ) {
        return;
      }

      didScrollToFocusedMessageRef.current = true;
      const scrollTask = InteractionManager.runAfterInteractions(() => {
        scrollViewRef.current?.scrollTo({
          animated: false,
          y: Math.max(0, y - threadScrollOffset),
        });
      });

      setTimeout(() => scrollTask.cancel(), 500);
    },
    [focusedMessageId, shouldAutoScrollThread],
  );

  return (
    <ScrollView
      ref={scrollViewRef}
      contentContainerStyle={[
        styles.messageDetailContent,
        { paddingBottom: 128, paddingTop: insetsTop + 74 },
      ]}
      showsVerticalScrollIndicator={false}>
      <View style={styles.messageTitleRow}>
        <Text {...textScale} style={[styles.messageDetailTitle, { color: colors.text }]}>
          {threadTitle}
        </Text>
        {canExpandThread ? (
          <Pressable
            accessibilityLabel="Expand conversation history"
            accessibilityRole="button"
            onPress={onExpandAll}
            style={({ pressed }) => [styles.threadExpandAllButton, pressed && styles.pressed]}>
            <SymbolView
              name="rectangle.expand.vertical"
              tintColor={colors.secondaryText}
              size={22}
              weight="regular"
            />
          </Pressable>
        ) : null}
      </View>
      <Text
        {...textScale}
        numberOfLines={1}
        style={[
          styles.mailboxChip,
          styles.mailboxChipText,
          { backgroundColor: colors.messageChip, color: colors.text },
        ]}>
        {message.mailboxName ?? mailboxName ?? 'Inbox'}
      </Text>

      <View style={styles.threadList}>
        {messages.map((threadMessage, index) => {
          const expanded = !canToggleThreadMessages || expandedMessageIds.has(threadMessage.id);

          return (
            <MessageThreadItem
              bodyDebug={threadMessage.id === message.id ? bodyDebug : undefined}
              canToggle={canToggleThreadMessages}
              colors={colors}
              expanded={expanded}
              focused={threadMessage.id === focusedMessageId}
              isLast={index === messages.length - 1}
              key={threadMessage.id}
              message={threadMessage}
              onAction={onAction}
              onLayout={handleThreadItemLayout}
              onToggle={() => onToggleMessage(threadMessage.id)}
              showMenu={threadMessage.id === focusedMessageId}
            />
          );
        })}
      </View>
    </ScrollView>
  );
}

function MessageThreadItem({
  bodyDebug,
  canToggle,
  colors,
  expanded,
  focused,
  isLast,
  message,
  onAction,
  onLayout,
  onToggle,
  showMenu,
}: {
  bodyDebug?: JmapMessageBodyDebug;
  canToggle: boolean;
  colors: ColorSet;
  expanded: boolean;
  focused: boolean;
  isLast: boolean;
  message: Message;
  onAction: (action: MessageAction) => void;
  onLayout: (messageId: string, y: number) => void;
  onToggle: () => void;
  showMenu: boolean;
}) {
  return (
    <View
      onLayout={(event) => onLayout(message.id, event.nativeEvent.layout.y)}
      style={!isLast ? [styles.threadSeparator, { borderBottomColor: colors.groupDivider }] : null}>
      {expanded ? (
        <ExpandedThreadMessage
          bodyDebug={bodyDebug}
          colors={colors}
          focused={focused}
          message={message}
          onAction={onAction}
          onToggle={canToggle ? onToggle : undefined}
          showMenu={showMenu}
        />
      ) : (
        <CollapsedThreadMessage
          colors={colors}
          message={message}
          onPress={onToggle}
        />
      )}
    </View>
  );
}

function CollapsedThreadMessage({
  colors,
  message,
  onPress,
}: {
  colors: ColorSet;
  message: Message;
  onPress: () => void;
}) {
  return (
    <View style={styles.threadCollapsedItem}>
      <ThreadMessageHeader
        colors={colors}
        message={message}
        onPress={onPress}
        showMenu={false}
      />
    </View>
  );
}

function ExpandedThreadMessage({
  bodyDebug,
  colors,
  focused,
  message,
  onAction,
  onToggle,
  showMenu,
}: {
  bodyDebug?: JmapMessageBodyDebug;
  colors: ColorSet;
  focused: boolean;
  message: Message;
  onAction: (action: MessageAction) => void;
  onToggle?: () => void;
  showMenu: boolean;
}) {
  const debugMode = useDebugMode();
  const body = message.body ?? message.preview ?? getMockMessageBody();
  const rawHtmlBody = message.htmlBody;
  const htmlBody = rawHtmlBody?.trim();
  const htmlReplySplit = useMemo(
    () => (htmlBody ? splitEmailReplyHtml(htmlBody) : null),
    [htmlBody],
  );
  const textReplySplit = useMemo(
    () => (!htmlBody ? splitEmailReplyText(body) : null),
    [body, htmlBody],
  );
  const [quoteHistoryExpanded, setQuoteHistoryExpanded] = useState(false);
  const visibleHtmlBody = htmlReplySplit?.bodyHtml ?? htmlBody;
  const quoteHtmlBody = htmlReplySplit?.quoteHtml ?? null;
  const visibleTextBody = textReplySplit?.bodyText ?? body;
  const quoteTextBody = textReplySplit?.quoteText ?? null;
  const hasQuoteHistory = Boolean(quoteHtmlBody || quoteTextBody);
  const attachments = message.attachments ?? [];
  const [imageDebug, setImageDebug] = useState<EmailWebViewImageDebug | null>(null);
  const [darkModeDebug, setDarkModeDebug] = useState<EmailWebViewDarkModeDebug | null>(null);
  const messageMenuActions = useMemo(
    () => getMessageMenuActions(message, debugMode, Boolean(htmlBody)),
    [debugMode, htmlBody, message.pinned, message.unread],
  );

  useEffect(() => {
    setImageDebug(null);
    setDarkModeDebug(null);
  }, [htmlBody]);
  useEffect(() => {
    setQuoteHistoryExpanded(false);
  }, [body, htmlBody, message.id]);

  const handleMenuAction = (event: NativeActionEvent) => {
    const action = event.nativeEvent.event;

    if (isMessageAction(action)) {
      onAction(action);
    } else if (action === copyEmailHtmlAction && htmlBody && rawHtmlBody) {
      Clipboard.setString(rawHtmlBody);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else {
      pressHaptic();
    }
  };
  const handleHistoryButtonPress = () => {
    pressHaptic();
    setQuoteHistoryExpanded((expanded) => !expanded);
  };

  return (
    <View style={[styles.threadExpandedItem, focused && styles.threadFocusedItem]}>
      <ThreadMessageHeader
        colors={colors}
        menuActions={messageMenuActions}
        message={message}
        onMenuAction={handleMenuAction}
        onPress={onToggle}
        showMenu={showMenu}
      />

      {visibleHtmlBody ? (
        <>
          <EmailBodyWebView
            colors={colors}
            html={visibleHtmlBody}
            onDarkModeDebug={setDarkModeDebug}
            onImageDebug={setImageDebug}
          />
          {hasQuoteHistory ? (
            <EmailHistoryButton
              colors={colors}
              expanded={quoteHistoryExpanded}
              onPress={handleHistoryButtonPress}
            />
          ) : null}
          {quoteHtmlBody && quoteHistoryExpanded ? (
            <EmailBodyWebView
              colors={colors}
              html={quoteHtmlBody}
              onImageDebug={() => {}}
            />
          ) : null}
          <AttachmentList attachments={attachments} colors={colors} />
          {debugMode ? (
            <EmailBodyDebugReport
              colors={colors}
              debug={bodyDebug}
              darkModeDebug={darkModeDebug}
              html={htmlBody ?? visibleHtmlBody}
              imageDebug={imageDebug}
            />
          ) : null}
        </>
      ) : (
        <>
          <Text {...textScale} style={[styles.messageBodyText, { color: colors.text }]}>
            {visibleTextBody}
          </Text>
          {hasQuoteHistory ? (
            <EmailHistoryButton
              colors={colors}
              expanded={quoteHistoryExpanded}
              onPress={handleHistoryButtonPress}
            />
          ) : null}
          {quoteTextBody && quoteHistoryExpanded ? (
            <Text
              {...textScale}
              style={[styles.messageBodyText, styles.messageQuoteText, { color: colors.secondaryText }]}>
              {quoteTextBody}
            </Text>
          ) : null}
          <AttachmentList attachments={attachments} colors={colors} />
          {debugMode ? (
            <Text style={[styles.renderingModeNote, { color: colors.secondaryText }]}>
              (rendering text)
            </Text>
          ) : null}
        </>
      )}
    </View>
  );
}

function EmailHistoryButton({
  colors,
  expanded,
  onPress,
}: {
  colors: ColorSet;
  expanded: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={expanded ? 'Collapse quoted history' : 'Expand quoted history'}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.threadHistoryButton,
        { backgroundColor: colors.messageChip },
        pressed && styles.pressed,
      ]}>
      <SymbolView name="ellipsis" tintColor={colors.secondaryText} size={18} weight="semibold" />
    </Pressable>
  );
}

function ThreadMessageHeader({
  colors,
  menuActions,
  message,
  onMenuAction,
  onPress,
  showMenu,
}: {
  colors: ColorSet;
  menuActions?: MenuAction[];
  message: Message;
  onMenuAction?: (event: NativeActionEvent) => void;
  onPress?: () => void;
  showMenu: boolean;
}) {
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [styles.messageHeaderRow, pressed && styles.pressed]}>
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
            {message.sender}
          </Text>
          <View style={styles.messageHeaderMeta}>
            {message.hasAttachment ? (
              <SymbolView name="paperclip" tintColor={colors.secondaryText} size={15} weight="semibold" />
            ) : null}
            <Text
              {...textScale}
              numberOfLines={1}
              style={[styles.messageDetailDate, { color: colors.secondaryText }]}>
              {message.date}
            </Text>
          </View>
        </View>
        <View style={styles.messageSenderBottomRow}>
          <View style={styles.messageRecipientRow}>
            <Text {...textScale} numberOfLines={1} style={[styles.messageRecipient, { color: colors.secondaryText }]}>
              {message.to ? `To: ${message.to}` : 'To: Me'}
            </Text>
            <SymbolView name="chevron.down" tintColor={colors.secondaryText} size={12} weight="semibold" />
          </View>
          {showMenu && menuActions && onMenuAction ? (
            <MenuView
              actions={menuActions}
              onPressAction={onMenuAction}
              style={styles.messageMenuHost}>
              <View style={styles.messageEllipsisButton}>
                <SymbolView name="ellipsis" tintColor={colors.secondaryText} size={20} weight="semibold" />
              </View>
            </MenuView>
          ) : (
            <View style={styles.messageMenuHost} />
          )}
        </View>
      </View>
    </Pressable>
  );
}

function AttachmentList({
  attachments,
  colors,
}: {
  attachments: MessageAttachment[];
  colors: ColorSet;
}) {
  if (!attachments.length) {
    return null;
  }

  const openAttachment = (attachment: MessageAttachment) => {
    pressHaptic();
    void openNativeAttachmentPreviewAsync({
      contentType: attachment.type,
      dataUrl: attachment.previewDataUrl,
      fileName: attachment.name,
    }).catch(() => {});
  };

  return (
    <ScrollView
      horizontal
      contentContainerStyle={styles.attachmentListContent}
      showsHorizontalScrollIndicator={false}
      style={styles.attachmentList}>
      {attachments.map((attachment, index) => (
        <Pressable
          accessibilityRole="button"
          key={`${attachment.id}-${index}`}
          onPress={() => openAttachment(attachment)}
          style={[styles.attachmentTile, index === attachments.length - 1 ? styles.attachmentTileLast : null]}>
          <AttachmentPreview attachment={attachment} colors={colors} />
          <Text {...textScale} numberOfLines={2} style={[styles.attachmentName, { color: colors.text }]}>
            {attachment.name}
          </Text>
          <Text {...textScale} numberOfLines={1} style={[styles.attachmentMeta, { color: colors.secondaryText }]}>
            {formatAttachmentSize(attachment.size)}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

function AttachmentPreview({
  attachment,
  colors,
}: {
  attachment: MessageAttachment;
  colors: ColorSet;
}) {
  const isImage = attachment.type.toLowerCase().startsWith('image/');
  const canRenderNativePreview =
    Boolean(attachment.previewDataUrl) && canUseNativeAttachmentThumbnail && !isImage;

  return (
    <View style={[styles.attachmentPreview, { backgroundColor: colors.attachmentPreviewBackground }]}>
      {attachment.previewDataUrl && isImage ? (
        <ExpoImage
          cachePolicy="memory-disk"
          contentFit="cover"
          source={{ uri: attachment.previewDataUrl }}
          style={styles.attachmentPreviewImage}
          transition={120}
        />
      ) : null}
      {canRenderNativePreview ? (
        <AttachmentThumbnailView
          contentType={attachment.type}
          dataUrl={attachment.previewDataUrl}
          fileName={attachment.name}
          style={styles.attachmentPreviewImage}
        />
      ) : null}
      {!attachment.previewDataUrl || (!isImage && !canRenderNativePreview) ? (
        <SymbolView
          name={getAttachmentSymbol(attachment)}
          tintColor={getAttachmentIconTint(attachment, colors)}
          size={34}
          weight="semibold"
        />
      ) : null}
    </View>
  );
}

function getAttachmentSymbol(attachment: MessageAttachment): ComponentProps<typeof SymbolView>['name'] {
  const type = attachment.type.toLowerCase();

  if (type.startsWith('image/')) {
    return 'photo';
  }

  if (type === 'application/pdf') {
    return 'doc.richtext';
  }

  if (type.startsWith('text/')) {
    return 'doc.text';
  }

  return 'paperclip';
}

function getAttachmentIconTint(attachment: MessageAttachment, colors: ColorSet) {
  if (attachment.type.toLowerCase().startsWith('image/')) {
    return colors.attachmentImage;
  }

  return colors.secondaryText;
}

function formatAttachmentSize(size: number) {
  if (!Number.isFinite(size) || size <= 0) {
    return 'Unknown size';
  }

  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${Math.round(size / 1024)} KB`;
  }

  return `${(size / 1024 / 1024).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function EmailBodyDebugReport({
  colors,
  debug,
  darkModeDebug,
  html,
  imageDebug,
}: {
  colors: ColorSet;
  debug?: JmapMessageBodyDebug;
  darkModeDebug: EmailWebViewDarkModeDebug | null;
  html: string;
  imageDebug: EmailWebViewImageDebug | null;
}) {
  const renderedCidCount = html.match(/\bcid:/gi)?.length ?? 0;
  const reportText = getEmailDebugReportText(debug, renderedCidCount, imageDebug, darkModeDebug);
  const copyReport = () => {
    Clipboard.setString(reportText);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  return (
    <View style={[styles.emailDebugBox, { borderColor: colors.groupDivider }]}>
      <View style={styles.emailDebugHeader}>
        <Text style={[styles.emailDebugLabel, { color: colors.secondaryText }]}>Email HTML Debug</Text>
        <Pressable accessibilityRole="button" onPress={copyReport} style={styles.emailDebugCopyButton}>
          <Text style={[styles.emailDebugCopyText, { color: colors.text }]}>Copy</Text>
        </Pressable>
      </View>
      <Text style={[styles.emailDebugText, { color: colors.secondaryText }]}>{reportText}</Text>
    </View>
  );
}

function getEmailDebugReportText(
  debug: JmapMessageBodyDebug | undefined,
  renderedCidCount: number,
  imageDebug: EmailWebViewImageDebug | null,
  darkModeDebug: EmailWebViewDarkModeDebug | null,
) {
  const imageDebugText = getEmailImageDebugText(imageDebug);
  const darkModeDebugText = getEmailDarkModeDebugText(darkModeDebug);

  if (!debug) {
    return [
      `HTML debug unavailable. Rendered HTML cid refs: ${renderedCidCount}.`,
      imageDebugText,
      darkModeDebugText,
    ].join('\n');
  }

  const cidReferences = debug.cidReferences.length ? debug.cidReferences.join(', ') : 'none';
  const unresolvedCidReferences = debug.unresolvedCidReferences.length
    ? debug.unresolvedCidReferences.join(', ')
    : 'none';
  const embeddedImageKinds = debug.generatedDownloadUrlHosts.length
    ? debug.generatedDownloadUrlHosts.join(', ')
    : 'none';
  const imageParts = debug.cidImageParts.length
    ? debug.cidImageParts
        .map((part) => `${part.cid || 'no-cid'} ${part.type ?? 'unknown'} ${part.name ?? ''}`.trim())
        .join('\n')
    : 'none';
  const inlineImageErrors = debug.inlineImageErrors?.length ? debug.inlineImageErrors.join('\n') : 'none';

  return [
    `cid refs: ${debug.cidReferenceCount} (${cidReferences})`,
    `cid image parts: ${debug.cidImagePartCount}`,
    `embedded image urls: ${debug.generatedDownloadUrlCount} (${embeddedImageKinds})`,
    `replaced refs: ${debug.replacedCidReferenceCount}`,
    `unresolved refs: ${unresolvedCidReferences}`,
    `cid left after rewrite: ${debug.htmlContainsCidAfterRewrite ? 'yes' : 'no'}`,
    `rendered HTML cid refs: ${renderedCidCount}`,
    `body parts: ${debug.bodyStructurePartCount}; htmlBody: ${debug.htmlBodyPartCount}; attachments: ${debug.attachmentPartCount}`,
    `inline image errors: ${debug.downloadUrlErrorCount}`,
    `inline image error details:\n${inlineImageErrors}`,
    `parts:\n${imageParts}`,
    imageDebugText,
    darkModeDebugText,
  ].join('\n');
}

function getEmailDarkModeDebugText(darkModeDebug: EmailWebViewDarkModeDebug | null) {
  if (!darkModeDebug) {
    return 'dark mode transform: pending/disabled';
  }

  return [
    'dark mode transform:',
    `backgrounds=${darkModeDebug.backgroundCount}`,
    `text=${darkModeDebug.textCount}`,
    `links=${darkModeDebug.linkCount}`,
    `borders=${darkModeDebug.borderCount}`,
    `skipped colored=${darkModeDebug.skippedColoredBackgroundCount}`,
    `skipped image bg=${darkModeDebug.skippedBackgroundImageCount}`,
  ].join(' ');
}

function getEmailImageDebugText(imageDebug: EmailWebViewImageDebug | null) {
  if (!imageDebug) {
    return 'webview images: pending';
  }

  const images = imageDebug.images.length
    ? imageDebug.images
        .map((image, index) =>
          [
            `${index + 1}. ${image.status}`,
            `src=${image.srcHost || 'none'}`,
            `current=${image.currentSrcHost || 'none'}`,
            `complete=${image.complete ? 'yes' : 'no'}`,
            `natural=${image.naturalWidth}x${image.naturalHeight}`,
            `rendered=${image.renderedWidth}x${image.renderedHeight}`,
            `attr=${image.widthAttr || 'none'}x${image.heightAttr || 'none'}`,
            `parent=${image.parentTag || 'none'}:${image.parentWidth}`,
            `prefix=${image.srcPrefix}`,
          ].join(' '),
        )
        .join('\n')
    : 'none';

  return [
    `webview image phase: ${imageDebug.phase}`,
    `webview image count: ${imageDebug.imageCount}`,
    `webview images:\n${images}`,
  ].join('\n');
}

function EmailBodyWebView({
  colors,
  html,
  onDarkModeDebug,
  onImageDebug,
}: {
  colors: ColorSet;
  html: string;
  onDarkModeDebug?: (debug: EmailWebViewDarkModeDebug) => void;
  onImageDebug: (debug: EmailWebViewImageDebug) => void;
}) {
  const [contentWidth, setContentWidth] = useState(defaultEmailBodyWidth);
  const [webViewHeight, setWebViewHeight] = useState(minEmailBodyWebViewHeight);
  const measuredContentWidth = Math.max(1, Math.round(contentWidth));
  const emailBackground = colors.emailBackground;
  const emailColors = useMemo(
    () => ({ ...colors, background: emailBackground }),
    [colors, emailBackground],
  );
  const source = useMemo(
    () => ({
      html: getEmailHtmlDocument({
        colors: emailColors,
        contentWidth: measuredContentWidth,
        horizontalPadding: messageDetailHorizontalPadding,
        html,
      }),
      baseUrl: 'about:blank',
    }),
    [emailColors, html, measuredContentWidth],
  );
  const heightMeasurementScript = useMemo(
    () => getEmailBodyHeightScript(measuredContentWidth, colors.emailBackground !== lightColors.emailBackground),
    [colors.emailBackground, measuredContentWidth],
  );
  const handleLayout = (event: { nativeEvent: { layout: { width: number } } }) => {
    const nextWidth = event.nativeEvent.layout.width;

    if (nextWidth <= 0) {
      return;
    }

    setContentWidth((currentWidth) =>
      Math.abs(currentWidth - nextWidth) > 1 ? nextWidth : currentWidth,
    );
  };
  useEffect(() => {
    setWebViewHeight(minEmailBodyWebViewHeight);
  }, [html, measuredContentWidth]);
  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      try {
        const message = JSON.parse(event.nativeEvent.data);

        if (message?.type === 'height' && typeof message.height === 'number') {
          const nextHeight = clampEmailBodyHeight(message.height);

          setWebViewHeight((currentHeight) =>
            Math.abs(currentHeight - nextHeight) > 1 ? nextHeight : currentHeight,
          );
        } else if (message?.type === 'image-debug' && message.imageDebug) {
          onImageDebug(message.imageDebug);
        } else if (message?.type === 'dark-mode-debug' && message.darkModeDebug) {
          onDarkModeDebug?.(message.darkModeDebug);
        }
      } catch {}
    },
    [onDarkModeDebug, onImageDebug],
  );
  const handleShouldStartLoadWithRequest = (request: {
    isTopFrame?: boolean;
    navigationType?: string;
    url?: string;
  }) => {
    const url = request.url ?? '';

    if (!url || url === 'about:blank' || url === 'about:srcdoc') {
      return true;
    }

    if (/^(data:|blob:|cid:)/i.test(url)) {
      return true;
    }

    if (/^(https?:|mailto:)/i.test(url)) {
      const isTopNavigation = request.isTopFrame === true;
      const isUserNavigation =
        request.navigationType === 'click' || request.navigationType === 'formsubmit';

      if (isTopNavigation && isUserNavigation) {
        void Linking.openURL(url);
        return false;
      }

      return true;
    }

    return false;
  };

  return (
    <View onLayout={handleLayout} style={[styles.htmlBody, { height: webViewHeight }]}>
      <WebView
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        automaticallyAdjustContentInsets={false}
        bounces={false}
        cacheEnabled={false}
        containerStyle={styles.htmlBodyWebViewContainer}
        decelerationRate="normal"
        domStorageEnabled={false}
        incognito
        injectedJavaScript={heightMeasurementScript}
        javaScriptCanOpenWindowsAutomatically={false}
        javaScriptEnabled
        mixedContentMode="never"
        nestedScrollEnabled={false}
        onMessage={handleMessage}
        onShouldStartLoadWithRequest={handleShouldStartLoadWithRequest}
        originWhitelist={['about:blank', 'about:srcdoc', 'data:*', 'http://*', 'https://*', 'mailto:*']}
        scrollEnabled={false}
        setSupportMultipleWindows={false}
        sharedCookiesEnabled={false}
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        source={source}
        style={[styles.htmlBodyWebView, { backgroundColor: emailBackground }]}
        thirdPartyCookiesEnabled={false}
      />
    </View>
  );
}

function getMockMessageBody() {
  return [
    'Dear Trusted Traveler Program members,',
    'The Centers for Disease Control and Prevention (CDC) has issued a public health order affecting travelers who have recently been in Uganda, Democratic Republic of the Congo (DRC), or South Sudan.',
    'What You Need to Know:',
    '  \u2022  If you have been in Uganda, DRC, or South Sudan within the past 21 days, you may be subject to additional screening and travel procedures when entering the United States.',
    '  \u2022  Designated Airports for Arrival: If you have visited one of these countries in the 21 days before your travel to the US, your flight must arrive to a designated airport for enhanced public health measures.',
    '       \u00a7 Washington Dulles International Airport (IAD), Dulles, Virginia',
    '       \u00a7 Atlanta International Airport (ATL), Atlanta, Georgia',
  ].join('\n\n');
}

type ColorSet = typeof lightColors;

const lightColors = {
  background: '#FFFFFF',
  emailBackground: '#FFFFFF',
  text: '#050505',
  secondaryText: '#7E7E82',
  attachmentImage: '#FF3B30',
  attachmentPreviewBackground: '#F0F0F2',
  groupDivider: 'rgba(60, 60, 67, 0.16)',
  messageChip: 'rgba(118, 118, 128, 0.16)',
  pin: '#FF3B30',
  glassTint: 'rgba(255, 255, 255, 0.62)',
  fallbackGlass: 'rgba(255, 255, 255, 0.86)',
  fallbackBorder: 'rgba(255, 255, 255, 0.65)',
};

const darkColors: ColorSet = {
  background: '#090909',
  emailBackground: '#1C1C1E',
  text: '#F5F5F5',
  secondaryText: '#A8A8AE',
  attachmentImage: '#FF453A',
  attachmentPreviewBackground: '#2A2A2C',
  groupDivider: 'rgba(235, 235, 245, 0.16)',
  messageChip: 'rgba(118, 118, 128, 0.28)',
  pin: '#FF453A',
  glassTint: 'rgba(36, 36, 38, 0.64)',
  fallbackGlass: 'rgba(36, 36, 38, 0.88)',
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
    paddingHorizontal: messageDetailHorizontalPadding,
  },
  messageTitleRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
  },
  messageDetailTitle: {
    flex: 1,
    fontFamily: systemFont,
    fontSize: 26,
    fontWeight: '800',
    letterSpacing: 0,
    lineHeight: 32,
  },
  threadExpandAllButton: {
    alignItems: 'center',
    height: 32,
    justifyContent: 'center',
    marginRight: -4,
    width: 30,
  },
  mailboxChip: {
    alignSelf: 'flex-start',
    borderRadius: 4,
    flexGrow: 0,
    flexShrink: 0,
    height: 24,
    marginTop: 12,
    overflow: 'hidden',
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  mailboxChipText: {
    fontFamily: systemFont,
    fontSize: 14,
    fontWeight: '500',
    lineHeight: 18,
  },
  threadList: {
    marginTop: 14,
  },
  threadSeparator: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  threadCollapsedItem: {
    paddingBottom: 16,
    paddingTop: 16,
  },
  threadExpandedItem: {
    paddingBottom: 16,
    paddingTop: 16,
  },
  threadFocusedItem: {
  },
  threadHistoryButton: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderRadius: 7,
    height: 18,
    justifyContent: 'center',
    marginTop: 14,
    width: 36,
  },
  pressed: {
    opacity: 0.72,
  },
  messageHeaderRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
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
    alignItems: 'flex-start',
    flexDirection: 'row',
  },
  messageHeaderMeta: {
    alignItems: 'center',
    flexDirection: 'row',
    flexShrink: 0,
    gap: 4,
    justifyContent: 'flex-end',
    marginLeft: 10,
    minWidth: 78,
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
    textAlign: 'right',
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
  messageQuoteText: {
    marginTop: 14,
  },
  renderingModeNote: {
    fontFamily: systemFont,
    fontSize: 3,
    fontWeight: '400',
    lineHeight: 5,
    marginTop: 6,
  },
  emailDebugBox: {
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: 12,
    padding: 10,
  },
  emailDebugHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  emailDebugLabel: {
    fontFamily: systemFont,
    fontSize: 11,
    fontWeight: '600',
    lineHeight: 14,
  },
  emailDebugCopyButton: {
    minHeight: 26,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  emailDebugCopyText: {
    fontFamily: systemFont,
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 16,
  },
  emailDebugText: {
    fontFamily: Platform.select({ ios: 'ui-monospace', default: undefined }),
    fontSize: 10,
    fontWeight: '400',
    lineHeight: 14,
  },
  htmlBody: {
    marginHorizontal: -messageDetailHorizontalPadding,
    marginTop: 20,
  },
  htmlBodyWebView: {
    flex: 1,
  },
  htmlBodyWebViewContainer: {
    flex: 1,
  },
  attachmentList: {
    marginHorizontal: -messageDetailHorizontalPadding,
    marginTop: 24,
  },
  attachmentListContent: {
    paddingHorizontal: messageDetailHorizontalPadding,
  },
  attachmentTile: {
    alignItems: 'center',
    marginRight: 14,
    width: 116,
  },
  attachmentTileLast: {
    marginRight: 0,
  },
  attachmentPreview: {
    alignItems: 'center',
    borderRadius: 6,
    height: 116,
    justifyContent: 'center',
    overflow: 'hidden',
    width: 116,
  },
  attachmentPreviewImage: {
    height: '100%',
    width: '100%',
  },
  attachmentName: {
    fontFamily: systemFont,
    fontSize: 14,
    fontWeight: '400',
    lineHeight: 17,
    marginTop: 7,
    minHeight: 34,
    textAlign: 'center',
    width: '100%',
  },
  attachmentMeta: {
    fontFamily: systemFont,
    fontSize: 12,
    fontWeight: '400',
    lineHeight: 15,
    marginTop: 2,
    textAlign: 'center',
    width: '100%',
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
