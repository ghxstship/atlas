import { useId, useMemo, useRef, useState, type ReactElement } from "react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { iconButtonClass } from "../Button/Button.tsx";
import {
  blockExtensions,
  mentionExtension,
  recordLinkExtension,
  slashCommands,
  slashExtension,
  type MenuListener,
  type SuggestionMenu,
} from "../RichTextEditor/extensions.ts";
import { type RichTextEditorProps } from "./Media.types.ts";

/**
 * A document editor on Tiptap with an accessible formatting toolbar (Cmd or Ctrl+B and +I), `/`
 * blocks, `@` mentions, `#` record links, tables and checklists and, with `ydoc`, live co-editing
 * through Yjs.
 */
export function RichTextEditor({
  label,
  html,
  presence,
  ydoc,
  provider,
  onChange,
  onRequestLink,
  editable = true,
  mentions,
  records,
  recordHref = (urid) => `/r/${encodeURIComponent(urid)}`,
}: RichTextEditorProps): ReactElement {
  const t = useT();
  const [menu, setMenu] = useState<SuggestionMenu | null>(null);
  const listener = useRef<MenuListener>(setMenu);
  listener.current = setMenu;
  const listen = () => listener.current;
  const menuId = useId();
  const extensions = useMemo(
    () => [
      ...(ydoc
        ? [
            StarterKit.configure({ undoRedo: false, link: { openOnClick: false } }),
            Collaboration.configure({ document: ydoc, ...(provider ? { provider } : {}) }),
          ]
        : [StarterKit.configure({ link: { openOnClick: false } })]),
      ...blockExtensions(),
      slashExtension(slashCommands(t), listen),
      ...(mentions ? [mentionExtension(mentions, listen)] : []),
      ...(records ? [recordLinkExtension(records, recordHref, listen)] : []),
    ],
    // The editor is created once; later prop changes do not rebuild its schema.
    [],
  );
  const editor = useEditor({
    extensions,
    ...(ydoc ? {} : { content: html }),
    editable,
    immediatelyRender: true,
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": label,
        class: cx(
          "min-h-(--space-64) px-16 py-12 outline-none text-text-14 leading-relaxed [&_ul]:ps-20 [&_ol]:ps-20 [&_a]:text-accent-text [&_a]:underline",
          "[&_.xos-mention]:text-accent-text [&_.xos-mention]:font-medium [&_ul[data-type=taskList]]:ps-0 [&_ul[data-type=taskList]]:list-none [&_li[data-type=taskItem]]:flex [&_li[data-type=taskItem]]:gap-8",
          "[&_table]:border-collapse [&_td]:border [&_td]:border-border-subtle [&_td]:p-6 [&_th]:border [&_th]:border-border-subtle [&_th]:p-6 [&_th]:bg-bg-hover [&_th]:text-start [&_blockquote]:ps-12 [&_blockquote]:border-s-stroke-accent [&_blockquote]:border-border-strong",
        ),
      },
    },
    onUpdate: ({ editor: e }) => onChange?.(e.getHTML()),
  });
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e?.isActive("bold") ?? false,
      italic: e?.isActive("italic") ?? false,
      bullets: e?.isActive("bulletList") ?? false,
      tasks: e?.isActive("taskList") ?? false,
      table: e?.isActive("table") ?? false,
      link: e?.isActive("link") ?? false,
    }),
  });
  const tool = (
    icon: string,
    name: string,
    active: boolean,
    run: () => void,
    shortcut?: string,
  ) => (
    <button
      key={name}
      type="button"
      aria-label={name}
      aria-pressed={active}
      title={shortcut ? t("tooltip.withShortcut", { label: name, shortcut }) : name}
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
      className={cx(iconButtonClass(), "aria-pressed:bg-bg-hover aria-pressed:text-text-primary")}
    >
      <Icon name={icon} />
    </button>
  );
  return (
    <div className="max-w-(--layout-peek) rounded-card border border-border-control bg-bg-surface focus-within:outline-solid focus-within:outline-stroke-focus focus-within:outline-focus-ring">
      <div
        role="toolbar"
        aria-label={t("rte.toolbar")}
        className="flex flex-wrap items-center gap-2 p-4 border-b border-border-subtle"
      >
        {tool(
          "Bold",
          t("rte.bold"),
          state?.bold ?? false,
          () => editor?.chain().focus().toggleBold().run(),
          "⌘B",
        )}
        {tool(
          "Italic",
          t("rte.italic"),
          state?.italic ?? false,
          () => editor?.chain().focus().toggleItalic().run(),
          "⌘I",
        )}
        {tool("List", t("rte.bullets"), state?.bullets ?? false, () =>
          editor?.chain().focus().toggleBulletList().run(),
        )}
        {tool("ListChecks", t("rte.checklist"), state?.tasks ?? false, () =>
          editor?.chain().focus().toggleTaskList().run(),
        )}
        {tool("Table", t("rte.table"), state?.table ?? false, () =>
          editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
        )}
        {onRequestLink
          ? tool("Link2", t("rte.link"), state?.link ?? false, () => {
              void Promise.resolve(onRequestLink()).then((href) => {
                if (href) editor?.chain().focus().extendMarkRange("link").setLink({ href }).run();
                else if (href === "") editor?.chain().focus().unsetLink().run();
              });
            })
          : null}
        {presence ? <span className="ms-auto">{presence}</span> : null}
      </div>
      <EditorContent editor={editor} />
      {menu ? (
        <ul
          id={menuId}
          role="listbox"
          aria-label={t(`rte.menu.${menu.kind}`)}
          className="fixed z-popover flex flex-col min-w-(--ui-menu-min) max-h-(--ui-listbox-max) overflow-auto m-0 p-4 list-none rounded-card border border-border-subtle bg-bg-raised shadow-menu xos-anim-pop"
          style={
            menu.rect
              ? { insetBlockStart: menu.rect.bottom + 4, insetInlineStart: menu.rect.left }
              : undefined
          }
        >
          {menu.items.length === 0 ? (
            <li
              role="option"
              aria-selected={false}
              aria-disabled
              className="px-8 py-6 text-text-secondary"
            >
              {t("rte.noMatches")}
            </li>
          ) : (
            menu.items.map((item, i) => (
              <li
                key={item.id}
                role="option"
                aria-selected={i === menu.active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  menu.select(i);
                }}
                className="flex items-center justify-between gap-12 min-h-target-fine px-8 py-6 rounded-chip cursor-pointer aria-selected:bg-bg-hover"
              >
                <span>{item.label}</span>
                {item.meta ? (
                  <span className="font-mono text-text-12 text-text-secondary">{item.meta}</span>
                ) : null}
              </li>
            ))
          )}
        </ul>
      ) : null}
      <div className="px-12 py-6 border-t border-border-subtle text-text-11 text-text-secondary">
        {t("rte.hint")}
      </div>
    </div>
  );
}
