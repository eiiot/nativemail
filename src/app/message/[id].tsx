import { GradientAvatar } from '@/components/gradient-avatar';
import {
  AttachmentThumbnailView,
  canUseNativeAttachmentThumbnail,
  openNativeAttachmentPreviewAsync,
} from '@/components/attachment-thumbnail-view';
import {
  archiveJmapEmail,
  fetchJmapMessageBody,
  setJmapEmailPinned,
  setJmapEmailUnread,
  trashJmapEmail,
  type JmapMessageBody,
  type JmapMessageBodyDebug,
  type JmapMessageActionResult,
} from '@/lib/jmap-client';
import { useDebugMode } from '@/lib/debug-mode';
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
import { ComponentProps, PropsWithChildren, useEffect, useId, useMemo, useState } from 'react';
import {
  Clipboard,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const textScale = { maxFontSizeMultiplier: 1.12 };
const messageDetailHorizontalPadding = 20;
const messageBodyFetchRevision = 8;
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
    naturalHeight: number;
    naturalWidth: number;
    srcHost: string;
    srcPrefix: string;
    status: string;
  }[];
  phase: string;
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
    to?: string;
    unread?: string;
  }>();
  const { id, mailboxName, source } = params;
  const insets = useSafeAreaInsets();
  const colors = lightColors;
  const messageId = Array.isArray(id) ? id[0] : id;
  const fallbackMessage = getMessageById(messageId);
  const routeMessage = getRouteMessage(params, fallbackMessage);
  const [localFlags, setLocalFlags] = useState({
    pinned: routeMessage.pinned,
    unread: routeMessage.unread,
  });
  const [jmapBody, setJmapBody] = useState<JmapMessageBody | null>(null);
  const [pendingAction, setPendingAction] = useState<MessageAction | null>(null);
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

  useEffect(() => {
    setLocalFlags({
      pinned: routeMessage.pinned,
      unread: routeMessage.unread,
    });
    setPendingAction(null);
  }, [messageId, routeMessage.pinned, routeMessage.unread]);

  useEffect(() => {
    const shouldLoadJmap = source === 'jmap';

    if (!messageId || !shouldLoadJmap) {
      Promise.resolve().then(() => {
        setJmapBody(null);
      });
      return;
    }

    const controller = new AbortController();

    fetchJmapMessageBody(messageId, controller.signal)
      .then((body) => {
        setJmapBody(body);
      })
      .catch(() => {
        if (controller.signal.aborted) {
          return;
        }

        setJmapBody(null);
      });

    return () => {
      controller.abort();
    };
  }, [messageId, source, messageBodyFetchRevision]);

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
        <Stack.Toolbar.Button disabled icon="tag" onPress={pressHaptic} tintColor={colors.secondaryText} />
        <Stack.Toolbar.Button disabled icon="folder" onPress={pressHaptic} tintColor={colors.secondaryText} />
        <Stack.Toolbar.Menu icon="ellipsis" separateBackground tintColor={colors.text}>
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
          tintColor={colors.text}
        />
        <Stack.Toolbar.Button
          disabled={actionDisabled}
          icon={message.unread ? 'envelope.open' : 'envelope.badge'}
          onPress={() => runMessageAction('toggle-unread')}
          tintColor={colors.text}
        />
        <Stack.Toolbar.Button
          disabled={actionDisabled}
          icon={message.pinned ? 'pin.fill' : 'pin'}
          onPress={() => runMessageAction('toggle-pin')}
          tintColor={message.pinned ? colors.pin : colors.text}
        />
        <Stack.Toolbar.Spacer width={1} />
        <Stack.Toolbar.Button
          disabled={actionDisabled}
          icon="arrowshape.turn.up.left"
          onPress={() => runMessageAction('reply')}
          separateBackground
          tintColor={colors.text}
        />
        <Stack.Toolbar.Spacer />
        <Stack.Toolbar.Button
          disabled={actionDisabled}
          icon="trash"
          onPress={() => runMessageAction('trash')}
          separateBackground
          tintColor={colors.text}
        />
      </Stack.Toolbar>

      <View style={[styles.root, { backgroundColor: colors.background }]}>
        <MessageDetail
          bodyDebug={jmapBody?.debug}
          colors={colors}
          insetsTop={insets.top}
          mailboxName={mailboxName}
          message={message}
          onAction={runMessageAction}
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
    to: getRouteParam(params.to) || fallbackMessage.to,
    unread: unread ? unread === '1' : fallbackMessage.unread,
  };
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
  insetsTop,
  mailboxName,
  message,
  onAction,
}: {
  bodyDebug?: JmapMessageBodyDebug;
  colors: ColorSet;
  insetsTop: number;
  mailboxName?: string;
  message: Message;
  onAction: (action: MessageAction) => void;
}) {
  const debugMode = useDebugMode();
  const body = message.body ?? getMockMessageBody();
  const rawHtmlBody = message.htmlBody;
  const htmlBody = rawHtmlBody?.trim();
  const attachments = message.attachments ?? [];
  const [imageDebug, setImageDebug] = useState<EmailWebViewImageDebug | null>(null);
  const messageMenuActions = useMemo(
    () => getMessageMenuActions(message, debugMode, Boolean(htmlBody)),
    [debugMode, htmlBody, message.pinned, message.unread],
  );

  useEffect(() => {
    setImageDebug(null);
  }, [htmlBody]);
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

  return (
    <ScrollView
      contentContainerStyle={[
        styles.messageDetailContent,
        { paddingBottom: 128, paddingTop: insetsTop + 74 },
      ]}
      showsVerticalScrollIndicator={false}>
      <Text {...textScale} style={[styles.messageDetailTitle, { color: colors.text }]}>
        {message.subject}
      </Text>
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

      {htmlBody ? (
        <>
          <EmailBodyWebView colors={colors} html={htmlBody} onImageDebug={setImageDebug} />
          <AttachmentList attachments={attachments} colors={colors} />
          {debugMode ? (
            <EmailBodyDebugReport
              colors={colors}
              debug={bodyDebug}
              html={htmlBody}
              imageDebug={imageDebug}
            />
          ) : null}
        </>
      ) : (
        <>
          <Text {...textScale} style={[styles.messageBodyText, { color: colors.text }]}>
            {body}
          </Text>
          <AttachmentList attachments={attachments} colors={colors} />
          {debugMode ? (
            <Text style={[styles.renderingModeNote, { color: colors.secondaryText }]}>
              (rendering text)
            </Text>
          ) : null}
        </>
      )}
    </ScrollView>
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
  html,
  imageDebug,
}: {
  colors: ColorSet;
  debug?: JmapMessageBodyDebug;
  html: string;
  imageDebug: EmailWebViewImageDebug | null;
}) {
  const renderedCidCount = html.match(/\bcid:/gi)?.length ?? 0;
  const reportText = getEmailDebugReportText(debug, renderedCidCount, imageDebug);
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
) {
  const imageDebugText = getEmailImageDebugText(imageDebug);

  if (!debug) {
    return [
      `HTML debug unavailable. Rendered HTML cid refs: ${renderedCidCount}.`,
      imageDebugText,
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
  ].join('\n');
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
  onImageDebug,
}: {
  colors: ColorSet;
  html: string;
  onImageDebug: (debug: EmailWebViewImageDebug) => void;
}) {
  const [contentWidth, setContentWidth] = useState(defaultEmailBodyWidth);
  const [webViewHeight, setWebViewHeight] = useState(minEmailBodyWebViewHeight);
  const measuredContentWidth = Math.max(1, Math.round(contentWidth));
  const source = useMemo(
    () => ({
      html: getEmailHtmlDocument(html, colors, measuredContentWidth),
      baseUrl: 'about:blank',
    }),
    [colors, html, measuredContentWidth],
  );
  const heightMeasurementScript = useMemo(
    () => getEmailBodyHeightScript(measuredContentWidth),
    [measuredContentWidth],
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

  const handleMessage = (event: { nativeEvent: { data: string } }) => {
    try {
      const message = JSON.parse(event.nativeEvent.data) as {
        height?: number;
        imageDebug?: EmailWebViewImageDebug;
        type?: string;
      };

      if (message.type === 'image-debug' && message.imageDebug) {
        onImageDebug(message.imageDebug);
        return;
      }

      if (message.type !== 'height' || typeof message.height !== 'number') {
        return;
      }

      const nextHeight = Math.min(
        maxEmailBodyWebViewHeight,
        Math.max(minEmailBodyWebViewHeight, Math.ceil(message.height)),
      );

      setWebViewHeight((currentHeight) =>
        Math.abs(currentHeight - nextHeight) > 1 ? nextHeight : currentHeight,
      );
    } catch {
      // Ignore unrelated postMessage payloads from the isolated document.
    }
  };
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
        style={[styles.htmlBodyWebView, { backgroundColor: colors.background }]}
        thirdPartyCookiesEnabled={false}
      />
    </View>
  );
}

