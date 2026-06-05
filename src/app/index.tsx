import { ProgressiveBlurView } from '@/components/progressive-blur-view';
import { GradientAvatar, avatarGradient } from '@/components/gradient-avatar';
import {
  hasCachedEmailBody,
  removeCachedEmailFromMailbox,
  updateCachedEmail,
  writeCachedMailboxPage,
  writeCachedMailboxSnapshot,
} from '@/lib/mail-cache';
import {
  hydrateMailboxSnapshotFromCache,
  hydrateMessageBodyFromCache,
  prefetchMessageBodies,
  selectMailboxSnapshot,
  useMailStore,
} from '@/lib/mail-store';
import { useDebugMode } from '@/lib/debug-mode';
import {
  archiveJmapEmail,
  describeJmapError,
  fetchJmapMailboxSnapshot,
  setJmapEmailPinned,
  setJmapEmailUnread,
  trashJmapEmail,
  unarchiveJmapEmail,
  type JmapMailboxSnapshot,
} from '@/lib/jmap-client';
import {
  getNavigationDebugReport,
  markNavigationTrace,
  startNavigationTrace,
  useNavigationDebugTrace,
  type NavigationDebugTrace,
} from '@/lib/navigation-debug';
import type { Message } from '@/lib/mock-mail';
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
  type ScrollPhase,
  type TextFieldRef,
  useNativeState,
} from '@expo/ui/swift-ui';
import {
  Animation,
  animation,
  autocorrectionDisabled,
  background,
  blur as swiftBlur,
  cornerRadius,
  font,
  foregroundColor,
  foregroundStyle,
  frame,
  glassEffect,
  glassEffectId,
  listRowInsets,
  listRowBackground,
  listRowSeparator,
  listSectionSpacing,
  listStyle,
  lineLimit,
  onTapGesture,
  onScrollPhaseChange,
  offset as swiftOffset,
  opacity as swiftOpacity,
  padding,
  refreshable,
  scrollContentBackground,
  shapes,
  submitLabel,
  textInputAutocapitalization,
  tint as swiftTint,
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
import { ComponentProps, PropsWithChildren, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Clipboard,
  InteractionManager,
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
const titleRevealStart = 0.5;
const titleRevealEnd = 8;
const initialInboxRowRenderLimit = 10;
const inboxRenderPageSize = 20;
const inboxMailboxPageSize = 50;
const inboxLoadMoreThreshold = 420;
const inboxBottomLoadRearmOffsetDelta = 240;
const inboxBodyWarmDelayMs = 650;
const inboxBodyWarmBatchSize = 3;
const inboxBodyWarmBatchGapMs = 450;
const inboxCacheWriteDelayMs = 700;
const inboxDebugDiskBatchSize = 8;
const inboxDebugDiskBatchGapMs = 120;
const inboxSwipeRemovalDelayMs = 420;
const inboxRowInsets = { top: 8, leading: 8, bottom: 8, trailing: 20 };
const messageNavigationGuardMs = 2500;
const emptyMessageBodies: Record<string, unknown> = {};
const systemFont = Platform.select({ ios: 'system-ui', default: undefined });
const roundedFont = Platform.select({ ios: 'ui-rounded', default: undefined });
const pressHaptic = () => {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
};
type InboxSwipeAction = 'archive' | 'delete' | 'toggle-pin' | 'toggle-unread' | 'unarchive';
type BodyCacheDebugState = 'checking' | 'disk' | 'memory' | 'missing';

function interpolate(value: number, inputMin: number, inputMax: number, outputMin: number, outputMax: number) {
  const progress = Math.max(0, Math.min(1, (value - inputMin) / (inputMax - inputMin)));
  return outputMin + (outputMax - outputMin) * progress;
}

function scheduleMailboxCacheWrite(label: string, write: () => Promise<void>) {
  InteractionManager.runAfterInteractions(() => {
    setTimeout(() => {
      markNavigationTrace(`${label} start`);
      void write()
        .then(() => {
          markNavigationTrace(`${label} finished`);
        })
        .catch((error: unknown) => {
          markNavigationTrace(
            `${label} failed`,
            error instanceof Error ? error.message : String(error),
          );
        });
    }, inboxCacheWriteDelayMs);
  });
}

export default function InboxScreen() {
  const { mailboxId, mailboxName } = useLocalSearchParams<{
    mailboxId?: string;
    mailboxName?: string;
  }>();
  const insets = useSafeAreaInsets();
  const scheme = useColorScheme();
  const colors = scheme === 'dark' ? darkColors : lightColors;
  const initialScrollOffsetYRef = useRef<number | null>(null);
  const pendingDestructiveSwipeMessageIdsRef = useRef(new Set<string>());
  const pendingMessageNavigationKeyRef = useRef<string | null>(null);
  const pendingMessageNavigationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pullRefreshInFlightRef = useRef<Promise<void> | null>(null);
  const loadMoreInFlightRef = useRef<Promise<void> | null>(null);
  const loadMoreInboxMessagesRef = useRef<() => boolean>(() => false);
  const bottomLoadArmedRef = useRef(true);
  const bottomLoadTriggerOffsetRef = useRef(0);
  const hasMoreMessagesRef = useRef(true);
  const debugMode = useDebugMode();
  const navigationDebugTrace = useNavigationDebugTrace();
  const snapshot = useMailStore((state) => selectMailboxSnapshot(state, mailboxId));
  const liveMailboxId = snapshot?.mailbox?.id ?? mailboxId ?? null;
  const liveMailboxRole = snapshot?.mailbox?.role ?? null;
  const liveMailboxName = snapshot?.mailbox?.name ?? null;
  const liveMessages = snapshot?.messages ?? null;
  const messageBodies = useMailStore((state) => debugMode ? state.messageBodies : emptyMessageBodies);
  const applyMailboxSnapshot = useMailStore((state) => state.applyMailboxSnapshot);
  const patchStoreMessage = useMailStore((state) => state.patchMessage);
  const removeStoreMessageFromMailbox = useMailStore(
    (state) => state.removeMessageFromMailbox,
  );
  const [scrollY, setScrollY] = useState(0);
  const [listScrollPhase, setListScrollPhase] = useState<ScrollPhase>('idle');
  const [searchQuery, setSearchQuery] = useState('');
  const [bodyDiskStateById, setBodyDiskStateById] = useState<Record<string, boolean | undefined>>({});
  const [rowRenderLimit, setRowRenderLimit] = useState(initialInboxRowRenderLimit);
  const activeMailboxName = liveMailboxName ?? mailboxName ?? 'Inbox';
  const sourceMessages = liveMessages ?? [];
  const visibleMessages = getSearchFilteredMessages(sourceMessages, searchQuery);
  const renderedMessages = visibleMessages.slice(0, rowRenderLimit);
  const bodyDebugMessageIds = renderedMessages.map((message) => message.id);
  const bodyDebugKey = bodyDebugMessageIds.join('\n');
  const bodyWarmMessageIds = renderedMessages.map((message) => message.id);
  const bodyWarmKey = bodyWarmMessageIds.join('\n');
  const bodyCacheDebugStates = useMemo(
    () => getBodyCacheDebugStates({
      bodyDiskStateById,
      messageBodies,
      messageIds: bodyDebugMessageIds,
    }),
    [bodyDebugKey, bodyDiskStateById, messageBodies],
  );
  const clearPendingMessageNavigation = useCallback(() => {
    pendingMessageNavigationKeyRef.current = null;

    if (pendingMessageNavigationTimerRef.current) {
      clearTimeout(pendingMessageNavigationTimerRef.current);
      pendingMessageNavigationTimerRef.current = null;
    }
  }, []);
  useFocusEffect(
    useCallback(() => {
      clearPendingMessageNavigation();
    }, [clearPendingMessageNavigation]),
  );
  useEffect(() => clearPendingMessageNavigation, [clearPendingMessageNavigation]);
  const hiddenRowCount = Math.max(0, visibleMessages.length - renderedMessages.length);
  const messageRouteSource = liveMessages ? 'jmap' : 'mock';
  const navTitleVisible = scrollY >= titleRevealStart;
  const listIsScrolling = listScrollPhase !== 'idle';
  const markMessageReadOnOpen = useCallback(
    (item: Message) => {
      if (!liveMessages || !item.unread) {
        return item;
      }

      const nextKeywords = updateMessageKeyword(item.keywords, '$seen', true);
      const nextMessage = {
        ...item,
        keywords: nextKeywords,
        unread: false,
      };

      patchStoreMessage(item.id, {
        keywords: nextKeywords,
        unread: false,
      });
      void updateCachedEmail(item.id, {
        keywords: nextKeywords,
        unread: false,
      }).catch(() => {});

      setJmapEmailUnread(item.id, false)
        .then((result) => {
          patchStoreMessage(item.id, {
            keywords: result.keywords,
            pinned: result.pinned,
            unread: result.unread,
          });
          void updateCachedEmail(item.id, {
            keywords: result.keywords,
            pinned: result.pinned,
            unread: result.unread,
          }).catch(() => {});
        })
        .catch((error: unknown) => {
          if (snapshot) {
            applyMailboxSnapshot(snapshot, mailboxId);
          }
          console.warn('JMAP mark read on open failed', describeJmapError(error));
        });

      return nextMessage;
    },
    [applyMailboxSnapshot, liveMessages, mailboxId, patchStoreMessage, snapshot],
  );
  const scrollGeometryModifier = useScrollGeometryChange(
    useCallback((geometry) => {
      if (initialScrollOffsetYRef.current === null) {
        initialScrollOffsetYRef.current = geometry.contentOffsetY;
      }

      const nextScrollY = Math.max(0, geometry.contentOffsetY - initialScrollOffsetYRef.current);

      setScrollY((currentScrollY) =>
        Math.abs(currentScrollY - nextScrollY) < 0.5 ? currentScrollY : nextScrollY,
      );

      const distanceToBottom = geometry.contentHeight - geometry.containerHeight - geometry.contentOffsetY;

      if (geometry.contentHeight <= geometry.containerHeight) {
        bottomLoadArmedRef.current = true;
        return;
      }

      if (distanceToBottom > inboxLoadMoreThreshold) {
        if (
          geometry.contentOffsetY > bottomLoadTriggerOffsetRef.current + inboxBottomLoadRearmOffsetDelta ||
          geometry.contentOffsetY < bottomLoadTriggerOffsetRef.current - inboxBottomLoadRearmOffsetDelta
        ) {
          bottomLoadArmedRef.current = true;
        }
        return;
      }

      if (bottomLoadArmedRef.current) {
        bottomLoadArmedRef.current = false;
        bottomLoadTriggerOffsetRef.current = geometry.contentOffsetY;
        markNavigationTrace(
          'inbox bottom load trigger',
          `distance=${Math.round(distanceToBottom)} offset=${Math.round(geometry.contentOffsetY)}`,
        );
        const didStartLoad = loadMoreInboxMessagesRef.current();

        if (!didStartLoad) {
          bottomLoadArmedRef.current = true;
        }
      }
    }, []),
  );
  const scrollPhaseModifier = useMemo(
    () =>
      onScrollPhaseChange((phase) => {
        setListScrollPhase((currentPhase) => (currentPhase === phase ? currentPhase : phase));
      }),
    [],
  );
  const handleMessageSwipeAction = useCallback(
    (item: Message, action: InboxSwipeAction) => {
      pressHaptic();

      if (!liveMessages) {
        return;
      }

      const restoreMessages = () => {
        if (snapshot) {
          applyMailboxSnapshot(snapshot, mailboxId);
        }
      };

      if (action === 'archive' || action === 'delete' || action === 'unarchive') {
        if (pendingDestructiveSwipeMessageIdsRef.current.has(item.id)) {
          return;
        }

        pendingDestructiveSwipeMessageIdsRef.current.add(item.id);

        let removedFromStore = false;
        let removalTimer: ReturnType<typeof setTimeout> | null = null;
        const removalDelay = new Promise<void>((resolve) => {
          removalTimer = setTimeout(() => {
            removedFromStore = true;
            removalTimer = null;
            removeStoreMessageFromMailbox(item.id, liveMailboxId);
            resolve();
          }, inboxSwipeRemovalDelayMs);
        });

        const mutation = new Promise<void>((resolve, reject) => {
          InteractionManager.runAfterInteractions(() => {
            const request =
              action === 'archive'
                ? archiveJmapEmail(item.id)
                : action === 'unarchive'
                  ? unarchiveJmapEmail(item.id)
                  : trashJmapEmail(item.id);

            request.then(() => resolve()).catch(reject);
          });
        });

        Promise.all([removalDelay, mutation])
          .then(() => {
            void removeCachedEmailFromMailbox(item.id, liveMailboxId).catch(() => {});
          })
          .catch(() => {
            if (removalTimer) {
              clearTimeout(removalTimer);
              removalTimer = null;
            }

            if (removedFromStore) {
              restoreMessages();
            }
          })
          .finally(() => {
            pendingDestructiveSwipeMessageIdsRef.current.delete(item.id);
          });
        return;
      }

      if (action === 'toggle-pin') {
        const nextPinned = !item.pinned;
        patchStoreMessage(item.id, {
          keywords: updateMessageKeyword(item.keywords, '$flagged', nextPinned),
          pinned: nextPinned,
        });

        setJmapEmailPinned(item.id, nextPinned)
          .then((result) => {
            patchStoreMessage(item.id, {
              keywords: result.keywords,
              pinned: result.pinned,
              unread: result.unread,
            });
            void updateCachedEmail(item.id, {
              keywords: result.keywords,
              pinned: result.pinned,
              unread: result.unread,
            }).catch(() => {});
          })
          .catch(restoreMessages);
        return;
      }

      const nextUnread = !item.unread;
      patchStoreMessage(item.id, {
        keywords: updateMessageKeyword(item.keywords, '$seen', !nextUnread),
        unread: nextUnread,
      });

      setJmapEmailUnread(item.id, nextUnread)
        .then((result) => {
          patchStoreMessage(item.id, {
            keywords: result.keywords,
            pinned: result.pinned,
            unread: result.unread,
          });
          void updateCachedEmail(item.id, {
            keywords: result.keywords,
            pinned: result.pinned,
            unread: result.unread,
          }).catch(() => {});
        })
        .catch(restoreMessages);
    },
    [
      applyMailboxSnapshot,
      liveMailboxId,
      liveMessages,
      mailboxId,
      patchStoreMessage,
      removeStoreMessageFromMailbox,
      snapshot,
    ],
  );
  const updateHasMoreMessages = useCallback((nextHasMoreMessages: boolean) => {
    hasMoreMessagesRef.current = nextHasMoreMessages;
  }, []);
  const refreshMailboxFromServer = useCallback(
    async ({
      apply = true,
      limit = inboxMailboxPageSize,
      position = 0,
      signal,
      tracePrefix,
    }: {
      apply?: boolean;
      limit?: number;
      position?: number;
      signal?: AbortSignal;
      tracePrefix: string;
    }) => {
      markNavigationTrace(`${tracePrefix} start`, `position=${position} limit=${limit}`);
      const snapshot = await fetchJmapMailboxSnapshot({
        limit,
        mailboxId,
        position,
        signal,
      });
      markNavigationTrace(
        `${tracePrefix} finished`,
        `position=${snapshot.position ?? position} rows=${snapshot.messages.length} threads=${Object.keys(snapshot.threads ?? {}).length} total=${snapshot.total ?? 'unknown'}`,
      );
      updateHasMoreMessages(getSnapshotHasMoreMessages(snapshot, limit));

      if (apply) {
        const currentSnapshot = selectMailboxSnapshot(useMailStore.getState(), mailboxId);
        const nextSnapshot = currentSnapshot
          ? mergeMailboxPageIntoSnapshot(currentSnapshot, snapshot)
          : snapshot;

        updateHasMoreMessages(getSnapshotHasMoreMessages(nextSnapshot, limit));
        applyMailboxSnapshot(nextSnapshot, mailboxId);
        scheduleMailboxCacheWrite('inbox cache write', () => writeCachedMailboxSnapshot(nextSnapshot));
      }

      return snapshot;
    },
    [applyMailboxSnapshot, mailboxId, updateHasMoreMessages],
  );
  const refreshInbox = useCallback(() => {
    if (pullRefreshInFlightRef.current) {
      return pullRefreshInFlightRef.current;
    }

    const refresh = (async () => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      try {
        await refreshMailboxFromServer({
          limit: Math.max(inboxMailboxPageSize, liveMessages?.length ?? 0),
          tracePrefix: 'inbox pull refresh',
        });
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (error: unknown) {
        if (!(error instanceof Error && error.name === 'FastmailJmapTokenMissingError')) {
          console.warn('JMAP inbox pull refresh failed', describeJmapError(error));
        }
        markNavigationTrace('inbox pull refresh failed', describeJmapError(error));
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
    })().finally(() => {
      pullRefreshInFlightRef.current = null;
    });

    pullRefreshInFlightRef.current = refresh;
    return refresh;
  }, [liveMessages?.length, refreshMailboxFromServer]);
  const loadMoreInboxMessages = useCallback(() => {
    if (rowRenderLimit < visibleMessages.length) {
      setRowRenderLimit((current) => {
        const nextLimit = Math.min(current + inboxRenderPageSize, visibleMessages.length);

        if (nextLimit !== current) {
          markNavigationTrace('inbox cached rows revealed', `rows=${nextLimit}`);
        }

        return nextLimit;
      });
      return true;
    }

    if (searchQuery.trim()) {
      return false;
    }

    const currentSnapshot = selectMailboxSnapshot(useMailStore.getState(), mailboxId);
    const currentMessages = currentSnapshot?.messages ?? [];

    if (
      !currentSnapshot ||
      !currentMessages.length ||
      !hasMoreMessagesRef.current ||
      loadMoreInFlightRef.current
    ) {
      return false;
    }

    const nextPosition = currentMessages.length;

    const loadMore = refreshMailboxFromServer({
      apply: false,
      limit: inboxMailboxPageSize,
      position: nextPosition,
      tracePrefix: 'inbox load more',
    })
      .then((page) => {
        const mergedSnapshot = mergeMailboxPageIntoSnapshot(currentSnapshot, page);

        updateHasMoreMessages(getSnapshotHasMoreMessages(mergedSnapshot, inboxMailboxPageSize));
        applyMailboxSnapshot(mergedSnapshot, mailboxId);
        setRowRenderLimit((current) => {
          const nextLimit = Math.min(current + inboxRenderPageSize, mergedSnapshot.messages.length);

          if (nextLimit !== current) {
            markNavigationTrace('inbox loaded rows revealed', `rows=${nextLimit}`);
          }

          return nextLimit;
        });
        scheduleMailboxCacheWrite('inbox page cache write', () => writeCachedMailboxPage(page));
      })
      .catch((error: unknown) => {
        if (!(error instanceof Error && error.name === 'FastmailJmapTokenMissingError')) {
          console.warn('JMAP inbox load more failed', describeJmapError(error));
        }
        markNavigationTrace('inbox load more failed', describeJmapError(error));
      })
      .finally(() => {
        loadMoreInFlightRef.current = null;
      });

    loadMoreInFlightRef.current = loadMore;
    return true;
  }, [
    applyMailboxSnapshot,
    mailboxId,
    refreshMailboxFromServer,
    rowRenderLimit,
    searchQuery,
    updateHasMoreMessages,
    visibleMessages.length,
  ]);
  useEffect(() => {
    loadMoreInboxMessagesRef.current = loadMoreInboxMessages;
  }, [loadMoreInboxMessages]);
  useEffect(() => {
    updateHasMoreMessages(true);
  }, [mailboxId, updateHasMoreMessages]);
  useEffect(() => {
    if (!snapshot || loadMoreInFlightRef.current) {
      return;
    }

    updateHasMoreMessages(getSnapshotHasMoreMessages(snapshot, Math.max(inboxMailboxPageSize, snapshot.messages.length)));
  }, [snapshot, updateHasMoreMessages]);
  useEffect(() => {
    if (!debugMode || !bodyDebugKey || listIsScrolling) {
      return;
    }

    let cancelled = false;
    let nextBatchTimer: ReturnType<typeof setTimeout> | null = null;
    const messageIds = bodyDebugKey.split('\n').filter(Boolean);

    const runNextDebugBatch = (cursor: number) => {
      const batch = messageIds.slice(cursor, cursor + inboxDebugDiskBatchSize);

      if (!batch.length || cancelled) {
        return;
      }

      void getBodyDiskDebugStateEntries(batch)
        .then((entries) => {
          if (cancelled) {
            return;
          }

          setBodyDiskStateById((current) => applyBodyDiskDebugStateEntries(current, entries));

          if (cursor + inboxDebugDiskBatchSize < messageIds.length) {
            nextBatchTimer = setTimeout(
              () => runNextDebugBatch(cursor + inboxDebugDiskBatchSize),
              inboxDebugDiskBatchGapMs,
            );
          }
        })
        .catch(() => {});
    };

    runNextDebugBatch(0);

    return () => {
      cancelled = true;
      if (nextBatchTimer) {
        clearTimeout(nextBatchTimer);
      }
    };
  }, [bodyDebugKey, debugMode, listIsScrolling]);
  useEffect(() => {
    markNavigationTrace(
      'inbox committed',
      `mailbox=${activeMailboxName} rendered=${renderedMessages.length} rows=${sourceMessages.length} hidden=${hiddenRowCount}`,
    );
  }, [activeMailboxName, hiddenRowCount, mailboxId, renderedMessages.length, sourceMessages.length]);
  useEffect(() => {
    bottomLoadArmedRef.current = true;
    bottomLoadTriggerOffsetRef.current = 0;
    setRowRenderLimit(initialInboxRowRenderLimit);
    markNavigationTrace('inbox row render limited', `rows=${initialInboxRowRenderLimit}`);

    const expandRowsTask = InteractionManager.runAfterInteractions(() => {
      loadMoreInboxMessagesRef.current();
    });

    return () => {
      expandRowsTask.cancel();
    };
  }, [mailboxId]);
  useEffect(() => {
    if (!liveMessages || !bodyWarmKey || listIsScrolling) {
      return;
    }

    let cancelled = false;
    let nextBatchTimer: ReturnType<typeof setTimeout> | null = null;
    const messageIds = bodyWarmKey.split('\n').filter(Boolean);

    const runNextBodyWarmBatch = (cursor: number) => {
      if (cancelled) {
        return;
      }

      const batch = messageIds.slice(cursor, cursor + inboxBodyWarmBatchSize);

      if (!batch.length) {
        return;
      }

      markNavigationTrace(
        'body warm batch start',
        `start=${cursor} size=${batch.length} rows=${messageIds.length}`,
      );
      void prefetchMessageBodies(batch, {
        concurrency: 1,
        limit: batch.length,
      })
        .then((result) => {
          if (cancelled) {
            return;
          }

          markNavigationTrace(
            'body warm batch finished',
            `loaded=${result.loaded} skipped=${result.skipped} failed=${result.failed}`,
          );
          if (debugMode) {
            void getBodyDiskDebugStateEntries(batch)
              .then((entries) => {
                if (!cancelled) {
                  setBodyDiskStateById((current) => applyBodyDiskDebugStateEntries(current, entries));
                }
              })
              .catch(() => {});
          }

          if (cursor + inboxBodyWarmBatchSize < messageIds.length) {
            nextBatchTimer = setTimeout(
              () => runNextBodyWarmBatch(cursor + inboxBodyWarmBatchSize),
              inboxBodyWarmBatchGapMs,
            );
          }
        })
        .catch((error: unknown) => {
          if (cancelled) {
            return;
          }

          markNavigationTrace(
            'body warm batch failed',
            error instanceof Error ? error.message : String(error),
          );
        });
    };

    const warmTimer = setTimeout(() => {
      runNextBodyWarmBatch(0);
    }, inboxBodyWarmDelayMs);

    return () => {
      cancelled = true;
      clearTimeout(warmTimer);
      if (nextBatchTimer) {
        clearTimeout(nextBatchTimer);
      }
    };
  }, [bodyWarmKey, debugMode, listIsScrolling, liveMessages]);
  useFocusEffect(
    useCallback(() => {
      const controller = new AbortController();
      initialScrollOffsetYRef.current = null;
      setScrollY(0);
      markNavigationTrace('inbox focus effect', `mailboxId=${mailboxId ?? 'inbox'}`);

      const refreshTask = InteractionManager.runAfterInteractions(() => {
        markNavigationTrace('inbox post-interaction refresh start');

        const memorySnapshot = selectMailboxSnapshot(useMailStore.getState(), mailboxId);

        if (memorySnapshot) {
          markNavigationTrace('inbox cache hydrate skipped', `memory rows=${memorySnapshot.messages.length}`);
        } else {
          markNavigationTrace('inbox cache hydrate start');
          void hydrateMailboxSnapshotFromCache(mailboxId)
            .then((snapshot) => {
              markNavigationTrace(
                'inbox cache hydrate finished',
                snapshot ? `rows=${snapshot.messages.length}` : 'cache=miss',
              );
            })
            .catch((error: unknown) => {
              markNavigationTrace(
                'inbox cache hydrate failed',
                error instanceof Error ? error.message : String(error),
              );
            });
        }

        void refreshMailboxFromServer({
          limit: Math.max(inboxMailboxPageSize, memorySnapshot?.messages.length ?? 0),
          signal: controller.signal,
          tracePrefix: 'inbox JMAP fetch',
        })
          .catch((error: unknown) => {
            if (controller.signal.aborted) {
              return;
            }

            if (!(error instanceof Error && error.name === 'FastmailJmapTokenMissingError')) {
              console.warn('JMAP inbox refresh failed', describeJmapError(error));
            }
            markNavigationTrace('inbox JMAP fetch failed', describeJmapError(error));
          });
      });

      return () => {
        refreshTask.cancel();
        controller.abort();
      };
    }, [mailboxId, refreshMailboxFromServer]),
  );
  const headerBackdropHeight = insets.top + 70;
  const headerOpacity = interpolate(scrollY, 0, titleRevealEnd, 0, 1);
  const openCompose = () => {
    router.push('/compose');
  };
  const openMessage = (item: Message) => {
    if (pendingMessageNavigationKeyRef.current === item.id) {
      markNavigationTrace('duplicate message tap ignored', `message=${item.id}`);
      return;
    }

    pendingMessageNavigationKeyRef.current = item.id;

    if (pendingMessageNavigationTimerRef.current) {
      clearTimeout(pendingMessageNavigationTimerRef.current);
    }

    pendingMessageNavigationTimerRef.current = setTimeout(() => {
      clearPendingMessageNavigation();
    }, messageNavigationGuardMs);

    const openedMessage = markMessageReadOnOpen(item);
    const messageHref = getMessageRouteHref(openedMessage, activeMailboxName, messageRouteSource);

    if (liveMessages) {
      void hydrateMessageBodyFromCache(item.id).catch(() => {});
    }

    router.push(messageHref);
  };
  const openFolders = () => {
    pressHaptic();
    const traceDetail = `mailbox=${activeMailboxName} id=${liveMailboxId ?? 'none'} role=${liveMailboxRole ?? 'none'}`;

    startNavigationTrace('Inbox -> Folders', traceDetail);
    if (router.canGoBack()) {
      markNavigationTrace('router.back start', traceDetail);
      router.back();
      markNavigationTrace('router.back returned', traceDetail);
      return;
    }

    markNavigationTrace('router.push folders fallback start', traceDetail);
    router.push('/folders');
    markNavigationTrace('router.push folders fallback returned', traceDetail);
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
              listSectionSpacing(0),
              scrollContentBackground('hidden'),
              refreshable(refreshInbox),
              scrollPhaseModifier,
              ...(scrollGeometryModifier ? [scrollGeometryModifier] : []),
            ]}>
            <HStack
              modifiers={[
              listRowInsets({ top: 0, leading: 0, bottom: 0, trailing: 0 }),
              listRowBackground(colors.background),
              listRowSeparator('hidden'),
            ]}>
              <RNHostView matchContents>
                <InboxListHeader
                  activeMailboxName={activeMailboxName}
                  colors={colors}
                  debugMode={debugMode}
                  navigationDebugTrace={navigationDebugTrace}
                />
              </RNHostView>
            </HStack>
            {renderedMessages.map((item) => {
              return (
                <MessageRow
                  bodyCacheDebugState={debugMode ? bodyCacheDebugStates[item.id] : undefined}
                  colors={colors}
                  item={item}
                  key={item.id}
                  mailboxName={activeMailboxName}
                  mailboxRole={liveMailboxRole}
                  onSwipeAction={(action) => handleMessageSwipeAction(item, action)}
                  onPress={() => openMessage(item)}
                />
              );
            })}
            <HStack
              modifiers={[
              listRowInsets({ top: 0, leading: 0, bottom: 0, trailing: 0 }),
              listRowBackground(colors.background),
              listRowSeparator('hidden'),
            ]}>
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
    threadId: item.threadId ?? '',
    to: item.to ?? '',
    wasUnreadOnOpen: item.unread ? '1' : '0',
    unread: item.unread ? '1' : '0',
  };
}

function getMessageRouteHref(item: Message, mailboxName: string, source: 'jmap' | 'mock') {
  return {
    pathname: '/message/[id]' as const,
    params: getMessageRouteParams(item, mailboxName, source),
  };
}

function mergeMailboxPageIntoSnapshot(
  currentSnapshot: JmapMailboxSnapshot,
  pageSnapshot: JmapMailboxSnapshot,
): JmapMailboxSnapshot {
  const position = pageSnapshot.position ?? 0;
  const seenMessageIds = new Set<string>();
  const pageEndPosition = position + pageSnapshot.messages.length;
  const total = pageSnapshot.total ?? currentSnapshot.total ?? null;
  const shouldKeepTail = typeof total === 'number' ? pageEndPosition < total : true;
  const messages = [
    ...currentSnapshot.messages.slice(0, position),
    ...pageSnapshot.messages,
    ...(shouldKeepTail ? currentSnapshot.messages.slice(pageEndPosition) : []),
  ].filter((message) => {
    if (seenMessageIds.has(message.id)) {
      return false;
    }

    seenMessageIds.add(message.id);
    return true;
  });

  return {
    accountId: pageSnapshot.accountId,
    mailbox: pageSnapshot.mailbox ?? currentSnapshot.mailbox,
    mailboxes: pageSnapshot.mailboxes.length ? pageSnapshot.mailboxes : currentSnapshot.mailboxes,
    messages: typeof total === 'number' ? messages.slice(0, total) : messages,
    position: currentSnapshot.position ?? 0,
    threads: {
      ...(currentSnapshot.threads ?? {}),
      ...(pageSnapshot.threads ?? {}),
    },
    total,
    username: pageSnapshot.username || currentSnapshot.username,
  };
}

function getSnapshotHasMoreMessages(snapshot: JmapMailboxSnapshot, requestedLimit: number) {
  const total = snapshot.total ?? snapshot.mailbox?.totalEmails ?? null;

  if (typeof total === 'number') {
    return (snapshot.position ?? 0) + snapshot.messages.length < total;
  }

  return snapshot.messages.length >= requestedLimit;
}

function getSearchFilteredMessages(messages: Message[], searchQuery: string) {
  const query = searchQuery.trim().toLowerCase();

  if (!query) {
    return messages;
  }

  return messages.filter((message) =>
    message.sender.toLowerCase().includes(query) ||
    message.subject.toLowerCase().includes(query) ||
    message.preview.toLowerCase().includes(query)
  );
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

async function getBodyDiskDebugStateEntries(messageIds: string[]) {
  return await Promise.all(
    messageIds.map(async (messageId) => [
      messageId,
      await hasCachedEmailBody(messageId),
    ] as const),
  );
}

function applyBodyDiskDebugStateEntries(
  current: Record<string, boolean | undefined>,
  entries: readonly (readonly [string, boolean])[],
) {
  const next = { ...current };

  for (const [messageId, isOnDisk] of entries) {
    next[messageId] = isOnDisk;
  }

  return next;
}

function getBodyCacheDebugStates({
  bodyDiskStateById,
  messageBodies,
  messageIds,
}: {
  bodyDiskStateById: Record<string, boolean | undefined>;
  messageBodies: Record<string, unknown>;
  messageIds: string[];
}) {
  const states: Record<string, BodyCacheDebugState> = {};

  for (const messageId of messageIds) {
    if (bodyDiskStateById[messageId]) {
      states[messageId] = 'disk';
    } else if (messageBodies[messageId]) {
      states[messageId] = 'memory';
    } else if (bodyDiskStateById[messageId] === false) {
      states[messageId] = 'missing';
    } else {
      states[messageId] = 'checking';
    }
  }

  return states;
}

function getBodyCacheDebugLabel(state: BodyCacheDebugState) {
  switch (state) {
    case 'disk':
      return 'disk';
    case 'memory':
      return 'mem';
    case 'missing':
      return 'none';
    case 'checking':
      return 'check';
  }
}

function InboxListHeader({
  activeMailboxName,
  colors,
  debugMode,
  navigationDebugTrace,
}: {
  activeMailboxName: string;
  colors: ColorSet;
  debugMode: boolean;
  navigationDebugTrace: NavigationDebugTrace | null;
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
      {debugMode ? (
        <NavigationDebugPanel colors={colors} trace={navigationDebugTrace} />
      ) : null}
    </View>
  );
}

function NavigationDebugPanel({
  colors,
  trace,
}: {
  colors: ColorSet;
  trace: NavigationDebugTrace | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const report = getNavigationDebugReport(trace);
  const copyReport = () => {
    Clipboard.setString(report);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  return (
    <View style={[styles.navigationDebugBox, { borderColor: colors.groupDivider }]}>
      <View style={[styles.navigationDebugHeader, expanded ? styles.navigationDebugHeaderExpanded : null]}>
        <Text style={[styles.navigationDebugLabel, { color: colors.secondaryText }]}>
          Navigation Debug
        </Text>
        <View style={styles.navigationDebugActions}>
          <Pressable
            accessibilityRole="button"
            onPress={() => setExpanded((current) => !current)}
            style={styles.navigationDebugCopyButton}>
            <Text style={[styles.navigationDebugCopyText, { color: colors.text }]}>
              {expanded ? 'Hide' : 'Show'}
            </Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={copyReport} style={styles.navigationDebugCopyButton}>
            <Text style={[styles.navigationDebugCopyText, { color: colors.text }]}>Copy</Text>
          </Pressable>
        </View>
      </View>
      {expanded ? (
        <Text selectable style={[styles.navigationDebugText, { color: colors.secondaryText }]}>
          {report}
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
  bodyCacheDebugState,
  item,
  colors,
  mailboxName,
  mailboxRole,
  onSwipeAction,
  onPress,
}: {
  bodyCacheDebugState?: BodyCacheDebugState;
  item: Message;
  colors: ColorSet;
  mailboxName: string;
  mailboxRole: string | null;
  onSwipeAction: (action: InboxSwipeAction) => void;
  onPress: () => void;
}) {
  const attachments = item.attachments ?? [];
  const avatarTextSize = (item.avatar?.length ?? 1) > 1 ? 16 : 22;
  const isArchiveMailbox = mailboxRole === 'archive' || mailboxName.trim().toLowerCase() === 'archive';
  const bodyCacheDebugLabel = bodyCacheDebugState
    ? getBodyCacheDebugLabel(bodyCacheDebugState)
    : null;
  const tapRow = () => {
    pressHaptic();
    onPress();
  };

  return (
    <SwipeActions modifiers={[listRowInsets(inboxRowInsets), listRowBackground(colors.background)]}>
      <HStack
        alignment="top"
        spacing={9}
        modifiers={[frame({ maxWidth: 1000, alignment: 'leading' }), onTapGesture(tapRow)]}>
        <ZStack modifiers={[frame({ width: 8, height: 44 })]}>
          {item.unread ? (
            <Circle modifiers={[frame({ width: 8, height: 8 }), foregroundColor(tint)]} />
          ) : null}
        </ZStack>
        <SwiftGradientAvatar
          color={item.avatarColor}
          label={item.avatar}
          size={44}
          textSize={avatarTextSize}
        />
        <VStack alignment="leading" spacing={0} modifiers={[frame({ maxWidth: 1000, alignment: 'leading' })]}>
          <HStack alignment="firstTextBaseline" spacing={4}>
            <SwiftText
              modifiers={[
                font({ size: 16, weight: 'bold' }),
                foregroundColor(colors.text),
                lineLimit(1),
                truncationMode('tail'),
              ]}>
              {item.sender}
            </SwiftText>
            {item.count ? (
              <SwiftText
                modifiers={[
                  font({ size: 14, weight: 'regular' }),
                  foregroundColor(colors.secondaryText),
                  lineLimit(1),
                ]}>
                {item.count}
              </SwiftText>
            ) : null}
            <Spacer minLength={4} />
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
          {bodyCacheDebugLabel ? (
            <SwiftText
              modifiers={[
                font({ size: 8, weight: 'regular' }),
                foregroundColor(colors.secondaryText),
                lineLimit(1),
              ]}>
              {bodyCacheDebugLabel}
            </SwiftText>
          ) : null}
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
        {isArchiveMailbox ? (
          <SwiftButton
            label="Unarchive"
            modifiers={[swiftTint(colors.archiveAction)]}
            onPress={() => onSwipeAction('unarchive')}
            role="destructive"
            systemImage="tray.and.arrow.down"
          />
        ) : (
          <SwiftButton
            label="Archive"
            modifiers={[swiftTint(colors.archiveAction)]}
            onPress={() => onSwipeAction('archive')}
            role="destructive"
            systemImage="archivebox"
          />
        )}
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

function SwiftGradientAvatar({
  color,
  label = '?',
  size,
  textSize,
}: {
  color: string;
  label?: string;
  size: number;
  textSize?: number;
}) {
  const initials = label.trim().slice(0, 2) || '?';
  const fontSize = textSize ?? Math.round(size * (initials.length > 1 ? 0.38 : 0.52));

  return (
    <ZStack modifiers={[frame({ width: size, height: size })]}>
      <Circle
        modifiers={[
          frame({ width: size, height: size }),
          foregroundStyle({
            type: 'linearGradient',
            colors: avatarGradient(color),
            startPoint: { x: 0.12, y: 0 },
            endPoint: { x: 1, y: 1 },
          }),
        ]}
      />
      <SwiftText
        modifiers={[
          font({ size: fontSize, weight: 'semibold', design: 'rounded' }),
          foregroundColor('#FFFFFF'),
          lineLimit(1),
          frame({ width: size, height: size, alignment: 'center' }),
        ]}>
        {initials}
      </SwiftText>
    </ZStack>
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
    <HStack spacing={6} modifiers={[padding({ top: 3 })]}>
      <HStack
        alignment="center"
        spacing={4}
        modifiers={[
          padding({ horizontal: 6, vertical: 2 }),
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
          and {attachments.length - 1} more
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
          and {attachments.length - 1} more
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
  archiveAction: '#8E8E93',
  pin: '#FF3B30',
  headerTintTop: 'rgba(255, 255, 255, 1)',
  headerTintMiddle: 'rgba(255, 255, 255, 0.8)',
  headerTintBottom: 'rgba(255, 255, 255, 0)',
  glassTint: 'rgba(255, 255, 255, 0.62)',
  fallbackGlass: 'rgba(255, 255, 255, 0.86)',
  fallbackBorder: 'rgba(255, 255, 255, 0.65)',
};

const darkColors: ColorSet = {
  background: '#090909',
  text: '#F5F5F5',
  secondaryText: '#A8A8AE',
  tertiaryText: '#77777D',
  separator: '#2D2D31',
  groupDivider: 'rgba(235, 235, 245, 0.16)',
  messageChip: 'rgba(118, 118, 128, 0.28)',
  attachmentChipBorder: '#3A3A3F',
  attachmentImage: '#FF453A',
  archiveAction: '#8E8E93',
  pin: '#FF453A',
  headerTintTop: 'rgba(9, 9, 9, 1)',
  headerTintMiddle: 'rgba(9, 9, 9, 0.82)',
  headerTintBottom: 'rgba(9, 9, 9, 0)',
  glassTint: 'rgba(36, 36, 38, 0.64)',
  fallbackGlass: 'rgba(36, 36, 38, 0.88)',
  fallbackBorder: 'rgba(255, 255, 255, 0.1)',
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
    paddingBottom: 2,
    paddingHorizontal: 20,
    paddingTop: 4,
  },
  title: {
    fontFamily: systemFont,
    fontSize: 32,
    fontWeight: '700',
    letterSpacing: 0,
    lineHeight: 36,
  },
  navigationDebugBox: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  navigationDebugHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  navigationDebugHeaderExpanded: {
    marginBottom: 4,
  },
  navigationDebugActions: {
    alignItems: 'center',
    flexDirection: 'row',
  },
  navigationDebugLabel: {
    fontFamily: systemFont,
    fontSize: 11,
    fontWeight: '600',
    lineHeight: 14,
  },
  navigationDebugCopyButton: {
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  navigationDebugCopyText: {
    fontFamily: systemFont,
    fontSize: 11,
    fontWeight: '600',
    lineHeight: 14,
  },
  navigationDebugText: {
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    fontSize: 10,
    fontWeight: '400',
    lineHeight: 13,
  },
  selectText: {
    fontFamily: systemFont,
    fontSize: 16,
    fontWeight: '600',
  },
  messageBody: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    flex: 1,
    marginLeft: 10,
    paddingBottom: 8,
    paddingTop: 7,
    position: 'relative',
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
    fontWeight: '400',
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
  bodyCacheDebugLabel: {
    alignSelf: 'flex-end',
    fontFamily: systemFont,
    fontSize: 9,
    fontWeight: '500',
    lineHeight: 10,
    opacity: 0.72,
    position: 'absolute',
    right: 0,
    bottom: 1,
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
    flexShrink: 1,
    fontFamily: systemFont,
    fontSize: 14,
    fontWeight: '400',
    lineHeight: 18,
    marginLeft: 8,
    minWidth: 0,
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
