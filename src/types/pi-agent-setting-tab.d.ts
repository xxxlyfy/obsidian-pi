import type {} from "../plugin/settings-tab.mjs";

declare module "../plugin/settings-tab.mjs" {
  interface PiAgentSettingTab {
    update?(): void;
  }
}