const defaultEmailBodyWidth = 390;
const minEmailBodyWebViewHeight = 80;
const maxEmailBodyWebViewHeight = 60000;

function getEmailBodyHeightScript(contentWidth: number) {
  return `
    (function () {
      var lastHeight = 0;
      var displayWidth = ${contentWidth};

      function getNaturalWidth() {
        var body = document.body;
        var doc = document.documentElement;

        return Math.max(
          displayWidth,
          body ? body.scrollWidth : 0,
          body ? body.offsetWidth : 0,
          doc ? doc.scrollWidth : 0,
          doc ? doc.offsetWidth : 0
        );
      }

      function getHeight() {
        var body = document.body;
        var doc = document.documentElement;

        return Math.max(
          body ? body.scrollHeight : 0,
          body ? body.offsetHeight : 0,
          doc ? doc.clientHeight : 0,
          doc ? doc.scrollHeight : 0,
          doc ? doc.offsetHeight : 0
        );
      }

      function getHost(value) {
        try {
          return new URL(value, document.baseURI).hostname;
        } catch (error) {
          return '';
        }
      }

      function getImageDebug(phase) {
        var images = Array.prototype.slice.call(document.images || []);

        return {
          phase: phase,
          imageCount: images.length,
          images: images.map(function (image) {
            return {
              complete: Boolean(image.complete),
              currentSrcHost: getHost(image.currentSrc || ''),
              naturalHeight: image.naturalHeight || 0,
              naturalWidth: image.naturalWidth || 0,
              srcHost: getHost(image.getAttribute('src') || image.src || ''),
              srcPrefix: (image.getAttribute('src') || image.src || '').slice(0, 160),
              status: image.getAttribute('data-nativemail-image-status') || 'snapshot'
            };
          })
        };
      }

      function postImageDebug(phase) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'image-debug',
          imageDebug: getImageDebug(phase)
        }));
      }

      function attachImageDebug() {
        var images = Array.prototype.slice.call(document.images || []);

        images.forEach(function (image) {
          if (image.__nativemailImageDebugAttached) {
            return;
          }

          image.__nativemailImageDebugAttached = true;
          image.addEventListener('load', function () {
            image.setAttribute('data-nativemail-image-status', 'load');
            postImageDebug('image-load');
            postHeight();
          });
          image.addEventListener('error', function () {
            image.setAttribute('data-nativemail-image-status', 'error');
            postImageDebug('image-error');
            postHeight();
          });
        });
      }

      function postHeight() {
        var naturalWidth = getNaturalWidth();
        var scale = naturalWidth > displayWidth ? displayWidth / naturalWidth : 1;
        var viewport = document.querySelector('meta[name="viewport"]');

        if (viewport && naturalWidth > displayWidth) {
          viewport.setAttribute(
            'content',
            'width=' + Math.ceil(naturalWidth) + ', initial-scale=' + scale + ', viewport-fit=cover'
          );
        }

        var height = getHeight() * scale;

        if (!height || Math.abs(height - lastHeight) <= 1) {
          return;
        }

        lastHeight = height;
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'height',
          height: height
        }));
      }

      attachImageDebug();
      postImageDebug('initial');
      postHeight();
      window.addEventListener('load', function () {
        attachImageDebug();
        postImageDebug('window-load');
        postHeight();
      });
      window.addEventListener('resize', postHeight);
      setTimeout(function () {
        attachImageDebug();
        postImageDebug('timer-50');
        postHeight();
      }, 50);
      setTimeout(function () {
        attachImageDebug();
        postImageDebug('timer-250');
        postHeight();
      }, 250);
      setTimeout(function () {
        attachImageDebug();
        postImageDebug('timer-1000');
        postHeight();
      }, 1000);

      if (window.ResizeObserver) {
        var resizeObserver = new ResizeObserver(postHeight);
        resizeObserver.observe(document.documentElement);

        if (document.body) {
          resizeObserver.observe(document.body);
        }
      }

      if (window.MutationObserver && document.body) {
        new MutationObserver(function () {
          attachImageDebug();
          postImageDebug('mutation');
          postHeight();
        }).observe(document.body, {
          attributes: true,
          childList: true,
          subtree: true
        });
      }
    })();
    true;
  `;
}

