export const APP_MENU_COMMAND_EVENT = "margent://menu-command";
export const APP_MENU_DOM_EVENT = "margent-menu-command";

export const APP_MENU_COMMANDS = {
  checkForUpdates: "margent.check-for-updates",
  commandPalette: "margent.command-palette",
  deleteActiveFile: "margent.delete-active-file",
  exportDocx: "margent.export-docx",
  exportGdoc: "margent.export-gdoc",
  exportHtml: "margent.export-html",
  exportPdf: "margent.export-pdf",
  find: "margent.find",
  newFile: "margent.new-file",
  openFile: "margent.open-file",
  openRecent: "margent.open-recent",
  providers: "margent.providers",
  projectSearch: "margent.project-search",
  quickOpen: "margent.quick-open",
  rawMode: "margent.mode-raw",
  renameActiveFile: "margent.rename-active-file",
  renderedMode: "margent.mode-rendered",
  revealActiveFile: "margent.reveal-active-file",
  reviewBrief: "margent.review-brief",
  save: "margent.save",
  toggleFocusMode: "margent.toggle-focus-mode",
  toggleFiles: "margent.toggle-files",
} as const;

export type AppMenuCommand = (typeof APP_MENU_COMMANDS)[keyof typeof APP_MENU_COMMANDS];

const appMenuCommandValues = new Set<string>(Object.values(APP_MENU_COMMANDS));

export function isAppMenuCommand(value: unknown): value is AppMenuCommand {
  return typeof value === "string" && appMenuCommandValues.has(value);
}

export function dispatchEditorMenuCommand(command: AppMenuCommand) {
  window.dispatchEvent(new CustomEvent<AppMenuCommand>(APP_MENU_DOM_EVENT, { detail: command }));
}
