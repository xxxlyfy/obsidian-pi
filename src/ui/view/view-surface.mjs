/**
 * The surface the chat view exposes to its mixin modules.
 *
 * `PiAgentView` is assembled from several modules that share one object through
 * `this` (see `PiAgentView.mjs`). Documenting that shared shape here gives those
 * modules a name to type against, so a misspelled field or method is caught by
 * `npm run typecheck` instead of at runtime inside a stream callback.
 *
 * The index signature is deliberate: this is a transitional description of an
 * existing prototype, not a design. It keeps new fields type-checked for their
 * arguments and return values without forcing every field to be declared before
 * the view state is extracted into its own object.
 *
 * @typedef {object} PiAgentViewSurface
 *
 * @property {any} plugin Backing plugin instance.
 * @property {any} suggestions Composer suggestion controller.
 * @property {any} messageActions Message action callbacks.
 * @property {any} noteActions Note action callbacks.
 * @property {any} threadMenu Thread action callbacks.
 * @property {any} runSettings Composer run-settings controls.
 * @property {any} nativePiQueue Queue reported by Pi itself.
 * @property {any} streamingItemEl Streaming message container element.
 * @property {any} streamingTextEl Streaming answer element.
 * @property {any} liveThinkingTextEl Live thinking text element.
 * @property {any} liveThinkingDetailsEl Live thinking disclosure element.
 * @property {any} liveThinkingSetExpanded Setter for the live thinking disclosure.
 * @property {any} activityItemEl Activity message container element.
 * @property {any} activityDetailsEl Activity disclosure element.
 * @property {any} activityLabelEl Activity label element.
 * @property {any} messagesEl Message list container element.
 * @property {any} inputEl Composer textarea.
 * @property {any} sendButtonEl Composer send/cancel button.
 * @property {any} imageInputEl Hidden file input for attachments.
 * @property {any} composerBarEl Composer bar element.
 * @property {any} promptQueueEl Queued-prompt container element.
 * @property {any} toolBadgesEl Tool badge container element.
 * @property {any} threadTitleEl Thread title element.
 * @property {any} threadFavoriteEl Thread favorite button.
 * @property {any} containerEl View container element.
 * @property {any} contentEl View content element.
 * @property {any} app Obsidian app instance.
 * @property {any} renderedThreadId Thread id currently rendered.
 * @property {any} runningThreadId Thread id of the run in progress.
 * @property {any} currentRunContextUsage Context usage of the current run.
 * @property {any} pendingActivity Queued activity update, when sticky.
 * @property {any} pendingActivityTimer Timer handle for the pending activity.
 * @property {any} pendingActivityGuard Stale-callback guard for the pending activity.
 * @property {any} activityCoalesceTimer Timer handle for coalesced activity.
 * @property {any} activityCoalesceGuard Stale-callback guard for coalesced activity.
 * @property {any} streamingFlushRaf Frame handle for the streaming flush.
 * @property {any} streamingFlushGuard Stale-callback guard for the streaming flush.
 * @property {any} composerBarCleanup Disconnect handle for the composer-bar observer.
 * @property {boolean} running Whether any run is active for the rendered thread.
 * @property {boolean} canceling Whether the current run is being cancelled.
 * @property {boolean} stickToBottom Whether the message list follows new content.
 * @property {boolean} showingThreadList Whether the thread list replaces the chat.
 * @property {boolean} isRenderingMessages Re-entrancy guard for message rendering.
 * @property {boolean} streamingAnswerDirty Whether the answer element needs a repaint.
 * @property {boolean} streamingThinkingDirty Whether the thinking element needs a repaint.
 * @property {boolean} thinkingDisclosureExpanded Whether thinking is expanded.
 * @property {boolean} thinkingDisclosureUserSet Whether the user toggled thinking.
 * @property {string} activityText Current activity label.
 * @property {string} activityKind Current activity kind.
 * @property {string} activityDetail Current activity detail line.
 * @property {number} activityStickyUntil Timestamp until the activity stays sticky.
 * @property {number} threadGeneration Generation counter for thread switches.
 * @property {number} runGenerationCounter Counter for run generations.
 * @property {string} streamingAssistantContent Accumulated assistant answer text.
 * @property {string} streamingThinkingContent Accumulated thinking text.
 * @property {Set<any>} invalidatedContextThreadIds Threads with invalidated context.
 * @property {Set<any>} steeringPromptIds Prompt ids already steered.
 * @property {Set<any>} desktopNotificationRunIds Runs already notified.
 * @property {Map<any, any>} activeToolCalls Tool calls in flight.
 * @property {Map<any, any>} activeRuns Runs in flight by thread id.
 * @property {Map<any, any>} completedThinkingExpansion Thinking expansion by message key.
 * @property {any[]} promptQueue Local prompt queue.
 * @property {any[]} composerImages Attached images.
 * @property {any[]} composerAttachments Attached text files.
 * @property {any[]} messageRenderComponents Markdown render components to unload.
 * @property {WeakMap<any, any>} messageRenderComponentByElement Components by element.
 *
 * @property {(...args: any[]) => any} getCurrentThreadId
 * @property {(...args: any[]) => any} isCurrentThread
 * @property {(...args: any[]) => any} getCurrentThreadRun
 * @property {(...args: any[]) => any} syncCurrentRunFlags
 * @property {(...args: any[]) => any} setRunningState
 * @property {(...args: any[]) => any} resetTransientRunUiState
 * @property {(...args: any[]) => any} renderMessages
 * @property {(...args: any[]) => any} renderMessage
 * @property {(...args: any[]) => any} renderEmptyState
 * @property {(...args: any[]) => any} restoreMessagesScroll
 * @property {(...args: any[]) => any} renderRoleLabel
 * @property {(...args: any[]) => any} renderThinkingDisclosure
 * @property {(...args: any[]) => any} handleMessageLinkClick
 * @property {(...args: any[]) => any} renderPlainMessageContent
 * @property {(...args: any[]) => any} unloadMessageRenderComponents
 * @property {(...args: any[]) => any} handleRunEvent
 * @property {(...args: any[]) => any} setActivity
 * @property {(...args: any[]) => any} captureContextUsage
 * @property {(...args: any[]) => any} getContextUsageForTokens
 * @property {(...args: any[]) => any} normalizeRunEventType
 * @property {(...args: any[]) => any} trackActiveTool
 * @property {(...args: any[]) => any} untrackActiveTool
 * @property {(...args: any[]) => any} formatActiveToolStatus
 * @property {(...args: any[]) => any} enqueuePrompt
 * @property {(...args: any[]) => any} runNextQueuedPrompt
 * @property {(...args: any[]) => any} removeQueuedPrompt
 * @property {(...args: any[]) => any} retrieveQueuedPrompt
 * @property {(...args: any[]) => any} steerQueuedPrompt
 * @property {(...args: any[]) => any} renderPromptQueue
 * @property {(...args: any[]) => any} renderComposerImages
 * @property {(...args: any[]) => any} resizeInput
 * @property {(...args: any[]) => any} renderThreadList
 * @property {(...args: any[]) => any} renderThreadListRow
 * @property {(...args: any[]) => any} renderThreadMeta
 * @property {(...args: any[]) => any} renderToolBadges
 * @property {(...args: any[]) => any} renderChatView
 * @property {(...args: any[]) => any} renderExtensionWidgets
 * @property {(...args: any[]) => any} parseVaultLinkTarget
 * @property {(...args: any[]) => any} formatVaultLinkTarget
 * @property {(...args: any[]) => any} openVaultLink
 * @property {(...args: any[]) => any} openVaultPath
 * @property {(...args: any[]) => any} runPrompt
 * @property {(...args: any[]) => any} isThreadRunning
 * @property {(...args: any[]) => any} cleanupComposerBarObserver
 * @property {(...args: any[]) => any} startThreadTitleRename
 * @property {(...args: any[]) => any} toggleThreadFavorite
 * @property {(...args: any[]) => any} clearPendingActivityTimer
 * @property {(...args: any[]) => any} flushPendingActivity
 * @property {(...args: any[]) => any} schedulePendingActivity
 * @property {(...args: any[]) => any} applyActivity
 * @property {(...args: any[]) => any} queuePendingActivity
 * @property {(...args: any[]) => any} scheduleCoalescedActivity
 * @property {(...args: any[]) => any} clearCoalescedActivity
 * @property {(...args: any[]) => any} flushCoalescedActivity
 * @property {(...args: any[]) => any} updateActivityDom
 * @property {(...args: any[]) => any} setLiveThinkingExpanded
 * @property {(...args: any[]) => any} scheduleStreamingFlush
 * @property {(...args: any[]) => any} cancelStreamingFlush
 * @property {(...args: any[]) => any} flushStreaming
 * @property {(...args: any[]) => any} finalizeStreamingContent
 * @property {(...args: any[]) => any} appendStreamingDelta
 * @property {(...args: any[]) => any} appendStreamingThinkingDelta
 * @property {(...args: any[]) => any} renderStreamingAssistantMessage
 * @property {(...args: any[]) => any} renderStreamingAnswer
 * @property {(...args: any[]) => any} renderStreamingThinking
 * @property {(...args: any[]) => any} renderActivityMessage
 * @property {(...args: any[]) => any} captureUiCallbackGuard
 * @property {(...args: any[]) => any} isStaleUiCallback
 * @property {(...args: any[]) => any} noteStaleUiCallback
 * @property {(...args: any[]) => any} showThreadList
 * @property {(...args: any[]) => any} showThreadRowMenu
 * @property {(...args: any[]) => any} startThreadListRename
 *
 * @property {(...args: any[]) => any} renderToolErrors
 * @property {(...args: any[]) => any} getLinkSourcePath
 * @property {(...args: any[]) => any} renderPiIcon
 * @property {(...args: any[]) => any} deleteChats
 * @property {(...args: any[]) => any} deleteThreadFromList
 * @property {(...args: any[]) => any} addTextAction
 * @property {(...args: any[]) => any} addAction
 * @property {(...args: any[]) => any} attachmentSummary
 * @property {(...args: any[]) => any} renderQueueAttachments
 * @property {boolean} activityCoalescePending Whether a coalesced activity update is pending.
 *
 * @property {Set<any>} steeringPromptIds
 * @property {Map<any, any>} activeRuns
 * @property {any} currentRunContextUsage
 * @property {any} pendingActivity
 * @property {any} pendingActivityTimer
 * @property {any} streamingItemEl
 * @property {any} streamingTextEl
 * @property {any} liveThinkingSetExpanded
 * @property {(...args: any[]) => any} formatThreadDate
 * @property {(...args: any[]) => any} formatThreadMeta
 * @property {(...args: any[]) => any} [key]
 */

export {};
