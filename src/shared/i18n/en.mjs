// English strings are the source of truth. Every other dictionary must expose
// exactly the same keys; tests/i18n.test.mjs enforces that parity.
export default {
  "common.loading": "Loading…",
  "common.loadingThinking": "Loading thinking…",
  "common.cancel": "Cancel",

  "settings.group.advanced": "Advanced",
  "settings.group.piCli": "Pi CLI",
  "settings.group.skills": "Skills",
  "settings.group.context": "Context and file access",

  "settings.model.name": "Model",
  "settings.model.desc":
    "Provider/model from Pi's built-in and custom model registry. Use default to follow ~/.pi/agent/settings.json or .pi/settings.json.",
  "settings.model.chooseTooltip": "Choose model",
  "settings.model.refresh": "Refresh",
  "settings.model.refreshTooltip": "Refresh models from Pi",
  "settings.model.refreshing": "Refreshing...",
  "settings.model.customFallback": "Custom model",
  "settings.model.piDefault": "Pi default",

  "settings.thinking.name": "Thinking level",
  "settings.thinking.desc":
    "Controls reasoning effort only. Values come from the selected model returned by Pi.",
  "settings.thinking.chooseTooltip": "Choose thinking level",

  "settings.toolMode.name": "Tool mode",
  "settings.toolMode.desc":
    "Controls which Pi CLI tools are enabled. Tool modes are not an operating-system sandbox.",

  "settings.desktopNotifications.name": "Desktop completion notifications",
  "settings.desktopNotifications.desc":
    "Notify when an agent run finishes while Obsidian is unfocused.",
  "settings.desktopNotifications.unavailable":
    "Desktop notifications are unavailable or not permitted. You can enable them in your operating-system notification settings.",

  "settings.extensionStatus.name": "Show extension status",
  "settings.extensionStatus.desc":
    "Show status messages reported by Pi extensions in Obsidian's status bar.",

  "settings.customInstructions.name": "Custom instructions",
  "settings.customInstructions.desc": "Vault-specific instructions added to every Pi run.",
  "settings.customInstructions.placeholder": "Prefer PARA folders. Keep project notes concise.",

  "settings.customModel.name": "Custom model slug",
  "settings.customModel.desc":
    "Fallback for a provider/model slug that Pi does not expose in its catalog. Custom slugs are only selectable here.",
  "settings.customModel.placeholder": "Provider/model",
  "settings.customModel.use": "Use custom",
  "settings.customModel.using": "Using custom",

  "settings.piExecutable.name": "Pi executable path",
  "settings.piExecutable.desc":
    "Optional path to the Pi CLI. Leave empty to auto-detect common install locations. Supports ~ and environment variables like ${USER}.",

  "settings.checkInstall.name": "Check Pi installation",
  "settings.checkInstall.desc":
    "Verify that Obsidian can run the Pi CLI from its current environment.",
  "settings.checkInstall.button": "Check",

  "settings.defaultSkills.name": "Include default Pi skills",
  "settings.defaultSkills.desc":
    "Load skills discovered by Pi from global and vault/project skill locations. Turn this off to use only the additional skill folders below.",

  "settings.skillFolders.name": "Additional skill folders",
  "settings.skillFolders.desc":
    "One trusted skill file or folder per line. Supports absolute and vault-relative paths.",

  "settings.ignoredFolders.name": "Ignored folders/directories",
  "settings.ignoredFolders.desc":
    "Comma-separated folder prefixes that Pi pre-attached context and retrieval should ignore.",

  "toolMode.chat.primary": "Chat",
  "toolMode.chat.secondary": "no Pi CLI tools",
  "toolMode.readOnly.primary": "Review",
  "toolMode.readOnly.secondary": "read/search/list only",
  "toolMode.edit.primary": "Edit",
  "toolMode.edit.secondary": "edit/write, no shell",
  "toolMode.fullAgent.primary": "Full agent",
  "toolMode.fullAgent.secondary": "edit/write and shell",

  "reasoning.automatic": "Automatic",
  "reasoning.off": "Off",
  "reasoning.minimal": "Minimal - may be unavailable with tools",
  "reasoning.minimal.short": "Minimal",
  "reasoning.low": "Low",
  "reasoning.medium": "Medium",
  "reasoning.high": "High",
  "reasoning.xhigh": "XHigh",
  "reasoning.max": "Max - deepest",
  "reasoning.max.short": "Max",

  "modelPicker.empty": "No Pi models match this search.",
  "modelPicker.placeholder": "Search models by name, provider, slug, or capability…",
  "thinkingPicker.empty": "Pi did not resolve thinking levels for this model.",
  "thinkingPicker.placeholder": "Choose thinking level…",
  "picker.navigate": "navigate",
  "picker.select": "select",
  "picker.close": "close",
  "picker.selected": "selected",
  "picker.effectiveFor": "Effective for {model}",

  "confirm.writeTools.title": "Enable write tools?",
  "confirm.writeTools.message":
    "Pi tool modes are not an operating-system sandbox. Edit and full agent can modify vault/project files, and full agent can run shell commands.",
  "confirm.writeTools.confirm": "Enable tools",

  "setup.heading": "Set up Pi CLI",
  "setup.missing": "Pi Agent needs the Pi CLI before it can run prompts.",
  "setup.needsNode":
    "Install Node.js or make your Node version manager available to GUI apps, then fully restart Obsidian. After that, run pi --version in a terminal to confirm Pi still works.",
  "setup.installSteps":
    "Install Pi in a terminal, authenticate it if needed, then restart Obsidian so it can pick up your updated PATH.",
  "setup.modeHint":
    "Start in chat or review mode. Only enable edit or full agent in vaults you are comfortable letting Pi modify.",
  "setup.copyDiagnostic": "Copy diagnostic commands",
  "setup.copyInstall": "Copy install command",
  "setup.copiedDiagnostic": "Copied diagnostic commands.",
  "setup.copiedInstall": "Copied Pi install command.",
  "setup.dismiss": "Do not show again",
  "setup.close": "Close",

  "notice.cliAvailable": "Pi CLI is available: {version}",
  "notice.modelsLoaded": "Loaded {count} Pi models; default {model}.",

  "send.send": "Send",
  "send.sendAria": "Send message",
  "send.queue": "Queue",
  "send.queueAria": "Queue message",
  "send.cancel": "Cancel",
  "send.cancelAria": "Cancel agent run",
  "send.canceling": "Canceling",
  "send.cancelingAria": "Canceling agent run",
  "send.queued.one": "{count} queued.",
  "send.queued.other": "{count} queued.",

  "view.renameChat": "Rename chat",
  "view.newChat": "New chat",
  "view.forkChat": "Fork chat",
  "view.manageThreads": "Manage chat threads",
  "view.favoriteAdd": "Mark as favorite",
  "view.favoriteRemove": "Remove favorite",
  "view.chatTitle": "Chat title",
  "view.forkBusy": "Wait for this chat's agent run to finish before forking it.",
  "view.threadMissing": "Chat thread was not found.",
  "view.nothingToFork": "Nothing to fork yet.",

  "composer.placeholder": "Ask the agent about your vault... Enter sends, Shift+Enter adds a line.",
  "composer.attach": "Attach files",
  "composer.vaultFile": "Vault file",
  "composer.localFile": "Local file",
  "composer.chooseFile": "Choose a vault image, text, code, or config file…",

  "runSettings.toolMode": "Tool mode",
  "toolModePicker.empty": "No tool modes available.",
  "toolModePicker.placeholder": "Choose tool mode…",

  "thread.defaultTitle": "New chat",
  "thread.forkTitle": "{title} (fork)",

  "threadList.back": "Back to chat",
  "threadList.title": "Threads",
  "threadList.count.one": "{count} chat",
  "threadList.count.other": "{count} chats",
  "threadList.newChat": "New chat",
  "threadList.deleteChats": "Delete chats",
  "threadList.empty": "No chat threads.",
  "threadList.openChat": "Open chat",
  "threadList.running": "Agent is running in this chat",
  "threadList.deleteChat": "Delete chat",
  "threadList.actions": "Thread actions",
  "threadList.meta.one": "{count} message • Updated {date}",
  "threadList.meta.other": "{count} messages • Updated {date}",
  "threadList.current": "Current",
  "threadList.currentMeta": "Current • {meta}",
  "threadList.unknownDate": "unknown date",
  "threadList.currentChat": "Current chat",
  "threadList.open": "Open",
  "threadList.rename": "Rename",
  "threadList.sessionInfo": "{brand} session info",
  "threadList.exportSession": "Export {brand} session to HTML",
  "threadList.delete": "Delete",
  "threadList.deleteBlocked": "Wait for active agent runs to finish before deleting chats.",
  "threadList.deleteNothing": "There are no chats to delete.",
  "threadList.deleteRunning": "Wait for the agent run to finish before deleting this chat.",
  "threadList.deletedBoth": "Chat and local Pi session deleted.",
  "threadList.deletedChat": "Chat deleted.",
  "threadList.deleteFailed": "Chat or local Pi session could not be deleted.",

  "deleteThreads.title": "Delete chats?",
  "deleteThreads.message":
    "Choose which chat history to delete. Local Pi session files will be kept.",
  "deleteThreads.favorite.one": "{count} favorite chat is protected by the first option.",
  "deleteThreads.favorite.other": "{count} favorite chats are protected by the first option.",
  "deleteThreads.skipped.one":
    "{count} active chat cannot be deleted until the agent run finishes.",
  "deleteThreads.skipped.other":
    "{count} active chats cannot be deleted until the agent run finishes.",
  "deleteThreads.exceptFavorites": "Delete all except favorites ({count})",
  "deleteThreads.all": "Delete all chats ({count})",
  "deleteThreads.result.deleted.one": "{count} chat deleted",
  "deleteThreads.result.deleted.other": "{count} chats deleted",
  "deleteThreads.result.skipped.one": "{count} active chat was skipped",
  "deleteThreads.result.skipped.other": "{count} active chats were skipped",
  "deleteThreads.result.created": "a new empty chat was created",
  "deleteThreads.result.sep": "; ",
  "deleteThreads.result.tail": ". ",
  "deleteThreads.result.suffix": "Local Pi sessions were kept.",

  "deleteThread.title": "Delete chat?",
  "deleteThread.keepSession":
    "Choose whether to keep or delete the local Pi session for “{title}”.",
  "deleteThread.remove": "Delete “{title}” from plugin history?",
  "deleteThread.chatOnly": "Delete chat only",
  "deleteThread.both": "Delete chat and local Pi session"
};
