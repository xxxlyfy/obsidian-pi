import { t, tCount } from "../shared/i18n/index.mjs";

export function getSendActionState({ running, canceling, hasInput, queuedCount = 0 }) {
  if (canceling) {
    return {
      state: "canceling",
      icon: "loader",
      label: t("send.canceling"),
      ariaLabel: t("send.cancelingAria"),
      disabled: true
    };
  }

  if (running && hasInput) {
    return {
      state: "queue",
      icon: "list-plus",
      label: t("send.queue"),
      ariaLabel: t("send.queueAria"),
      disabled: false
    };
  }

  if (running) {
    return {
      state: "cancel",
      icon: "square",
      label: t("send.cancel"),
      ariaLabel: t("send.cancelAria"),
      disabled: false
    };
  }

  return {
    state: "send",
    icon: "send",
    label: t("send.send"),
    ariaLabel: t("send.sendAria"),
    disabled: false,
    titleSuffix: queuedCount > 0 ? tCount("send.queued", queuedCount) : ""
  };
}
