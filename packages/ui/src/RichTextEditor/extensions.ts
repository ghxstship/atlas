import { Extension, type Editor, type Range } from "@tiptap/core";
import Mention from "@tiptap/extension-mention";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, {
  type SuggestionKeyDownProps,
  type SuggestionOptions,
  type SuggestionProps,
} from "@tiptap/suggestion";

/**
 * RichTextEditor extensions (RRR-75): `@` mentions, `#` record links, `/` slash commands, tables
 * and checklists, on the Tiptap 3.31.4 pin. Suggestion menus render in React: each trigger reports
 * its open menu through `onMenu`, and the editor component draws the listbox.
 */

export interface SuggestionItem {
  id: string;
  label: string;
  meta?: string;
}

export type SuggestionSource = (query: string) => SuggestionItem[] | Promise<SuggestionItem[]>;

export type MenuKind = "mention" | "record" | "slash";

export interface SuggestionMenu {
  kind: MenuKind;
  items: SuggestionItem[];
  active: number;
  rect: DOMRect | null;
  select: (index: number) => void;
}

export type MenuListener = (menu: SuggestionMenu | null) => void;

export interface SlashCommand extends SuggestionItem {
  run: (editor: Editor, range: Range) => void;
}

/** The slash menu blocks, labeled through the `rte` catalog. */
export function slashCommands(label: (key: string) => string): SlashCommand[] {
  return [
    {
      id: "heading",
      label: label("rte.heading"),
      run: (e, r) => e.chain().focus().deleteRange(r).toggleHeading({ level: 2 }).run(),
    },
    {
      id: "bullets",
      label: label("rte.bullets"),
      run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run(),
    },
    {
      id: "checklist",
      label: label("rte.checklist"),
      run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run(),
    },
    {
      id: "table",
      label: label("rte.table"),
      run: (e, r) =>
        e
          .chain()
          .focus()
          .deleteRange(r)
          .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
          .run(),
    },
    {
      id: "quote",
      label: label("rte.quote"),
      run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run(),
    },
    {
      id: "divider",
      label: label("rte.divider"),
      run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run(),
    },
  ];
}

/** Bridges Tiptap's suggestion lifecycle to a React listener, with arrow, Enter and Escape keys. */
export function menuRenderer<T extends SuggestionItem>(
  kind: MenuKind,
  listen: () => MenuListener,
): NonNullable<SuggestionOptions<T>["render"]> {
  return () => {
    let props: SuggestionProps<T> | null = null;
    let active = 0;
    const publish = () => {
      if (!props) return listen()(null);
      const current = props;
      listen()({
        kind,
        items: current.items,
        active,
        rect: current.clientRect?.() ?? null,
        select: (index) => {
          const item = current.items[index];
          if (item) current.command(item);
        },
      });
    };
    return {
      onStart: (next) => {
        props = next;
        active = 0;
        publish();
      },
      onUpdate: (next) => {
        props = next;
        active = Math.min(active, Math.max(0, next.items.length - 1));
        publish();
      },
      onKeyDown: ({ event }: SuggestionKeyDownProps) => {
        if (!props) return false;
        const count = props.items.length;
        if (event.key === "Escape") {
          props = null;
          publish();
          return true;
        }
        if (count === 0) return false;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          active = (active + (event.key === "ArrowDown" ? 1 : count - 1)) % count;
          publish();
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          const item = props.items[active];
          if (item) props.command(item);
          return true;
        }
        return false;
      },
      onExit: () => {
        props = null;
        publish();
      },
    };
  };
}

async function filtered(source: SuggestionSource, query: string): Promise<SuggestionItem[]> {
  return (await source(query)).slice(0, 8);
}

/** `@` mentions of people; the node keeps the person id and renders `@Name`. */
export function mentionExtension(source: SuggestionSource, listen: () => MenuListener) {
  return Mention.configure({
    HTMLAttributes: { class: "xos-mention" },
    suggestion: {
      char: "@",
      pluginKey: new PluginKey("xosMention"),
      items: ({ query }) => filtered(source, query),
      render: menuRenderer("mention", listen),
    },
  });
}

/** `#` record links; the node keeps the URID and renders a link to the record. */
export function recordLinkExtension(
  source: SuggestionSource,
  href: (urid: string) => string,
  listen: () => MenuListener,
) {
  return Mention.extend({ name: "recordLink" }).configure({
    HTMLAttributes: { class: "xos-record-link" },
    renderHTML: ({ node, options }) => [
      "a",
      {
        ...options.HTMLAttributes,
        href: href(String(node.attrs["id"])),
        "data-urid": node.attrs["id"],
      },
      `#${String(node.attrs["label"] ?? node.attrs["id"])}`,
    ],
    renderText: ({ node }) => `#${String(node.attrs["label"] ?? node.attrs["id"])}`,
    suggestion: {
      char: "#",
      pluginKey: new PluginKey("xosRecordLink"),
      items: ({ query }) => filtered(source, query),
      render: menuRenderer("record", listen),
    },
  });
}

/** `/` slash commands that insert blocks. */
export function slashExtension(commands: SlashCommand[], listen: () => MenuListener) {
  return Extension.create({
    name: "slashCommand",
    addProseMirrorPlugins() {
      return [
        Suggestion<SlashCommand>({
          editor: this.editor,
          char: "/",
          pluginKey: new PluginKey("xosSlash"),
          items: ({ query }) =>
            commands.filter((c) => c.label.toLowerCase().includes(query.toLowerCase())),
          command: ({ editor, range, props }) => props.run(editor, range),
          render: menuRenderer<SlashCommand>("slash", listen),
        }),
      ];
    },
  });
}

/** Tables (with header rows and column resizing off for touch) and nested checklists. */
export function blockExtensions() {
  return [
    TableKit.configure({ table: { resizable: false, HTMLAttributes: { class: "xos-rte-table" } } }),
    TaskList,
    TaskItem.configure({ nested: true }),
  ];
}
