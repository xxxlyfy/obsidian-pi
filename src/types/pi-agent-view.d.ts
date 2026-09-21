import type {} from "../ui/PiAgentView.mjs";

declare module "../ui/PiAgentView.mjs" {
  interface PiAgentView {
    activeWindow?: Window & typeof globalThis;
    activityItemEl?: HTMLElement;
    activityDetailsEl?: HTMLElement;
    activityLabelEl?: HTMLElement;
    liveThinkingDetailsEl?: HTMLElement;
    liveThinkingTextEl?: HTMLElement;
    liveThinkingSetExpanded?: (expanded: boolean) => void;
    renderMessages(): void;
    restoreMessagesScroll(
      messagesEl: HTMLElement,
      stickToBottom: boolean,
      previousScrollTop: number
    ): void;
    renderEmptyState(): void;
    renderMessage(message: any, index: number): void;
    renderToolErrors(container: HTMLElement, errors: any): void;
    renderThinkingDisclosure(...args: any[]): any;
    handleMessageLinkClick(event: any): boolean;
    renderPlainMessageContent(container: HTMLElement, content: string): any;
    unloadMessageRenderComponents(): void;
    renderStreamingAssistantMessage(): void;
    renderStreamingAnswer(): void;
    renderStreamingThinking(): void;
    scheduleStreamingRender(): void;
    flushStreamingRender(): void;
    clearStreamingRenderTimer(): void;
    renderActivityMessage(): void;
    renderRoleLabel(parent: HTMLElement, role: string, message?: any, index?: number): void;
    setActivity(text: string, kind: string, detail?: string): void;
    applyActivity(text: string, kind: string, detail?: string, stickyUntil?: number): void;
    queuePendingActivity(text: string, kind: string, detail?: string): void;
    schedulePendingActivity(): void;
    clearPendingActivityTimer(): void;
    flushPendingActivity(): void;
    updateActivityDom(): boolean;
    captureContextUsage(event: any, threadId?: string): void;
    syncRunActivity(threadId?: string): void;
    syncRunContextUsage(threadId?: string): void;
    getContextUsageForTokens(tokenUsage: any): any;
    handleRunEvent(event: any, threadId?: string): void;
    normalizeRunEventType(type: string): string;
    trackActiveTool(event: any, toolCalls?: Map<string, any>): void;
    untrackActiveTool(event: any, toolCalls?: Map<string, any>): void;
    formatActiveToolStatus(): { label: string; kind: string; detail: string };
    showThreadList(): void;
    renderThreadList(): void;
    renderThreadListRow(listEl: HTMLElement, thread: any, isCurrent: boolean): void;
    deleteChats(): Promise<void>;
    showThreadRowMenu(event: any, thread: any, isCurrent: boolean, titleEl: HTMLElement): void;
    startThreadListRename(thread: any, titleEl: HTMLElement): void;
    toggleThreadFavorite(thread: any): void;
    deleteThreadFromList(thread: any): Promise<void>;
    formatThreadMeta(thread: any, isCurrent: boolean): string;
    countSessionEntries(nodes: any[]): number;
    formatThreadDate(value: any): string;
    enqueuePrompt(
      prompt: string,
      threadId?: string,
      images?: any[],
      attachments?: any[],
      annotations?: any[],
      contextFilePath?: string,
      includeActiveNote?: boolean
    ): void;
    runNextQueuedPrompt(): void;
    removeQueuedPrompt(id: string): void;
    retrieveQueuedPrompt(id: string): void;
    steerQueuedPrompt(id: string): Promise<void>;
    renderPromptQueue(): void;
    classifyVaultLinkTarget(value: string): import("../ui/vault-link-actions.mjs").VaultLinkTarget;
    openVaultLink(value: string, newLeaf?: boolean): Promise<void>;
    parseVaultLinkTarget(value: string): any;
    formatVaultLinkTarget(target: any): string;
    getLinkLabel(value: string): string;
    getLinkSourcePath(): string;
    revealLine(leaf: any, line: number): void;
    openVaultPath(value: string, newLeaf?: boolean | string): Promise<void>;
  }
}