function getEmailHtmlDocument(html: string, colors: ColorSet, contentWidth: number) {
  const email = getEmailHtmlParts(html);

  return [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    `<meta name="nativemail-content-width" content="${contentWidth}">`,
    '<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; img-src data: cid: blob: http: https:; style-src &#39;unsafe-inline&#39;; font-src data:; media-src none; object-src none; frame-src none; connect-src none; script-src &#39;none&#39;; base-uri &#39;none&#39;; form-action &#39;none&#39;">',
    '<style>',
    getEmailHtmlStyles(colors, email.hasBodyMarginAttributes),
    '</style>',
    email.head,
    '</head>',
    `<body${email.bodyAttributes}>`,
    email.body,
    '</body>',
    '</html>',
  ].join('');
}

function getEmailHtmlStyles(colors: ColorSet, hasBodyMarginAttributes: boolean) {
  return `
    html {
      background: ${colors.background};
      -webkit-text-size-adjust: 100%;
    }
    body {
      background: ${colors.background};
      color: ${colors.text};
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 16px;
      line-height: 1.44;
      ${hasBodyMarginAttributes ? '' : `margin: 8px ${messageDetailHorizontalPadding}px;`}
      overflow-x: hidden;
      word-break: normal;
      overflow-wrap: anywhere;
      -webkit-text-size-adjust: 100%;
    }
    blockquote {
      border-left: 3px solid ${colors.groupDivider};
      color: ${colors.secondaryText};
      margin-left: 0;
      padding-left: 12px;
    }
    img {
      max-width: 100% !important;
      height: auto !important;
    }
    pre, code {
      white-space: pre-wrap;
    }
  `;
}

