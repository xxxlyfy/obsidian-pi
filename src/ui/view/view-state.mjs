/**
 * The chat view's transient state: everything the view and its mixins mutate
 * while a chat is open, as opposed to settings (persisted) or thread history
 * (owned by ThreadStore).
 *
 * It lives in one place for two reasons. First, `PiAgentView`'s constructor used
 * to initialize thirty fields inline, so "what state does this view have" could
 * only be answered by reading it. Second, the mixins document the shape they
 * share through `PiAgentViewSurface`; naming the fields here means a misspelled
 * field or a wrong value type is a checkJs error instead of a runtime surprise
 * inside a stream callback.
 *
 * @typedef {object} ViewState
 * @property {boolean} running Whether any run is active for the rendered thread.
 * @property {boolean} canceling Whether the current run is being cancelled.
 * @property {string} activityText Current activity label.
 * @property {string} activityKind Current activity kind, such as "thinking".
 * @property {string} activityDetail Current activity detail line.
 * @property {number} activityStickyUntil Timestamp until the activity stays sticky.
 * @property {any} pendingActivity Queued activity update, when the sticky window is open.
 * @property {any} pendingActivityTimer Timer handle for the pending activity.
 * @property {any} pendingActivityGuard Stale-callback guard for the pending activity.
 * @property {boolean} isRenderingMessages Re-entrancy guard for message rendering.
 * @property {Map<any, any>} activeToolCalls Tool calls in flight, keyed by tool key.
 * @property {any} currentRunContextUsage Context usage of the current run.
 * @property {Set<any>} invalidatedContextThreadIds Threads whose context usage went stale.
 * @property {string} streamingAssistantContent Accumulated assistant answer text.
 * @property {string} streamingThinkingContent Accumulated thinking text.
 * @property {boolean} streamingAnswerDirty Whether the answer element needs a repaint.
 * @property {boolean} streamingThinkingDirty Whether the thinking element needs a repaint.
 * @property {any} streamingFlushRaf Frame handle for the streaming flush.
 * @property {any} streamingFlushGuard Stale-callback guard for the streaming flush.
 * @property {any} streamingFlushCleanup Release handle for the streaming frame's cleanup.
 * @property {any} activityCoalesceTimer Timer handle for coalesced activity.
 * @property {any} activityCoalesceGuard Stale-callback guard for coalesced activity.
 * @property {boolean} activityCoalescePending Whether a coalesced update is waiting.
 * @property {number} runGenerationCounter Counter used to detect stale run callbacks.
 * @property {number} threadGeneration Counter used to detect stale thread callbacks.
 * @property {any[]} promptQueue Local prompt queue awaiting delivery.
 * @property {any[]} composerImages Attached images.
 * @property {any[]} composerAttachments Attached text files.
 * @property {any} nativePiQueue Queue reported by Pi itself, when available.
 * @property {Set<any>} steeringPromptIds Prompt ids already steered into a run.
 * @property {boolean} thinkingDisclosureExpanded Whether thinking is expanded.
 * @property {boolean} thinkingDisclosureUserSet Whether the user chose the thinking state.
 * @property {Map<any, any>} completedThinkingExpansion Thinking expansion by message key.
 * @property {any[]} messageRenderComponents Markdown render components to unload.
 * @property {WeakMap<any, any>} messageRenderComponentByElement Components by element.
 * @property {Map<any, any>} activeRuns Runs in flight, keyed by thread id.
 * @property {Set<any>} desktopNotificationRunIds Runs already notified on the desktop.
 * @property {number} nextDesktopNotificationRunId Counter for notification run ids.
 * @property {boolean} stickToBottom Whether the message list follows new content.
 */

/**
 * Build the initial state for one chat view.
 *
 * @param {any} plugin Backing plugin instance, used for the persisted prompt queue.
 * @returns {ViewState}
 */
export function createViewState(plugin) {
  return {
    running: false,
    canceling: false,
    activityText: "Thinking",
    activityKind: "thinking",
    activityDetail: "",
    activityStickyUntil: 0,
    pendingActivity: undefined,
    pendingActivityTimer: undefined,
    pendingActivityGuard: undefined,
    isRenderingMessages: false,
    activeToolCalls: new Map(),
    currentRunContextUsage: undefined,
    invalidatedContextThreadIds: new Set(),
    streamingAssistantContent: "",
    streamingThinkingContent: "",
    streamingAnswerDirty: false,
    streamingThinkingDirty: false,
    streamingFlushRaf: undefined,
    streamingFlushGuard: undefined,
    streamingFlushCleanup: undefined,
    activityCoalesceTimer: undefined,
    activityCoalesceGuard: undefined,
    activityCoalescePending: false,
    runGenerationCounter: 0,
    threadGeneration: 0,
    promptQueue: plugin.getLocalPromptQueue(),
    composerImages: [],
    composerAttachments: [],
    nativePiQueue: undefined,
    steeringPromptIds: new Set(),
    thinkingDisclosureExpanded: false,
    thinkingDisclosureUserSet: false,
    completedThinkingExpansion: new Map(),
    messageRenderComponents: [],
    messageRenderComponentByElement: new WeakMap(),
    activeRuns: new Map(),
    desktopNotificationRunIds: new Set(),
    nextDesktopNotificationRunId: 1,
    stickToBottom: true
  };
}
