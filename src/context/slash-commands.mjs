import { STRINGS } from "../shared/strings.mjs";
export const BUILTIN_SLASH_COMMANDS = [
  {
    command: "/current",
    label: STRINGS.commands.currentLabel,
    detail: STRINGS.commands.currentDetail,
    insertText: "/current ",
    implemented: true
  },
  {
    command: "/backlinks",
    label: STRINGS.commands.backlinksLabel,
    detail: STRINGS.commands.backlinksDetail,
    insertText: "/backlinks ",
    implemented: true
  },
  {
    command: "/links",
    label: STRINGS.commands.linksLabel,
    detail: STRINGS.commands.linksDetail,
    insertText: "/links ",
    implemented: true
  },
  {
    command: "/search",
    label: STRINGS.commands.searchLabel,
    detail: STRINGS.commands.searchDetail,
    insertText: "/search ",
    argumentHint: "query",
    implemented: true
  },
  {
    command: "/compact",
    label: STRINGS.commands.compactLabel,
    detail: STRINGS.commands.compactDetail,
    insertText: "/compact ",
    argumentHint: "instructions",
    implemented: true
  },
  {
    command: "/context show",
    label: STRINGS.commands.contextShowLabel,
    detail: STRINGS.commands.contextShowDetail,
    insertText: "/context show ",
    implemented: true
  }
];

export function getSlashCommands(piCommands = []) {
  const builtins = BUILTIN_SLASH_COMMANDS.map((command) => ({ ...command, source: "obsidian" }));
  const builtinNames = new Set(builtins.map((command) => command.command));
  return [...builtins, ...piCommands.filter((command) => !builtinNames.has(command.command))];
}
