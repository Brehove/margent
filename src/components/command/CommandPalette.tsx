import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DocumentSummary } from "../../types/workspace";

export type CommandPaletteMode = "commands" | "files";

export interface CommandPaletteCommand {
  detail?: string;
  disabled?: boolean;
  id: string;
  label: string;
  keywords?: string[];
}

interface CommandPaletteProps {
  activeRelativePath: string | null;
  commands: CommandPaletteCommand[];
  documents: DocumentSummary[];
  mode: CommandPaletteMode;
  onClose: () => void;
  onSelectCommand: (commandId: string) => void;
  onSelectDocument: (relativePath: string) => void;
}

interface PaletteEntry {
  detail?: string;
  disabled?: boolean;
  id: string;
  keywords?: string[];
  kind: CommandPaletteMode;
  label: string;
  relativePath?: string;
}

export function filterCommandPaletteEntries<T extends { detail?: string; keywords?: string[]; label: string }>(
  entries: T[],
  query: string,
) {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  if (terms.length === 0) {
    return entries;
  }

  return entries
    .map((entry) => {
      const haystack = [entry.label, entry.detail, ...(entry.keywords ?? [])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const matches = terms.every((term) => haystack.includes(term));
      if (!matches) {
        return null;
      }

      const score = terms.reduce((total, term) => {
        const label = entry.label.toLowerCase();
        if (label.startsWith(term)) {
          return total + 4;
        }
        if (label.includes(` ${term}`)) {
          return total + 3;
        }
        if (haystack.includes(`/${term}`) || haystack.includes(` ${term}`)) {
          return total + 2;
        }
        return total + 1;
      }, 0);

      return { entry, score };
    })
    .filter((result): result is { entry: T; score: number } => result !== null)
    .sort((left, right) => right.score - left.score || left.entry.label.localeCompare(right.entry.label))
    .map((result) => result.entry);
}

export const CommandPalette = memo(function CommandPalette({
  activeRelativePath,
  commands,
  documents,
  mode,
  onClose,
  onSelectCommand,
  onSelectDocument,
}: CommandPaletteProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const activeItemRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const entries = useMemo(() => {
    const rawEntries: PaletteEntry[] =
      mode === "files"
        ? documents.map((document) => ({
            detail: document.relativePath,
            disabled: false,
            id: document.relativePath,
            kind: "files",
            keywords: [document.displayName, document.relativePath],
            label: document.displayName,
            relativePath: document.relativePath,
          }))
        : commands.map((command) => ({
            detail: command.detail,
            disabled: command.disabled,
            id: command.id,
            kind: "commands",
            keywords: command.keywords,
            label: command.label,
          }));

    return filterCommandPaletteEntries(rawEntries, query);
  }, [commands, documents, mode, query]);

  useEffect(() => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();

    return () => {
      previousFocusRef.current?.focus();
    };
  }, []);

  useEffect(() => {
    setActiveIndex(0);
  }, [mode, query]);

  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, entries.length]);

  const selectEntry = useCallback(
    (entry: PaletteEntry) => {
      if (entry.disabled) {
        return;
      }

      if (entry.kind === "files" && entry.relativePath) {
        onSelectDocument(entry.relativePath);
      } else if (entry.kind === "commands") {
        onSelectCommand(entry.id);
      }
      onClose();
    },
    [onClose, onSelectCommand, onSelectDocument],
  );

  const handleDialogKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) {
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  const activeEntry = entries[Math.min(activeIndex, Math.max(entries.length - 1, 0))] ?? null;

  return (
    <div className="command-palette-backdrop" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        aria-label={mode === "files" ? "Quick open" : "Command palette"}
        aria-modal="true"
        className="command-palette"
        onKeyDown={handleDialogKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="command-palette-input-row">
          <span className="command-palette-mode">{mode === "files" ? "Files" : "Commands"}</span>
          <input
            ref={inputRef}
            aria-label={mode === "files" ? "Search files" : "Search commands"}
            className="command-palette-input"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex((current) =>
                  entries.length === 0 ? 0 : Math.min(current + 1, entries.length - 1),
                );
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((current) => Math.max(current - 1, 0));
                return;
              }
              if (event.key === "Enter" && activeEntry) {
                event.preventDefault();
                selectEntry(activeEntry);
              }
            }}
            placeholder={mode === "files" ? "Search files" : "Search commands"}
            type="search"
            value={query}
          />
        </div>

        <div className="command-palette-list" role="listbox">
          {entries.length === 0 ? (
            <div className="command-palette-empty">No matches</div>
          ) : (
            entries.map((entry, index) => {
              const isActive = index === activeIndex;
              const isCurrentFile = mode === "files" && entry.relativePath === activeRelativePath;
              return (
                <button
                  aria-selected={isActive}
                  className={`command-palette-item ${isActive ? "is-active" : ""} ${
                    isCurrentFile ? "is-current" : ""
                  }`}
                  disabled={entry.disabled}
                  key={`${entry.kind}:${entry.id}`}
                  onClick={() => selectEntry(entry)}
                  onMouseEnter={() => setActiveIndex(index)}
                  ref={isActive ? activeItemRef : undefined}
                  role="option"
                  type="button"
                >
                  <span className="command-palette-item-label">{entry.label}</span>
                  {entry.detail ? (
                    <span className="command-palette-item-detail">{entry.detail}</span>
                  ) : null}
                </button>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
});
