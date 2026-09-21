import { STRINGS } from "../shared/strings.mjs";

export function getSendActionState({ running, canceling, hasInput, queuedCount = 0 }) {
  if (canceling) {
    return {
      state: "canceling",
      icon: "loader",
      label: STRINGS.sendState.canceling,
      ariaLabel: STRINGS.sendState.cancelingAria,
      disabled: true
    };
  }

  if (running && hasInput) {
    return {
      state: "queue",
      icon: "list-plus",
      label: STRINGS.sendState.queue,
      ariaLabel: STRINGS.sendState.queueAria,
      disabled: false
    };
  }

  if (running) {
    return {
      state: "cancel",
      icon: "square",
      label: STRINGS.sendState.cancel,
      ariaLabel: STRINGS.sendState.cancelAria,
      disabled: false
    };
  }

  return {
    state: "send",
    icon: "send",
    label: STRINGS.view.send,
    ariaLabel: STRINGS.view.sendMessage,
    disabled: false,
    titleSuffix: queuedCount > 0 ? STRINGS.sendState.queuedSuffix(queuedCount) : ""
  };
}
