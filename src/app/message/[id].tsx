import { ProfileAvatar } from '@/components/profile-avatar';
import {
  AttachmentThumbnailView,
  canUseNativeAttachmentThumbnail,
  openNativeAttachmentPreviewAsync,
} from '@/components/attachment-thumbnail-view';
import { saveComposeDraft } from '@/lib/compose-drafts';
import {
  archiveJmapEmail,
  fetchJmapThreadMessages,
  setJmapEmailPinned,
  setJmapEmailUnread,
  trashJmapEmail,
  type JmapMessageBodyDebug,
  type JmapMessageActionResult,
} from '@/lib/jmap-client';
import { removeCachedEmailFromMailbox, updateCachedEmail } from '@/lib/mail-cache';
import { useDebugMode } from '@/lib/debug-mode';
import {
  clampEmailBodyHeight,
  defaultEmailBodyWidth,
  getEmailBodyHeightScript,
  getEmailHtmlDocument,
  minEmailBodyWebViewHeight,
} from '@/lib/email-html-rendering';
import { splitEmailForwardHtml, splitEmailReplyHtml, splitEmailReplyText } from '@/lib/email-reply-history';
import {
  adjustInboxUnreadBadgeCount,
  dismissInboxNotificationForMessage,
  recordInboxNotificationLocalAction,
} from '@/lib/inbox-notifications';
import {
  getContactAvatarUrisForEmails,
  normalizeContactEmail,
} from '@/lib/contact-cache';
import {
  hydrateMessageBodyFromCache,
  loadMessageBody,
  recordLocalMailAction,
  selectMailboxSnapshot,
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
const messageBodyFetchRevision = 10;
const optimisticMailboxHideTtlMs = 30000;
const threadScrollOffset = 12;
const systemFont = Platform.select({ ios: 'system-ui', default: undefined });
const roundedFont = Platform.select({ ios: 'ui-rounded', default: undefined });
const pressHaptic = () => {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
};
type MessageAction = 'archive' | 'reply' | 'reply-all' | 'toggle-pin' | 'toggle-unread' | 'trash';
type MessageStatusPatch = Pick<Partial<Message>, 'keywords' | 'pinned' | 'unread'>;
const copyEmailHtmlAction = 'copy-email-html';
const dumpEmailCacheAction = 'dump-email-cache';
const maxReadDebugEvents = 24;

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function getBodyLoadDebugSummary(
  body:
    | {
        attachments?: MessageAttachment[];
        debug?: Pick<JmapMessageBodyDebug, 'cidImageInlineMode'>;
        html?: string | null;
        text?: string | null;
      }
    | null
    | undefined,
) {
  if (!body) {
    return 'html=0 text=0 attachments=0';
  }

  return [
    `html=${body.html?.trim() ? body.html.length : 0}`,
    `text=${body.text?.trim() ? body.text.length : 0}`,
    `attachments=${body.attachments?.length ?? 0}`,
    `cidInline=${body.debug?.cidImageInlineMode ?? 'none'}`,
  ].join(' ');
}

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
  accentTextCount: number;
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
    avatarUrl?: string;
    count?: string;
    date?: string;
    fromEmail?: string;
    hasAttachment?: string;
    id: string;
    mailboxId?: string;
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
    toAddresses?: string;
    ccAddresses?: string;
    bccAddresses?: string;
    unread?: string;
    wasUnreadOnOpen?: string;
  }>();
  const { id, mailboxName, source } = params;
  const insets = useSafeAreaInsets();
  const scheme = useColorScheme();
  const debugMode = useDebugMode();
  const colors = scheme === 'dark' ? darkColors : lightColors;
  const messageId = Array.isArray(id) ? id[0] : id;
  const fallbackMessage = getMessageById(messageId);
  const routeMessage = getRouteMessage(params, fallbackMessage);
  const wasUnreadOnOpen = getRouteParam(params.wasUnreadOnOpen) === '1';
  const routeThreadId = routeMessage.threadId;
  const routeMailboxId = getRouteParam(params.mailboxId) || null;
  const messageBodies = useMailStore((state) => state.messageBodies);
  const cachedThread = useMailStore((state) => selectThread(state, routeThreadId));
  const storeMessageBody = messageBodies[messageId] ?? null;
  const applyMailboxSnapshot = useMailStore((state) => state.applyMailboxSnapshot);
  const applyMessageBody = useMailStore((state) => state.applyMessageBody);
  const clearHiddenMessageInMailbox = useMailStore((state) => state.clearHiddenMessageInMailbox);
  const hideMessageInMailbox = useMailStore((state) => state.hideMessageInMailbox);
  const patchStoreMessage = useMailStore((state) => state.patchMessage);
  const removeStoreMessageFromMailbox = useMailStore((state) => state.removeMessageFromMailbox);
  const [localFlags, setLocalFlags] = useState({
    pinned: routeMessage.pinned,
    unread: routeMessage.unread,
  });
  const [pendingAction, setPendingAction] = useState<MessageAction | null>(null);
  const [readDebugEvents, setReadDebugEvents] = useState<string[]>([]);
  const [contactAvatarUriByEmail, setContactAvatarUriByEmail] = useState<Record<string, string>>({});
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
  const focusedBodyAvailable =
    source !== 'jmap' || Boolean(jmapBody?.html?.trim() || jmapBody?.text?.trim());
  const cachedThreadMessages = cachedThread?.messages ?? null;
  const cachedThreadMessageKey = useMemo(
    () => cachedThreadMessages?.map((threadMessage) => threadMessage.id).join('\n') ?? '',
    [cachedThreadMessages],
  );
  const detailMessages = useMemo(
    () => mergeThreadMessagesWithBodies(threadMessages ?? cachedThreadMessages ?? [routeMessage], messageBodies, message),
    [cachedThreadMessages, message, messageBodies, routeMessage, threadMessages],
  );
  const actionTargetMessage = detailMessages.find((detailMessage) => detailMessage.id === focusedThreadMessageId) ?? message;
  const expandedUnreadMessages = useMemo(
    () => detailMessages.filter((detailMessage) =>
      expandedThreadMessageIds.has(detailMessage.id) && detailMessage.unread
    ),
    [detailMessages, expandedThreadMessageIds],
  );
  const expandedUnreadMessageKey = useMemo(
    () => expandedUnreadMessages.map((detailMessage) => detailMessage.id).join('\n'),
    [expandedUnreadMessages],
  );
  const expandedThreadMessageKey = useMemo(
    () => Array.from(expandedThreadMessageIds).sort().join('\n'),
    [expandedThreadMessageIds],
  );
  const contactEmailKey = useMemo(
    () => getContactEmailKey(detailMessages),
    [detailMessages],
  );
  const appendReadDebugEvent = useCallback((event: string) => {
    setReadDebugEvents((currentEvents) =>
      [
        ...currentEvents,
        `${new Date().toISOString()} ${event}`,
      ].slice(-maxReadDebugEvents),
    );
  }, []);
  const threadReadDebugText = useMemo(
    () =>
      getThreadReadDebugText({
        actionTargetMessage,
        detailMessages,
        expandedMessageIds: expandedThreadMessageIds,
        focusedMessageId: focusedThreadMessageId,
        readDebugEvents,
        routeMessage,
        source,
        wasUnreadOnOpen,
      }),
    [
      actionTargetMessage,
      detailMessages,
      expandedThreadMessageIds,
      focusedThreadMessageId,
      readDebugEvents,
      routeMessage,
      source,
      wasUnreadOnOpen,
    ],
  );
  const patchVisibleMessage = useCallback(
    (targetMessageId: string, patch: MessageStatusPatch) => {
      setThreadMessages((currentMessages) =>
        currentMessages
          ? currentMessages.map((threadMessage) =>
              threadMessage.id === targetMessageId ? applyMessageStatusPatch(threadMessage, patch) : threadMessage,
            )
          : currentMessages,
      );
      patchStoreMessage(targetMessageId, patch);

      if (targetMessageId === messageId) {
        setLocalFlags((currentFlags) => ({
          pinned: patch.pinned ?? currentFlags.pinned,
          unread: patch.unread ?? currentFlags.unread,
        }));
      }
    },
    [messageId, patchStoreMessage],
  );
  const dismissReadNotification = useCallback(
    (targetMessageId: string) => {
      dismissInboxNotificationForMessage(targetMessageId)
        .then((result) => {
          appendReadDebugEvent(
            [
              `notification-dismiss id=${targetMessageId}`,
              `presented=${result.presented}`,
              `matched=${result.matched}`,
              `dismissed=${result.dismissed}`,
              `identifiers=${result.matchedIdentifiers.length ? result.matchedIdentifiers.join(',') : 'none'}`,
              `presentedMessageIds=${result.presentedMessageIds.length ? result.presentedMessageIds.join(',') : 'none'}`,
            ].join(' '),
          );
        })
        .catch((error: unknown) => {
          appendReadDebugEvent(
            `notification-dismiss failed id=${targetMessageId} error=${error instanceof Error ? error.message : String(error)}`,
          );
        });
    },
    [appendReadDebugEvent],
  );
  const markVisibleMessageRead = useCallback(
    (targetMessage: Message) => {
      if (source !== 'jmap' || !targetMessage.id || !targetMessage.unread) {
        return;
      }

      const nextKeywords = updateMessageKeyword(targetMessage.keywords, '$seen', true);
      const optimisticPatch = {
        keywords: nextKeywords,
        unread: false,
      };

      appendReadDebugEvent(
        `mark-read start id=${targetMessage.id} thread=${targetMessage.threadId ?? 'none'} unread=${targetMessage.unread ? '1' : '0'} seen=${targetMessage.keywords?.$seen === true ? '1' : '0'}`,
      );
      recordOptimisticMailAction(targetMessage.id);
      patchVisibleMessage(targetMessage.id, optimisticPatch);
      dismissReadNotification(targetMessage.id);
      if (isInboxMailboxName(mailboxName)) {
        void adjustInboxUnreadBadgeCount(-1).catch(() => {});
      }
      void updateCachedEmail(targetMessage.id, optimisticPatch).catch(() => {});

      appendReadDebugEvent(`mark-read sync deferred id=${targetMessage.id}`);
      setTimeout(() => {
        const markReadTask = InteractionManager.runAfterInteractions(() => {
          setJmapEmailUnread(targetMessage.id, false)
            .then((result) => {
              appendReadDebugEvent(
                `mark-read success id=${targetMessage.id} unread=${result.unread === true ? '1' : '0'} seen=${result.keywords?.$seen === true ? '1' : '0'}`,
              );
            })
            .catch((error: unknown) => {
              const rollbackPatch = {
                keywords: targetMessage.keywords,
                pinned: targetMessage.pinned,
                unread: targetMessage.unread,
              };

              patchVisibleMessage(targetMessage.id, rollbackPatch);
              if (isInboxMailboxName(mailboxName)) {
                void adjustInboxUnreadBadgeCount(1).catch(() => {});
              }
              void updateCachedEmail(targetMessage.id, rollbackPatch).catch(() => {});
              appendReadDebugEvent(
                `mark-read failed id=${targetMessage.id} error=${error instanceof Error ? error.message : String(error)}`,
              );
            });
        });

        setTimeout(() => markReadTask.cancel(), 10000);
      }, 500);
    },
    [appendReadDebugEvent, dismissReadNotification, mailboxName, patchVisibleMessage, source],
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
    setReadDebugEvents([]);
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

    if (!focusedBodyAvailable) {
      appendReadDebugEvent(`thread fetch deferred until body id=${messageId}`);
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

        appendReadDebugEvent(
          `thread fetch ids=${nextMessages.map((threadMessage) => `${threadMessage.id}:${threadMessage.unread ? 'unread' : 'read'}`).join(',')} focus=${focusId}`,
        );
        setThreadMessages(nextMessages);
        setFocusedThreadMessageId(focusId);
        setExpandedThreadMessageIds(expandedIds);
      })
      .catch((error: unknown) => {
        appendReadDebugEvent(
          `thread fetch failed error=${error instanceof Error ? error.message : String(error)}`,
        );
      });

    return () => {
      controller.abort();
    };
  }, [appendReadDebugEvent, cachedThreadMessageKey, cachedThreadMessages, focusedBodyAvailable, messageId, routeMessage.threadId, source, wasUnreadOnOpen]);

  useEffect(() => {
    if (!contactEmailKey) {
      return;
    }

    const controller = new AbortController();
    const emails = contactEmailKey.split('\n').filter(Boolean);

    const contactLookupTask = InteractionManager.runAfterInteractions(() => {
      void getContactAvatarUrisForEmails(emails, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) {
            return;
          }

          setContactAvatarUriByEmail((current) => ({
            ...current,
            ...result.avatarUriByEmail,
          }));
        })
        .catch(() => {});
    });

    return () => {
      controller.abort();
      contactLookupTask.cancel();
    };
  }, [contactEmailKey]);

  useEffect(() => {
    const shouldLoadJmap = source === 'jmap';

    if (!messageId || !shouldLoadJmap) {
      return;
    }

    const startedAt = Date.now();

    appendReadDebugEvent(`body cache start id=${messageId}`);
    void hydrateMessageBodyFromCache(messageId)
      .then((body) => {
        appendReadDebugEvent(
          `body cache ${body ? 'hit' : 'miss'} id=${messageId} +${Date.now() - startedAt}ms ${getBodyLoadDebugSummary(body)}`,
        );
      })
      .catch((error: unknown) => {
        appendReadDebugEvent(
          `body cache failed id=${messageId} +${Date.now() - startedAt}ms error=${error instanceof Error ? error.message : String(error)}`,
        );
      });

    appendReadDebugEvent(`body fetch start id=${messageId}`);
    void loadMessageBody(messageId, { refresh: true })
      .then((body) => {
        appendReadDebugEvent(
          `body fetch ${body ? 'finished' : 'empty'} id=${messageId} +${Date.now() - startedAt}ms ${getBodyLoadDebugSummary(body)}`,
        );

        if (body) {
          applyMessageBody(messageId, body);
        }
      })
      .catch((error: unknown) => {
        appendReadDebugEvent(
          `body fetch failed id=${messageId} +${Date.now() - startedAt}ms error=${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }, [appendReadDebugEvent, applyMessageBody, messageId, source, messageBodyFetchRevision]);
  useEffect(() => {
    if (source !== 'jmap') {
      return;
    }

    const messageIds = Array.from(expandedThreadMessageIds).filter(
      (threadMessageId) => threadMessageId !== messageId,
    );

    for (const threadMessageId of messageIds) {
      void hydrateMessageBodyFromCache(threadMessageId).catch(() => {});
      void loadMessageBody(threadMessageId, { priority: 'background', refresh: true }).catch(() => {});
    }
  }, [expandedThreadMessageKey, expandedThreadMessageIds, messageId, source]);
  useEffect(() => {
    for (const unreadMessage of expandedUnreadMessages) {
      markVisibleMessageRead(unreadMessage);
    }
  }, [expandedUnreadMessageKey, expandedUnreadMessages, markVisibleMessageRead]);
  const runMessageAction = (action: MessageAction, targetMessageId?: string) => {
    const targetMessage = getActionTargetMessage({
      action,
      actionTargetMessage,
      detailMessages,
      targetMessageId,
    });

    pressHaptic();

    if (action === 'reply') {
      openReplyCompose(targetMessage);
      return;
    }

    if (action === 'reply-all') {
      return;
    }

    if (pendingAction || !messageId) {
      return;
    }

    const previousPatch = {
      keywords: targetMessage.keywords,
      pinned: targetMessage.pinned,
      unread: targetMessage.unread,
    };

    if (source !== 'jmap') {
      if (action === 'toggle-pin') {
        patchVisibleMessage(targetMessage.id, { pinned: !targetMessage.pinned });
      } else if (action === 'toggle-unread') {
        patchVisibleMessage(targetMessage.id, { unread: !targetMessage.unread });
      }

      return;
    }

    setPendingAction(action);

    if (isOptimisticMailboxExitAction(action)) {
      const actionMailboxId = getActionMailboxId(targetMessage, routeMailboxId, mailboxName);
      const previousSnapshot = selectMailboxSnapshot(useMailStore.getState(), actionMailboxId);

      recordOptimisticMailAction(targetMessage.id);
      hideMessageInMailbox(targetMessage.id, actionMailboxId);
      dismissReadNotification(targetMessage.id);
      if (targetMessage.unread && isInboxMailboxName(mailboxName)) {
        void adjustInboxUnreadBadgeCount(-1).catch(() => {});
      }
      router.back();

      getMessageActionRequest(action, targetMessage.id, targetMessage)
        .then(() => {
          removeStoreMessageFromMailbox(targetMessage.id, actionMailboxId);
          if (actionMailboxId) {
            void removeCachedEmailFromMailbox(targetMessage.id, actionMailboxId).catch(() => {});
          }
          setTimeout(() => {
            clearHiddenMessageInMailbox(targetMessage.id, actionMailboxId);
          }, optimisticMailboxHideTtlMs);
        })
        .catch(() => {
          clearHiddenMessageInMailbox(targetMessage.id, actionMailboxId);
          if (previousSnapshot) {
            applyMailboxSnapshot(previousSnapshot, actionMailboxId);
          }
          if (targetMessage.unread && isInboxMailboxName(mailboxName)) {
            void adjustInboxUnreadBadgeCount(1).catch(() => {});
          }
        });
      return;
    }

    if (action === 'toggle-pin') {
      const nextPinned = !targetMessage.pinned;
      const optimisticPatch = {
        keywords: updateMessageKeyword(targetMessage.keywords, '$flagged', nextPinned),
        pinned: nextPinned,
      };

      recordOptimisticMailAction(targetMessage.id);
      patchVisibleMessage(targetMessage.id, optimisticPatch);
      void updateCachedEmail(targetMessage.id, optimisticPatch).catch(() => {});
    }

    if (action === 'toggle-unread') {
      const nextUnread = !targetMessage.unread;
      const optimisticPatch = {
        keywords: updateMessageKeyword(targetMessage.keywords, '$seen', !nextUnread),
        unread: nextUnread,
      };

      recordOptimisticMailAction(targetMessage.id);
      patchVisibleMessage(targetMessage.id, optimisticPatch);
      void updateCachedEmail(targetMessage.id, optimisticPatch).catch(() => {});
      if (isInboxMailboxName(mailboxName)) {
        void adjustInboxUnreadBadgeCount(nextUnread ? 1 : -1).catch(() => {});
      }
      if (!nextUnread) {
        dismissReadNotification(targetMessage.id);
      }
    }

    const request = getMessageActionRequest(action, targetMessage.id, targetMessage);

    request
      .catch((error: unknown) => {
        patchVisibleMessage(targetMessage.id, previousPatch);
        if (action === 'toggle-unread' && isInboxMailboxName(mailboxName)) {
          void adjustInboxUnreadBadgeCount(targetMessage.unread ? 1 : -1).catch(() => {});
        }
        void updateCachedEmail(targetMessage.id, previousPatch).catch(() => {});
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
          icon={actionTargetMessage.unread ? 'envelope.open' : 'envelope.badge'}
          onPress={() => runMessageAction('toggle-unread')}
        />
        <Stack.Toolbar.Button
          disabled={actionDisabled}
          icon={actionTargetMessage.pinned ? 'pin.fill' : 'pin'}
          onPress={() => runMessageAction('toggle-pin')}
          tintColor={actionTargetMessage.pinned ? colors.pin : undefined}
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
          contactAvatarUriByEmail={contactAvatarUriByEmail}
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
          readDebugEvents={readDebugEvents}
          threadDebugText={debugMode ? threadReadDebugText : null}
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
    avatarUrl: getRouteParam(params.avatarUrl) || fallbackMessage.avatarUrl,
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
    toAddresses: getRouteStringArray(params.toAddresses) ?? fallbackMessage.toAddresses,
    ccAddresses: getRouteStringArray(params.ccAddresses) ?? fallbackMessage.ccAddresses,
    bccAddresses: getRouteStringArray(params.bccAddresses) ?? fallbackMessage.bccAddresses,
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

function getRouteStringArray(value: string | string[] | undefined) {
  const text = getRouteParam(value);

  if (!text) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(text);

    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : undefined;
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

function applyMessageStatusPatch(message: Message, patch: MessageStatusPatch): Message {
  return {
    ...message,
    ...(patch.keywords === undefined ? {} : { keywords: patch.keywords }),
    ...(patch.pinned === undefined ? {} : { pinned: patch.pinned }),
    ...(patch.unread === undefined ? {} : { unread: patch.unread }),
  };
}

function getThreadReadDebugText({
  actionTargetMessage,
  detailMessages,
  expandedMessageIds,
  focusedMessageId,
  readDebugEvents,
  routeMessage,
  source,
  wasUnreadOnOpen,
}: {
  actionTargetMessage: Message;
  detailMessages: Message[];
  expandedMessageIds: Set<string>;
  focusedMessageId: string;
  readDebugEvents: string[];
  routeMessage: Message;
  source?: string | string[];
  wasUnreadOnOpen: boolean;
}) {
  const expandedIds = Array.from(expandedMessageIds);
  const unreadIds = detailMessages
    .filter((message) => message.unread)
    .map((message) => message.id);
  const sourceText = Array.isArray(source) ? source[0] : source;

  return [
    `source: ${sourceText ?? 'unknown'}`,
    `route id: ${routeMessage.id}`,
    `route thread: ${routeMessage.threadId ?? 'none'}`,
    `route unread: ${routeMessage.unread ? 'yes' : 'no'}`,
    `route $seen: ${routeMessage.keywords?.$seen === true ? 'yes' : 'no'}`,
    `wasUnreadOnOpen: ${wasUnreadOnOpen ? 'yes' : 'no'}`,
    `focused id: ${focusedMessageId}`,
    `action target id: ${actionTargetMessage.id}`,
    `expanded ids: ${expandedIds.length ? expandedIds.join(', ') : 'none'}`,
    `unread ids: ${unreadIds.length ? unreadIds.join(', ') : 'none'}`,
    `messages: ${detailMessages.length}`,
    ...detailMessages.map((message, index) => formatThreadMessageDebugLine(message, index)),
    'events:',
    readDebugEvents.length ? readDebugEvents.join('\n') : 'none',
  ].join('\n');
}

function getMessageCacheDumpText({
  bodyDebug,
  message,
  readDebugEvents,
}: {
  bodyDebug?: JmapMessageBodyDebug;
  message: Message;
  readDebugEvents: string[];
}) {
  const html = message.htmlBody ?? '';
  const text = message.body ?? '';
  const attachments = message.attachments ?? [];

  return [
    `cache dump: ${new Date().toISOString()}`,
    `id: ${message.id}`,
    `thread: ${message.threadId ?? 'none'}`,
    `unread: ${message.unread ? '1' : '0'}`,
    `$seen: ${message.keywords?.$seen === true ? '1' : '0'}`,
    `keywords: ${formatDebugRecordKeys(message.keywords)}`,
    `mailboxes: ${formatDebugRecordKeys(message.mailboxIds)}`,
    `from: ${message.fromEmail || 'none'}`,
    `subject: ${JSON.stringify(message.subject)}`,
    `sender: ${JSON.stringify(message.sender)}`,
    `html length: ${html.trim() ? html.length : 0}`,
    `text length: ${text.trim() ? text.length : 0}`,
    `attachments: ${attachments.length}`,
    `body debug: ${bodyDebug ? 'available' : 'none'}`,
    bodyDebug ? getBodyDebugDumpText(bodyDebug) : null,
    'events:',
    readDebugEvents.length ? readDebugEvents.join('\n') : 'none',
  ]
    .filter(isPresent)
    .join('\n');
}

function getBodyDebugDumpText(debug: JmapMessageBodyDebug) {
  return [
    `cid inline mode: ${debug.cidImageInlineMode ?? 'unknown'}`,
    `cid refs: ${debug.cidReferenceCount}`,
    `cid image parts: ${debug.cidImagePartCount}`,
    `embedded image urls: ${debug.generatedDownloadUrlCount}`,
    `replaced refs: ${debug.replacedCidReferenceCount}`,
    `unresolved refs: ${debug.unresolvedCidReferences.length ? debug.unresolvedCidReferences.join(',') : 'none'}`,
    `cid left after rewrite: ${debug.htmlContainsCidAfterRewrite ? '1' : '0'}`,
    `body parts: ${debug.bodyStructurePartCount}`,
    `html body parts: ${debug.htmlBodyPartCount}`,
    `attachment parts: ${debug.attachmentPartCount}`,
    `inline image errors: ${debug.downloadUrlErrorCount}`,
  ].join('\n');
}

function formatThreadMessageDebugLine(message: Message, index: number) {
  return [
    `${index + 1}. id=${message.id}`,
    `thread=${message.threadId ?? 'none'}`,
    `unread=${message.unread ? '1' : '0'}`,
    `$seen=${message.keywords?.$seen === true ? '1' : '0'}`,
    `keywords=${formatDebugRecordKeys(message.keywords)}`,
    `pinned=${message.pinned ? '1' : '0'}`,
    `date=${message.date || 'none'}`,
    `from=${message.fromEmail || 'none'}`,
    `mailboxes=${formatDebugRecordKeys(message.mailboxIds)}`,
    `subject=${JSON.stringify(message.subject)}`,
    `sender=${JSON.stringify(message.sender)}`,
  ].join(' ');
}

function formatDebugRecordKeys(record: Record<string, true> | undefined) {
  const keys = Object.keys(record ?? {});

  return keys.length ? keys.join(',') : 'none';
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
        {
          id: dumpEmailCacheAction,
          title: 'Dump Cache',
          image: 'internaldrive',
        },
      ],
    });
  }

  return actions;
}

function recordOptimisticMailAction(messageId: string) {
  recordLocalMailAction();
  void recordInboxNotificationLocalAction(messageId).catch(() => {});
}

function getActionTargetMessage({
  action,
  actionTargetMessage,
  detailMessages,
  targetMessageId,
}: {
  action: MessageAction;
  actionTargetMessage: Message;
  detailMessages: Message[];
  targetMessageId?: string;
}) {
  if (targetMessageId) {
    return (
      detailMessages.find((detailMessage) => detailMessage.id === targetMessageId) ??
      actionTargetMessage
    );
  }

  if (action === 'reply') {
    return detailMessages[detailMessages.length - 1] ?? actionTargetMessage;
  }

  return actionTargetMessage;
}

function openReplyCompose(message: Message) {
  const draftId = saveComposeDraft({
    body: getReplyPlainTextBody(message),
    htmlBody: getReplyHtmlBody(message),
    mode: 'reply',
    replyToMessageId: message.id,
    subject: getReplySubject(message.subject),
    to: getReplyToAddress(message),
    threadId: message.threadId,
  });

  router.push({ pathname: '/compose', params: { draftId } });
}

function getReplySubject(subject: string) {
  const trimmedSubject = subject.trim();

  if (!trimmedSubject) {
    return '';
  }

  return /^re:/i.test(trimmedSubject) ? trimmedSubject : `Re: ${trimmedSubject}`;
}

function getReplyToAddress(message: Message) {
  const sender = message.sender.trim();
  const fromEmail = message.fromEmail?.trim();

  if (sender && fromEmail && !sender.includes(fromEmail)) {
    return `${sender} <${fromEmail}>`;
  }

  return fromEmail || sender;
}

function getReplyPlainTextBody(message: Message) {
  const quoteText = getReplyQuoteText(message);

  if (!quoteText) {
    return '\nEliot';
  }

  return [
    '',
    'Eliot',
    '',
    getReplyIntroLine(message),
    quoteText
      .split(/\r?\n/)
      .map((line) => (line.trim() ? `> ${line}` : '>'))
      .join('\n'),
  ].join('\n');
}

function getReplyHtmlBody(message: Message) {
  const quoteHtml = getReplyQuoteHtml(message);
  const quoteText = getReplyQuoteText(message);

  if (!quoteHtml && !quoteText) {
    return '<div><br></div><div>Eliot</div>';
  }

  return [
    '<div><br></div>',
    '<div>Eliot</div>',
    '<br>',
    '<blockquote type="cite" style="border-left: 2px solid #C7C7CC; margin: 0 0 0 0.8em; padding-left: 0.8em;">',
    `<div>${escapeHtml(getReplyIntroLine(message))}</div>`,
    `<div>${quoteHtml ?? getReplyQuoteTextHtml(quoteText)}</div>`,
    '</blockquote>',
  ].join('');
}

function getReplyQuoteHtml(message: Message) {
  const html = message.htmlBody?.trim() || (looksLikeHtml(message.body ?? '') ? message.body?.trim() : '');

  if (!html) {
    return null;
  }

  const fragment = getReplyQuoteHtmlFragment(html);

  return fragment ? sanitizeReplyQuoteHtml(fragment) : null;
}

function getReplyQuoteTextHtml(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => (line.trim() ? escapeHtml(line) : '<br>'))
    .join('<br>');
}

function getReplyQuoteText(message: Message) {
  const body = message.body?.trim() ?? '';
  const text = body && !looksLikeHtml(body)
    ? body
    : getTextFromHtml(message.htmlBody || body).trim() || message.preview.trim();

  return normalizeReplyQuoteText(text);
}

function looksLikeHtml(text: string) {
  return /<\/?[a-z][\s\S]*>/i.test(text);
}

function getReplyQuoteHtmlFragment(html: string) {
  const sanitized = sanitizeReplyQuoteHtml(html);
  const bodyMatches = Array.from(sanitized.matchAll(/<body\b[^>]*>([\s\S]*?)<\/body>/gi));

  if (bodyMatches.length) {
    return bodyMatches.map((match) => match[1] ?? '').join('\n').trim();
  }

  return sanitized
    .replace(/<!doctype\b[^>]*>/gi, '')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<\/?html\b[^>]*>/gi, '')
    .trim();
}

function sanitizeReplyQuoteHtml(html: string) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, '')
    .replace(/<embed\b[^>]*>/gi, '')
    .replace(/<form\b[^>]*>[\s\S]*?<\/form>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/\s+contenteditable\s*=\s*"[^"]*"/gi, '')
    .replace(/\s+contenteditable\s*=\s*'[^']*'/gi, '')
    .replace(/\s+contenteditable\s*=\s*[^\s>]+/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*[^\s>]+/gi, '')
    .replace(/\s+(href|src)\s*=\s*"javascript:[^"]*"/gi, ' $1="#"')
    .replace(/\s+(href|src)\s*=\s*'javascript:[^']*'/gi, " $1='#'")
    .replace(/\s+(href|src)\s*=\s*javascript:[^\s>]+/gi, ' $1="#"');
}

function getReplyIntroLine(message: Message) {
  return `On ${message.date}, ${message.sender} wrote:`;
}

function normalizeReplyQuoteText(text: string) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function getTextFromHtml(html?: string) {
  if (!html) {
    return '';
  }

  return decodeBasicHtmlEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[\s\S]*?<\/style>/gi, '')
      .replace(/<(br|\/p|\/div|\/li|\/tr)\b[^>]*>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '\n- ')
      .replace(/<[^>]+>/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
  );
}

function decodeBasicHtmlEntities(text: string) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

function escapeHtml(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isMessageAction(action: string): action is MessageAction {
  return ['archive', 'reply', 'reply-all', 'toggle-pin', 'toggle-unread', 'trash'].includes(action);
}

function isOptimisticMailboxExitAction(action: MessageAction): action is 'archive' | 'trash' {
  return action === 'archive' || action === 'trash';
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

function getActionMailboxId(
  message: Message,
  routeMailboxId?: string | null,
  routeMailboxName?: string | null,
) {
  if (routeMailboxId) {
    return routeMailboxId;
  }

  const snapshots = Object.values(useMailStore.getState().snapshots);
  const normalizedRouteMailboxName = routeMailboxName ? normalizeMailboxName(routeMailboxName) : null;
  const snapshotForRouteName = snapshots.find((snapshot) =>
    snapshot.mailbox?.id &&
    snapshot.messages.some((snapshotMessage) => snapshotMessage.id === message.id) &&
    (!normalizedRouteMailboxName || normalizeMailboxName(snapshot.mailbox.name) === normalizedRouteMailboxName)
  );

  if (snapshotForRouteName?.mailbox?.id) {
    return snapshotForRouteName.mailbox.id;
  }

  const snapshotForMessageMailbox = snapshots.find((snapshot) =>
    snapshot.mailbox?.id &&
    message.mailboxIds?.[snapshot.mailbox.id] === true &&
    snapshot.messages.some((snapshotMessage) => snapshotMessage.id === message.id)
  );

  if (snapshotForMessageMailbox?.mailbox?.id) {
    return snapshotForMessageMailbox.mailbox.id;
  }

  const mailboxIds = Object.keys(message.mailboxIds ?? {});

  return mailboxIds.length === 1 ? mailboxIds[0] : null;
}

function normalizeMailboxName(name: string) {
  return name.trim().toLowerCase();
}

function isInboxMailboxName(name?: string | null) {
  return normalizeMailboxName(name ?? '') === 'inbox';
}

function getContactEmailKey(messages: Message[]) {
  return Array.from(
    new Set(messages.map((message) => normalizeContactEmail(message.fromEmail)).filter(isPresent)),
  ).join('\n');
}

function getContactAvatarUriForMessage(
  message: Message,
  contactAvatarUriByEmail: Record<string, string>,
) {
  const email = normalizeContactEmail(message.fromEmail);

  return email ? contactAvatarUriByEmail[email] : undefined;
}

function MessageDetail({
  bodyDebug,
  colors,
  contactAvatarUriByEmail,
  expandedMessageIds,
  focusedMessageId,
  insetsTop,
  mailboxName,
  message,
  messages,
  onAction,
  onExpandAll,
  onToggleMessage,
  readDebugEvents,
  threadDebugText,
}: {
  bodyDebug?: JmapMessageBodyDebug;
  colors: ColorSet;
  contactAvatarUriByEmail: Record<string, string>;
  expandedMessageIds: Set<string>;
  focusedMessageId: string;
  insetsTop: number;
  mailboxName?: string;
  message: Message;
  messages: Message[];
  onAction: (action: MessageAction, messageId?: string) => void;
  onExpandAll: () => void;
  onToggleMessage: (messageId: string) => void;
  readDebugEvents: string[];
  threadDebugText: string | null;
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
              contactAvatarUriByEmail={contactAvatarUriByEmail}
              expanded={expanded}
              focused={threadMessage.id === focusedMessageId}
              isLast={index === messages.length - 1}
              key={threadMessage.id}
              message={threadMessage}
              onAction={onAction}
              onLayout={handleThreadItemLayout}
              onToggle={() => onToggleMessage(threadMessage.id)}
              readDebugEvents={readDebugEvents}
              showMenu={expanded}
            />
          );
        })}
      </View>
      {threadDebugText ? (
        <EmailDebugReport
          colors={colors}
          label="Thread Read Debug"
          text={threadDebugText}
        />
      ) : null}
    </ScrollView>
  );
}

function MessageThreadItem({
  bodyDebug,
  canToggle,
  colors,
  contactAvatarUriByEmail,
  expanded,
  focused,
  isLast,
  message,
  onAction,
  onLayout,
  onToggle,
  readDebugEvents,
  showMenu,
}: {
  bodyDebug?: JmapMessageBodyDebug;
  canToggle: boolean;
  colors: ColorSet;
  contactAvatarUriByEmail: Record<string, string>;
  expanded: boolean;
  focused: boolean;
  isLast: boolean;
  message: Message;
  onAction: (action: MessageAction, messageId?: string) => void;
  onLayout: (messageId: string, y: number) => void;
  onToggle: () => void;
  readDebugEvents: string[];
  showMenu: boolean;
}) {
  const debugMode = useDebugMode();
  const collapsedMenuActions = useMemo(
    () => getMessageMenuActions(message, debugMode, Boolean(message.htmlBody?.trim())),
    [debugMode, message.htmlBody, message.pinned, message.unread],
  );

  const handleCollapsedMenuAction = (event: NativeActionEvent) => {
    const action = event.nativeEvent.event;
    const htmlBody = message.htmlBody?.trim();

    if (isMessageAction(action)) {
      onAction(action, message.id);
    } else if (action === copyEmailHtmlAction && htmlBody) {
      Clipboard.setString(message.htmlBody ?? '');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else if (action === dumpEmailCacheAction) {
      Clipboard.setString(getMessageCacheDumpText({ bodyDebug, message, readDebugEvents }));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else {
      pressHaptic();
    }
  };

  return (
    <View
      onLayout={(event) => onLayout(message.id, event.nativeEvent.layout.y)}
      style={!isLast ? [styles.threadSeparator, { borderBottomColor: colors.groupDivider }] : null}>
      {expanded ? (
        <ExpandedThreadMessage
          bodyDebug={bodyDebug}
          colors={colors}
          contactAvatarUri={getContactAvatarUriForMessage(message, contactAvatarUriByEmail)}
          focused={focused}
          message={message}
          onAction={onAction}
          onToggle={canToggle ? onToggle : undefined}
          readDebugEvents={readDebugEvents}
          showMenu={showMenu}
        />
      ) : (
        <CollapsedThreadMessage
          colors={colors}
          contactAvatarUri={getContactAvatarUriForMessage(message, contactAvatarUriByEmail)}
          menuActions={collapsedMenuActions}
          message={message}
          onAction={handleCollapsedMenuAction}
          onPress={onToggle}
        />
      )}
    </View>
  );
}

function CollapsedThreadMessage({
  colors,
  contactAvatarUri,
  menuActions,
  message,
  onAction,
  onPress,
}: {
  colors: ColorSet;
  contactAvatarUri?: string;
  menuActions: MenuAction[];
  message: Message;
  onAction: (event: NativeActionEvent) => void;
  onPress: () => void;
}) {
  return (
    <View style={styles.threadCollapsedItem}>
      <ThreadMessageHeader
        colors={colors}
        contactAvatarUri={contactAvatarUri}
        menuActions={menuActions}
        message={message}
        onMenuAction={onAction}
        onPress={onPress}
        sentInfoEnabled={false}
        showMenu
      />
    </View>
  );
}

function ExpandedThreadMessage({
  bodyDebug,
  colors,
  contactAvatarUri,
  focused,
  message,
  onAction,
  onToggle,
  readDebugEvents,
  showMenu,
}: {
  bodyDebug?: JmapMessageBodyDebug;
  colors: ColorSet;
  contactAvatarUri?: string;
  focused: boolean;
  message: Message;
  onAction: (action: MessageAction, messageId?: string) => void;
  onToggle?: () => void;
  readDebugEvents: string[];
  showMenu: boolean;
}) {
  const debugMode = useDebugMode();
  const body = message.body ?? message.preview ?? getMockMessageBody();
  const messageHtmlBody = message.htmlBody;
  const retainedHtmlBodyRef = useRef<{ html: string | null; messageId: string }>({
    html: messageHtmlBody?.trim() ? messageHtmlBody : null,
    messageId: message.id,
  });

  if (retainedHtmlBodyRef.current.messageId !== message.id) {
    retainedHtmlBodyRef.current = {
      html: messageHtmlBody?.trim() ? messageHtmlBody : null,
      messageId: message.id,
    };
  } else if (messageHtmlBody?.trim()) {
    retainedHtmlBodyRef.current.html = messageHtmlBody;
  }

  const rawHtmlBody = messageHtmlBody?.trim() ? messageHtmlBody : retainedHtmlBodyRef.current.html;
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
  const afterQuoteHtmlBody = htmlReplySplit?.afterQuoteHtml ?? null;
  const htmlForwardSplit = useMemo(
    () => (visibleHtmlBody ? splitEmailForwardHtml(visibleHtmlBody) : null),
    [visibleHtmlBody],
  );
  const primaryHtmlBody = htmlForwardSplit?.introHtml ?? visibleHtmlBody;
  const forwardedHtmlBody = htmlForwardSplit?.forwardedHtml ?? null;
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
      onAction(action, message.id);
    } else if (action === copyEmailHtmlAction && htmlBody && rawHtmlBody) {
      Clipboard.setString(rawHtmlBody);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else if (action === dumpEmailCacheAction) {
      Clipboard.setString(getMessageCacheDumpText({ bodyDebug, message, readDebugEvents }));
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
        contactAvatarUri={contactAvatarUri}
        menuActions={messageMenuActions}
        message={message}
        onMenuAction={handleMenuAction}
        onPress={onToggle}
        sentInfoEnabled
        showMenu={showMenu}
      />

      {primaryHtmlBody ? (
        <>
          <EmailBodyWebView
            colors={colors}
            html={primaryHtmlBody}
            onDarkModeDebug={setDarkModeDebug}
            onImageDebug={setImageDebug}
          />
          {forwardedHtmlBody ? (
            <EmailBodyWebView
              colors={colors}
              html={forwardedHtmlBody}
              onDarkModeDebug={setDarkModeDebug}
              onImageDebug={setImageDebug}
            />
          ) : null}
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
          {afterQuoteHtmlBody ? (
            <EmailBodyWebView
              colors={colors}
              html={afterQuoteHtmlBody}
              onImageDebug={() => {}}
            />
          ) : null}
          <AttachmentList attachments={attachments} colors={colors} />
          {debugMode ? (
            <EmailBodyDebugReport
              colors={colors}
              debug={bodyDebug}
              darkModeDebug={darkModeDebug}
              html={htmlBody ?? visibleHtmlBody ?? ''}
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

type SentInfoRow = {
  label: string;
  values: string[];
};

function getMessageSentInfoRows(message: Message): SentInfoRow[] {
  const rows: SentInfoRow[] = [];
  const fromValue = getFromSentInfoValue(message);

  if (fromValue) {
    rows.push({ label: 'From', values: [fromValue] });
  }

  const ccValues = getAddressSentInfoValues(message.ccAddresses);

  if (ccValues.length) {
    rows.push({ label: 'Cc', values: ccValues });
  }

  const bccValues = getAddressSentInfoValues(message.bccAddresses);

  if (bccValues.length) {
    rows.push({ label: 'Bcc', values: bccValues });
  }

  return rows;
}

function getFromSentInfoValue(message: Message) {
  const sender = message.sender.trim();
  const fromEmail = message.fromEmail?.trim();

  if (sender && fromEmail && !sender.includes(fromEmail)) {
    return `${sender} <${fromEmail}>`;
  }

  return sender || fromEmail || null;
}

function getAddressSentInfoValues(values?: string[], fallback?: string) {
  const structuredValues = values?.map((value) => value.trim()).filter(Boolean) ?? [];

  return structuredValues.length ? structuredValues : parseCommaSeparatedAddressList(fallback);
}

function parseCommaSeparatedAddressList(value?: string) {
  return value
    ? value
        .split(',')
        .map((address) => address.trim())
        .filter(Boolean)
    : [];
}

function ThreadMessageHeader({
  colors,
  contactAvatarUri,
  menuActions,
  message,
  onMenuAction,
  onPress,
  sentInfoEnabled = true,
  showMenu,
}: {
  colors: ColorSet;
  contactAvatarUri?: string;
  menuActions?: MenuAction[];
  message: Message;
  onMenuAction?: (event: NativeActionEvent) => void;
  onPress?: () => void;
  sentInfoEnabled?: boolean;
  showMenu: boolean;
}) {
  const [sentInfoExpanded, setSentInfoExpanded] = useState(false);
  const sentInfoRows = useMemo(() => getMessageSentInfoRows(message), [message]);
  const toValues = useMemo(
    () => getAddressSentInfoValues(message.toAddresses, message.to),
    [message.to, message.toAddresses],
  );
  const toLine = message.to ? `To: ${message.to}` : 'To: Me';
  const handleHeaderPress = onPress;
  const toggleSentInfo = () => {
    pressHaptic();
    setSentInfoExpanded((expanded) => !expanded);
  };
  const handleSentInfoPress = sentInfoEnabled ? toggleSentInfo : onPress;
  const sentInfoAccessibilityLabel = sentInfoEnabled
    ? sentInfoExpanded
      ? 'Hide sent information'
      : 'Show sent information'
    : 'Expand message';

  return (
    <View style={styles.messageHeaderRow}>
      <ProfileAvatar
        avatarUrl={contactAvatarUri ?? message.avatarUrl}
        color={message.avatarColor}
        label={message.avatar}
        size={38}
        style={styles.detailAvatar}
        textSize={(message.avatar?.length ?? 1) > 1 ? 15 : 20}
      />
      <View style={styles.messageSenderBlock}>
        <Pressable
          accessibilityRole={handleHeaderPress ? 'button' : undefined}
          disabled={!handleHeaderPress}
          onPress={handleHeaderPress}
          style={({ pressed }) => [styles.messageHeaderPressTarget, pressed && styles.pressed]}>
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
        </Pressable>
        <View style={styles.messageSenderBottomRow}>
          <Pressable
            accessibilityLabel={sentInfoAccessibilityLabel}
            accessibilityRole={handleSentInfoPress ? 'button' : undefined}
            disabled={!handleSentInfoPress}
            onPress={handleSentInfoPress}
            style={({ pressed }) => [styles.messageRecipientRow, pressed && styles.pressed]}>
            {sentInfoEnabled && sentInfoExpanded ? (
              <View style={styles.sentInfoDetails}>
                <SentInfoDetailRow colors={colors} label="To" values={toValues.length ? toValues : ['Me']} />
                {sentInfoRows.map((row) => (
                  <SentInfoDetailRow colors={colors} key={row.label} label={row.label} values={row.values} />
                ))}
              </View>
            ) : (
              <Text {...textScale} numberOfLines={1} style={[styles.messageRecipient, { color: colors.secondaryText }]}>
                {toLine}
              </Text>
            )}
          </Pressable>
          <Pressable
            accessibilityLabel={sentInfoAccessibilityLabel}
            accessibilityRole={handleSentInfoPress ? 'button' : undefined}
            disabled={!handleSentInfoPress}
            onPress={handleSentInfoPress}
            style={({ pressed }) => [styles.messageRecipientChevronButton, pressed && styles.pressed]}>
            <SymbolView
              name={sentInfoEnabled && sentInfoExpanded ? 'chevron.up' : 'chevron.down'}
              tintColor={colors.secondaryText}
              size={12}
              weight="semibold"
            />
          </Pressable>
          {showMenu && menuActions && onMenuAction ? (
            <MessageHeaderMenu actions={menuActions} colors={colors} onPressAction={onMenuAction} />
          ) : null}
        </View>
      </View>
    </View>
  );
}

function SentInfoDetailRow({
  colors,
  label,
  values,
}: {
  colors: ColorSet;
  label: string;
  values: string[];
}) {
  return (
    <View style={styles.sentInfoRow}>
      <Text {...textScale} style={[styles.sentInfoLabel, { color: colors.secondaryText }]}>
        {label}:
      </Text>
      <View style={styles.sentInfoValueBlock}>
        {values.map((value, index) => (
          <Text
            {...textScale}
            key={`${label}-${index}-${value}`}
            selectable
            style={[styles.messageRecipient, { color: colors.secondaryText }]}>
            {value}
          </Text>
        ))}
      </View>
    </View>
  );
}

function MessageHeaderMenu({
  actions,
  colors,
  onPressAction,
}: {
  actions: MenuAction[];
  colors: ColorSet;
  onPressAction: (event: NativeActionEvent) => void;
}) {
  return (
    <View style={styles.messageMenuHost}>
      <View pointerEvents="none" style={styles.messageEllipsisButton}>
        <SymbolView name="ellipsis" tintColor={colors.secondaryText} size={18} weight="semibold" />
      </View>
      <MenuView actions={actions} onPressAction={onPressAction} style={styles.messageMenuOverlay}>
        <View style={styles.messageMenuHitTarget} />
      </MenuView>
    </View>
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

  return <EmailDebugReport colors={colors} label="Email HTML Debug" text={reportText} />;
}

function EmailDebugReport({
  colors,
  label,
  text,
}: {
  colors: ColorSet;
  label: string;
  text: string;
}) {
  const copyReport = () => {
    Clipboard.setString(text);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  return (
    <View style={[styles.emailDebugBox, { borderColor: colors.groupDivider }]}>
      <View style={styles.emailDebugHeader}>
        <Text style={[styles.emailDebugLabel, { color: colors.secondaryText }]}>{label}</Text>
        <Pressable accessibilityRole="button" onPress={copyReport} style={styles.emailDebugCopyButton}>
          <Text style={[styles.emailDebugCopyText, { color: colors.text }]}>Copy</Text>
        </Pressable>
      </View>
      <Text style={[styles.emailDebugText, { color: colors.secondaryText }]}>{text}</Text>
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
    `cid inline mode: ${debug.cidImageInlineMode ?? 'unknown'}`,
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
    `accents=${darkModeDebug.accentTextCount}`,
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
  messageHeaderPressTarget: {
    alignSelf: 'stretch',
    minWidth: 0,
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
    minWidth: 0,
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
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 0,
    justifyContent: 'space-between',
    minWidth: 0,
  },
  messageSender: {
    flex: 1,
    fontFamily: systemFont,
    fontSize: 15,
    fontWeight: '600',
    lineHeight: 19,
  },
  messageRecipientRow: {
    flex: 1,
    minWidth: 0,
  },
  messageRecipientChevronButton: {
    alignItems: 'center',
    height: 18,
    justifyContent: 'center',
    marginLeft: 5,
    width: 18,
  },
  messageRecipient: {
    alignSelf: 'stretch',
    fontFamily: systemFont,
    fontSize: 14,
    fontWeight: '400',
    lineHeight: 18,
    minWidth: 0,
  },
  messageDetailDate: {
    fontFamily: systemFont,
    fontSize: 14,
    fontWeight: '500',
    lineHeight: 19,
    textAlign: 'right',
  },
  sentInfoDetails: {
    gap: 2,
  },
  sentInfoRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 4,
    minWidth: 0,
  },
  sentInfoLabel: {
    flexShrink: 0,
    fontFamily: systemFont,
    fontSize: 14,
    fontWeight: '400',
    lineHeight: 18,
  },
  sentInfoValueBlock: {
    flex: 1,
    minWidth: 0,
  },
  messageMenuHost: {
    flexShrink: 0,
    height: 18,
    marginLeft: 10,
    position: 'relative',
    width: 16,
  },
  messageEllipsisButton: {
    alignItems: 'center',
    bottom: 0,
    height: 18,
    justifyContent: 'center',
    position: 'absolute',
    right: -2,
    top: 0,
    width: 18,
  },
  messageMenuOverlay: {
    height: 30,
    position: 'absolute',
    right: -2,
    top: -6,
    width: 40,
  },
  messageMenuHitTarget: {
    height: 30,
    width: 40,
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