function getEmailHtmlParts(html: string) {
  const sanitized = sanitizeEmailHtml(html);
  const headMatch = sanitized.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
  const bodyMatch = sanitized.match(/<body\b([^>]*)>([\s\S]*?)<\/body>/i);
  const head = headMatch?.[1] ?? '';

  if (bodyMatch) {
    const bodyAttributes = bodyMatch[1] ?? '';

    return {
      body: bodyMatch[2],
      bodyAttributes: sanitizeEmailBodyAttributes(bodyAttributes),
      hasBodyMarginAttributes: hasEmailBodyMarginAttributes(bodyAttributes),
      head,
    };
  }

  return {
    body: sanitized
      .replace(/<!doctype\b[^>]*>/gi, '')
      .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')
      .replace(/<\/?html\b[^>]*>/gi, ''),
    bodyAttributes: '',
    hasBodyMarginAttributes: false,
    head,
  };
}

function hasEmailBodyMarginAttributes(attributes: string) {
  return /\s(?:leftmargin|rightmargin|topmargin|bottommargin|marginwidth|marginheight)\s*=/i.test(attributes);
}

function sanitizeEmailBodyAttributes(attributes: string) {
  const normalized = attributes
    .replace(/[<>]/g, '')
    .replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*[^\s>]+/gi, '')
    .trim();

  return normalized ? ` ${normalized}` : '';
}

function sanitizeEmailHtml(html: string) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, '')
    .replace(/<embed\b[^>]*>/gi, '')
    .replace(/<form\b[^>]*>[\s\S]*?<\/form>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*[^\s>]+/gi, '')
    .replace(/\s+(href|src)\s*=\s*"javascript:[^"]*"/gi, ' $1="#"')
    .replace(/\s+(href|src)\s*=\s*'javascript:[^']*'/gi, " $1='#'")
    .replace(/\s+(href|src)\s*=\s*javascript:[^\s>]+/gi, ' $1="#"');
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
