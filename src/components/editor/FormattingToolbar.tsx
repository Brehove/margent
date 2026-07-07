import { memo } from "react";
import type {
  MarkdownFormattingCommand,
  MarkdownFormattingContext,
} from "./markdownFormatting";
import type { MarkdownTableCommand } from "./markdownTable";

interface FormattingToolbarProps {
  context: MarkdownFormattingContext;
  disabled?: boolean;
  isVisible: boolean;
  onCommand: (command: MarkdownFormattingCommand) => void;
  onImage: () => void;
  onLink: () => void;
  onTableCommand: (command: MarkdownTableCommand) => void;
  onToggleVisible: () => void;
}

export const FormattingToolbar = memo(function FormattingToolbar({
  context,
  disabled = false,
  isVisible,
  onCommand,
  onImage,
  onLink,
  onTableCommand,
  onToggleVisible,
}: FormattingToolbarProps) {
  if (!isVisible) {
    return (
      <div className="formatting-toolbar formatting-toolbar-collapsed">
        <button
          className="format-button"
          onClick={onToggleVisible}
          onMouseDown={(event) => event.preventDefault()}
          title="Show formatting toolbar"
          type="button"
        >
          Format
        </button>
      </div>
    );
  }

  return (
    <div aria-label="Formatting" className="formatting-toolbar" role="toolbar">
      <div className="format-group">
        <FormatButton
          command="bold"
          disabled={disabled || context.inCodeBlock || context.inFrontmatter}
          isPressed={context.bold}
          label="B"
          onCommand={onCommand}
          title="Bold (Cmd+B)"
        />
        <FormatButton
          command="italic"
          disabled={disabled || context.inCodeBlock || context.inFrontmatter}
          isPressed={context.italic}
          label="I"
          onCommand={onCommand}
          title="Italic (Cmd+I)"
        />
        <FormatButton
          command="strikethrough"
          disabled={disabled || context.inCodeBlock || context.inFrontmatter}
          isPressed={context.strikethrough}
          label="S"
          onCommand={onCommand}
          title="Strikethrough"
        />
        <FormatButton
          command="inline-code"
          disabled={disabled || context.inCodeBlock || context.inFrontmatter}
          isPressed={context.inlineCode}
          label="`"
          onCommand={onCommand}
          title="Inline code"
        />
      </div>

      <div className="format-group">
        {[1, 2, 3, 4].map((level) => (
          <FormatButton
            command={`heading-${level}` as MarkdownFormattingCommand}
            disabled={disabled || context.inCodeBlock || context.inFrontmatter || context.inTable}
            isPressed={context.headingLevel === level}
            key={level}
            label={`H${level}`}
            onCommand={onCommand}
            title={`Heading ${level}`}
          />
        ))}
        <FormatButton
          command="paragraph"
          disabled={disabled || context.inCodeBlock || context.inFrontmatter || context.inTable}
          isPressed={context.headingLevel === null}
          label="P"
          onCommand={onCommand}
          title="Paragraph"
        />
      </div>

      <div className="format-group">
        <FormatButton
          command="bullet-list"
          disabled={disabled || context.inCodeBlock || context.inFrontmatter || context.inTable}
          isPressed={context.listType === "bullet"}
          label="-"
          onCommand={onCommand}
          title="Bullet list"
        />
        <FormatButton
          command="ordered-list"
          disabled={disabled || context.inCodeBlock || context.inFrontmatter || context.inTable}
          isPressed={context.listType === "ordered"}
          label="1."
          onCommand={onCommand}
          title="Ordered list"
        />
        <FormatButton
          command="task-list"
          disabled={disabled || context.inCodeBlock || context.inFrontmatter || context.inTable}
          isPressed={context.listType === "task"}
          label="[ ]"
          onCommand={onCommand}
          title="Task list"
        />
        <FormatButton
          command="blockquote"
          disabled={disabled || context.inCodeBlock || context.inFrontmatter || context.inTable}
          isPressed={context.blockquote}
          label=">"
          onCommand={onCommand}
          title="Blockquote"
        />
      </div>

      <div className="format-group">
        <FormatButton
          command="code-block"
          disabled={disabled || context.inFrontmatter}
          label="Code"
          onCommand={onCommand}
          title="Code block"
        />
        <FormatButton
          command="horizontal-rule"
          disabled={disabled}
          label="Rule"
          onCommand={onCommand}
          title="Horizontal rule"
        />
        <FormatButton
          command="footnote"
          disabled={disabled || context.inCodeBlock || context.inFrontmatter}
          label="Fn"
          onCommand={onCommand}
          title="Footnote"
        />
        <FormatButton
          command="table"
          disabled={disabled || context.inCodeBlock || context.inFrontmatter || context.inTable}
          label="Table"
          onCommand={onCommand}
          title={context.inTable ? "Already in a table" : "Insert table"}
        />
      </div>

      <div className="format-group">
        <button
          className="format-button"
          disabled={disabled}
          onClick={onLink}
          onMouseDown={(event) => event.preventDefault()}
          title="Link"
          type="button"
        >
          Link
        </button>
        <button
          className="format-button"
          disabled={disabled}
          onClick={onImage}
          onMouseDown={(event) => event.preventDefault()}
          title="Image"
          type="button"
        >
          Image
        </button>
        <button
          aria-label="Hide formatting toolbar"
          className="format-button"
          onClick={onToggleVisible}
          onMouseDown={(event) => event.preventDefault()}
          title="Hide formatting toolbar"
          type="button"
        >
          Hide
        </button>
      </div>

      <div
        className={`format-group table-format-group${context.inTable ? "" : " is-inactive"}`}
        aria-hidden={!context.inTable}
        aria-label="Table editing"
      >
          <TableButton
            command="row-above"
            disabled={disabled || !context.inTable}
            label="+ Row Above"
            onCommand={onTableCommand}
            title="Insert row above"
          />
          <TableButton
            command="row-below"
            disabled={disabled || !context.inTable}
            label="+ Row Below"
            onCommand={onTableCommand}
            title="Insert row below"
          />
          <TableButton
            command="column-left"
            disabled={disabled || !context.inTable}
            label="+ Col Left"
            onCommand={onTableCommand}
            title="Insert column left"
          />
          <TableButton
            command="column-right"
            disabled={disabled || !context.inTable}
            label="+ Col Right"
            onCommand={onTableCommand}
            title="Insert column right"
          />
          <TableButton
            command="delete-row"
            disabled={disabled || !context.inTable}
            label="Delete Row"
            onCommand={onTableCommand}
            title="Delete row"
          />
          <TableButton
            command="delete-column"
            disabled={disabled || !context.inTable}
            label="Delete Col"
            onCommand={onTableCommand}
            title="Delete column"
          />
          <TableButton
            command="align-left"
            disabled={disabled || !context.inTable}
            label="Left"
            onCommand={onTableCommand}
            title="Align column left"
          />
          <TableButton
            command="align-center"
            disabled={disabled || !context.inTable}
            label="Center"
            onCommand={onTableCommand}
            title="Align column center"
          />
          <TableButton
            command="align-right"
            disabled={disabled || !context.inTable}
            label="Right"
            onCommand={onTableCommand}
            title="Align column right"
          />
          <TableButton
            command="align-none"
            disabled={disabled || !context.inTable}
            label="Align Off"
            onCommand={onTableCommand}
            title="Clear column alignment"
          />
          <TableButton
            command="tidy"
            disabled={disabled || !context.inTable}
            label="Tidy"
            onCommand={onTableCommand}
            title="Tidy table source"
          />
      </div>
    </div>
  );
});

function FormatButton({
  command,
  disabled = false,
  isPressed = false,
  label,
  onCommand,
  title,
}: {
  command: MarkdownFormattingCommand;
  disabled?: boolean;
  isPressed?: boolean;
  label: string;
  onCommand: (command: MarkdownFormattingCommand) => void;
  title: string;
}) {
  return (
    <button
      aria-pressed={isPressed}
      className={isPressed ? "format-button is-active" : "format-button"}
      disabled={disabled}
      onClick={() => onCommand(command)}
      onMouseDown={(event) => event.preventDefault()}
      title={title}
      type="button"
    >
      {label}
    </button>
  );
}

function TableButton({
  command,
  disabled = false,
  label,
  onCommand,
  title,
}: {
  command: MarkdownTableCommand;
  disabled?: boolean;
  label: string;
  onCommand: (command: MarkdownTableCommand) => void;
  title: string;
}) {
  return (
    <button
      className="format-button"
      disabled={disabled}
      onClick={() => onCommand(command)}
      onMouseDown={(event) => event.preventDefault()}
      title={title}
      type="button"
    >
      {label}
    </button>
  );
}
