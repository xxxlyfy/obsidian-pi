/**
 * The surface the chat view exposes to its mixin modules.
 *
 * `PiAgentView` is assembled from several modules that share one object through
 * `this` (see `PiAgentView.mjs`). Documenting that shared shape here gives those
 * modules a name to type against, so a misspelled field or method is caught by
 * `npm run typecheck` instead of at runtime inside a stream callback.
 *
 * The description is closed on purpose. `PiAgentView` uses it as the type of the
 * class it extends (see the `ComposedItemView` typedef in `PiAgentView.mjs`), so
 * every member of the composed view must be named here: a misspelled or missing
 * member is a `npm run typecheck` error instead of a silent `undefined`. An
 * index signature would turn that check back into a no-op, which is why there is
 * none. (The `[key]` entry this file used to carry was not one: in a `@property`
 * list, brackets mark an *optional* property, so it declared an optional
 * property literally named `key` and never acted as a fallback. It was removed
 * as dead weight -- nothing was relying on it.)
 *
 * Members are described as function-typed properties rather than with method
 * syntax because that is all a `@typedef {object}` property list can express.
 * A class cannot override a base *property* with a *method* (ts2425), so the
 * handful of members `PiAgentView` declares in its own body are subtracted from
 * this surface there -- see `PiAgentViewOwnMember`.
 *
 * Transient state is no longer part of this surface: it lives on `this.state`
 * and is described once by `ViewState` in `./view-state.mjs`.
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
 * @property {any} extensionWidgetsAboveEl Widget container above the composer.
 * @property {any} extensionWidgetsBelowEl Widget container below the composer.
 * @property {HTMLElement} containerEl View container element.
 * @property {any} contentEl View content element.
 * @property {any} app Obsidian app instance.
 * @property {any} renderedThreadId Thread id currently rendered.
 * @property {any} runningThreadId Thread id of the run in progress.
 *
 * Transient state is one object, described once in `./view-state.mjs`; the
 * mixins reach it through `this.state.<field>` rather than through fields spread
 * across the instance, so there is a single definition of each field and its
 * type.
 *
 * @property {import("./view-state.mjs").ViewState} state Transient view state.
 *
 * @property {import("./lifecycle.mjs").ViewLifecycle} lifecycle Timers and cleanup handles owned by this view.
 * @property {any} composerBarCleanup Release handle for the composer-bar observer.
 * @property {boolean} showingThreadList Whether the thread list replaces the chat.
 * @property {(...args: any[]) => any} releaseStreamingFlushCleanup
 * @property {(...args: any[]) => any} cleanupComposerBarObserver
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
 * @property {(...args: any[]) => any} renderPendingBadge
 * @property {(...args: any[]) => any} renderToolBadgesContextUsage
 * @property {(...args: any[]) => any} renderThreadTitle
 * @property {(...args: any[]) => any} renderThreadFavorite
 * @property {(...args: any[]) => any} startThreadTitleRename
 * @property {(...args: any[]) => any} renderImagePicker
 * @property {(...args: any[]) => any} updateComposerBarMode
 * @property {(...args: any[]) => any} setRunningState
 * @property {(...args: any[]) => any} showAttachmentMenu
 * @property {(...args: any[]) => any} getDisplayedContextUsage
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
 * @property {(...args: any[]) => any} showAttachmentMenu
 * @property {(...args: any[]) => any} showVaultFilePicker
 * @property {(...args: any[]) => any} isAttachableFile
 * @property {(...args: any[]) => any} getImageFiles
 * @property {(...args: any[]) => any} addLocalFiles
 * @property {(...args: any[]) => any} addVaultFile
 * @property {(...args: any[]) => any} addImageFiles
 * @property {(...args: any[]) => any} handleImagePaste
 * @property {(...args: any[]) => any} handleImageDrop
 *
 * @property {any} streamingItemEl
 * @property {any} streamingTextEl
 * @property {any} liveThinkingSetExpanded
 * @property {(...args: any[]) => any} formatThreadDate
 * @property {(...args: any[]) => any} formatThreadMeta
 */

export {};
