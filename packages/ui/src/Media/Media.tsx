import { useEffect, useId, useMemo, useRef, useState, type ReactElement } from "react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import type { Doc } from "yjs";
import type {
  FilePreviewerProps as ReferenceFilePreviewerProps,
  MapViewProps as ReferenceMapViewProps,
  RichTextEditorProps as ReferenceRichTextEditorProps,
} from "../types/reference";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { Icon } from "../Icon/Icon.tsx";
import { IconButton, iconButtonClass } from "../Button/Button.tsx";
import {
  blockExtensions,
  mentionExtension,
  recordLinkExtension,
  slashCommands,
  slashExtension,
  type MenuListener,
  type SuggestionMenu,
  type SuggestionSource,
} from "../RichTextEditor/extensions.ts";

export type { SuggestionItem, SuggestionSource } from "../RichTextEditor/extensions.ts";

export type RichTextEditorProps = ReferenceRichTextEditorProps & {
  /** A Yjs document for live co-editing; with it the document is the source of truth and local undo is off. */
  ydoc?: Doc;
  /** A Yjs provider (Hocuspocus, y-websocket) bound to `ydoc`. */
  provider?: unknown;
  onChange?: (html: string) => void;
  /** Returns the URL to link the selection to, or null to cancel; the Link button shows when given. */
  onRequestLink?: () => string | null | Promise<string | null>;
  editable?: boolean;
  /** People for `@` mentions; the trigger is off without it. */
  mentions?: SuggestionSource;
  /** Records for `#` links, keyed by URID; the trigger is off without it. */
  records?: SuggestionSource;
  /** The URL a record link opens; `/r/<urid>` by default. */
  recordHref?: (urid: string) => string;
};
export type FilePreviewerProps = ReferenceFilePreviewerProps & {
  onPage?: (page: number) => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onDownload?: () => void;
};
export interface MapGeo {
  /** MapLibre style URL for the basemap tiles. */
  styleUrl: string;
  /** [west, south, east, north] that the drawing's width and height map onto. */
  bounds: [number, number, number, number];
}
export type MapViewProps = ReferenceMapViewProps & {
  /** Renders the same zones, pins and geofence on MapLibre tiles; the drawing remains the fallback. */
  geo?: MapGeo;
};

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

/** A file with page thumbnails, zoom and download; the page area holds the rendered page. */
export function FilePreviewer({
  name,
  meta,
  pages,
  page = 0,
  zoom = "100%",
  icon,
  children,
  onPage,
  onZoomIn,
  onZoomOut,
  onDownload,
}: FilePreviewerProps): ReactElement {
  const t = useT();
  const [current, setCurrent] = useState(page);
  return (
    <section aria-label={name} className="overflow-hidden rounded-card border border-border-subtle">
      <div className="flex flex-wrap items-center gap-8 min-h-(--ui-shell-head) ps-12 pe-8 bg-bg-surface border-b border-border-subtle">
        <Icon name={icon ?? "FileText"} color="var(--color-text-secondary)" />
        <strong className="font-semibold">{name}</strong>
        <span className="text-text-secondary">{meta}</span>
        <span className="flex items-center gap-2 ms-auto">
          <IconButton icon="ZoomOut" label={t("file.zoomOut")} onClick={onZoomOut} />
          <span className="text-text-secondary tabular-nums" aria-live="polite">
            {zoom}
          </span>
          <IconButton icon="ZoomIn" label={t("file.zoomIn")} onClick={onZoomIn} />
          <IconButton icon="Download" label={t("action.download")} onClick={onDownload} />
        </span>
      </div>
      <div className="flex h-(--ui-listbox-max) max-sm:flex-col">
        <div className="flex flex-col max-sm:flex-row gap-8 w-(--space-64) max-sm:w-full p-8 overflow-auto bg-bg-surface border-e border-border-subtle">
          {Array.from({ length: pages }, (_, i) => (
            <button
              key={i}
              type="button"
              aria-label={t("file.page", { n: i + 1 })}
              aria-pressed={i === current}
              onClick={() => {
                setCurrent(i);
                onPage?.(i);
              }}
              className={cx(
                "flex-none h-(--space-64) max-sm:w-(--space-48) rounded-chip border border-border-subtle bg-bg-raised text-text-11 text-text-tertiary cursor-pointer tabular-nums",
                "aria-pressed:border-accent aria-pressed:text-text-primary",
              )}
            >
              {i + 1}
            </button>
          ))}
        </div>
        <div className="flex flex-1 justify-center p-24 overflow-auto bg-bg-surface">
          {children}
        </div>
      </div>
    </section>
  );
}

const PIN_FILL: Record<NonNullable<MapViewProps["pins"][number]["tone"]>, string> = {
  accent: cx("fill-accent"),
  danger: cx("fill-danger"),
  warning: cx("fill-warning"),
};
const PIN_VAR: Record<NonNullable<MapViewProps["pins"][number]["tone"]>, string> = {
  accent: "--color-accent-default",
  danger: "--color-danger",
  warning: "--color-warning",
};

function pinFill(tone: MapViewProps["pins"][number]["tone"]): string {
  return PIN_FILL[tone ?? "accent"];
}

