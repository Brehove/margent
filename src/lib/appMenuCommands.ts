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
  formatBlockquote: "margent.format-blockquote",
  formatBold: "margent.format-bold",
  formatBulletList: "margent.format-bullet-list",
  formatCodeBlock: "margent.format-code-block",
  formatHeading1: "margent.format-heading-1",
  formatHeading2: "margent.format-heading-2",
  formatHeading3: "margent.format-heading-3",
  formatHeading4: "margent.format-heading-4",
  formatHorizontalRule: "margent.format-horizontal-rule",
  formatInlineCode: "margent.format-inline-code",
  formatItalic: "margent.format-italic",
  formatOrderedList: "margent.format-ordered-list",
  formatParagraph: "margent.format-paragraph",
  formatStrikethrough: "margent.format-strikethrough",
  formatTaskList: "margent.format-task-list",
  insertFootnote: "margent.insert-footnote",
  insertImage: "margent.insert-image",
  insertTable: "margent.insert-table",
  newFile: "margent.new-file",
  openFile: "margent.open-file",
  openRecent: "margent.open-recent",
  providers: "margent.providers",
  projectSearch: "margent.project-search",
  quickOpen: "margent.quick-open",
  rawMode: "margent.mode-raw",
  renameActiveFile: "margent.rename-active-file",
  renderedMode: "margent.mode-rendered",
  revertLastSnapshot: "margent.revert-last-snapshot",
  revealActiveFile: "margent.reveal-active-file",
  reviewBrief: "margent.review-brief",
  save: "margent.save",
  toggleFocusMode: "margent.toggle-focus-mode",
  toggleFiles: "margent.toggle-files",
  zoomActualSize: "margent.zoom-actual-size",
  zoomIn: "margent.zoom-in",
  zoomOut: "margent.zoom-out",
} as const;

export type AppMenuCommand = (typeof APP_MENU_COMMANDS)[keyof typeof APP_MENU_COMMANDS];

const appMenuCommandValues = new Set<string>(Object.values(APP_MENU_COMMANDS));

export function isAppMenuCommand(value: unknown): value is AppMenuCommand {
  return typeof value === "string" && appMenuCommandValues.has(value);
}

export function dispatchEditorMenuCommand(command: AppMenuCommand) {
  window.dispatchEvent(new CustomEvent<AppMenuCommand>(APP_MENU_DOM_EVENT, { detail: command }));
}