function cssColor(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Converts a drawing point to longitude and latitude across the geo bounds. */
export function toLngLat(
  x: number,
  y: number,
  width: number,
  height: number,
  bounds: MapGeo["bounds"],
): [number, number] {
  const [west, south, east, north] = bounds;
  return [west + (x / width) * (east - west), north - (y / height) * (north - south)];
}

/**
 * Venues, zones, geofences and incident pins. The numbered legend is the text alternative. With
 * `geo`, the same shapes render on MapLibre tiles; without WebGL the drawing stays.
 */
export function MapView({
  label,
  width,
  height,
  zones,
  pins,
  geofence,
  geo,
}: MapViewProps): ReactElement {
  const t = useT();
  const container = useRef<HTMLDivElement>(null);
  const [tiles, setTiles] = useState(false);
  useEffect(() => {
    if (!geo || !container.current) return undefined;
    let disposed = false;
    let map: { remove: () => void } | null = null;
    const el = container.current;
    import("maplibre-gl")
      .then(({ Map: MapLibre }) => {
        if (disposed) return;
        const ll = (x: number, y: number) => toLngLat(x, y, width, height, geo.bounds);
        const instance = new MapLibre({
          container: el,
          style: geo.styleUrl,
          bounds: geo.bounds,
          attributionControl: { compact: true },
        });
        map = instance;
        instance.on("load", () => {
          instance.addSource("zones", {
            type: "geojson",
            data: {
              type: "FeatureCollection",
              features: zones.map((z) => ({
                type: "Feature",
                properties: { label: z.label },
                geometry: {
                  type: "Polygon",
                  coordinates: [
                    [
                      ll(z.x, z.y),
                      ll(z.x + z.w, z.y),
                      ll(z.x + z.w, z.y + z.h),
                      ll(z.x, z.y + z.h),
                      ll(z.x, z.y),
                    ],
                  ],
                },
              })),
            },
          });
          instance.addLayer({
            id: "zones",
            type: "line",
            source: "zones",
            paint: { "line-color": cssColor("--color-border-strong"), "line-width": 1 },
          });
          instance.addSource("pins", {
            type: "geojson",
            data: {
              type: "FeatureCollection",
              features: pins.map((p, i) => ({
                type: "Feature",
                properties: { n: String(i + 1), color: cssColor(PIN_VAR[p.tone ?? "accent"]) },
                geometry: { type: "Point", coordinates: ll(p.x, p.y) },
              })),
            },
          });
          instance.addLayer({
            id: "pins",
            type: "circle",
            source: "pins",
            paint: {
              "circle-radius": 9,
              "circle-color": ["get", "color"],
              "circle-stroke-width": 2,
              "circle-stroke-color": cssColor("--color-bg-canvas"),
            },
          });
          setTiles(true);
        });
      })
      .catch((error: unknown) => {
        if (!disposed) setTiles(false);
        if (!(error instanceof Error)) throw error;
      });
    return () => {
      disposed = true;
      map?.remove();
    };
  }, [geo, zones, pins, width, height]);
  return (
    <figure className="grid grid-cols-[minmax(0,1fr)_var(--ui-settings-nav)] max-md:grid-cols-[minmax(0,1fr)] gap-16 m-0">
      <div className="relative">
        {geo ? (
          <div
            ref={container}
            aria-hidden="true"
            inert
            className={cx("absolute inset-0 rounded-card overflow-hidden", !tiles && "hidden")}
          />
        ) : null}
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={label}
          className={cx(
            "w-full h-auto rounded-card border border-border-subtle bg-bg-surface",
            tiles && "opacity-0",
          )}
        >
          {zones.map((z) => (
            <g key={z.label}>
              <rect
                x={z.x}
                y={z.y}
                width={z.w}
                height={z.h}
                rx={6}
                className="fill-bg-raised stroke-border-strong"
              />
              <text
                x={z.x + 8}
                y={z.y + 18}
                className="fill-text-secondary text-text-11 font-medium"
              >
                {z.label}
              </text>
            </g>
          ))}
          {geofence ? (
            <circle
              cx={geofence.x}
              cy={geofence.y}
              r={geofence.r}
              className="fill-none stroke-success"
              strokeWidth={1.5}
              strokeDasharray="6 4"
            />
          ) : null}
          {pins.map((p, i) => (
            <g key={`${p.label}-${i}`} transform={`translate(${p.x} ${p.y})`}>
              <circle r={9} className={cx(pinFill(p.tone), "stroke-bg-canvas")} strokeWidth={2} />
              <text
                y={3.5}
                textAnchor="middle"
                className="fill-accent-text-on text-text-11 font-bold"
              >
                {i + 1}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <figcaption>
        <ol
          aria-label={t("view.map")}
          className="flex flex-col gap-6 m-0 p-0 list-none text-text-12"
        >
          {pins.map((p, i) => (
            <li key={`${p.label}-${i}`} className="flex gap-8">
              <span className="w-(--space-12) text-text-tertiary tabular-nums">{i + 1}</span>
              {p.label}
            </li>
          ))}
        </ol>
      </figcaption>
    </figure>
  );
}
