import type { Doc } from "yjs";
import type {
  FilePreviewerProps as ReferenceFilePreviewerProps,
  MapViewProps as ReferenceMapViewProps,
  RichTextEditorProps as ReferenceRichTextEditorProps,
} from "../types/reference";
import { type SuggestionSource } from "../RichTextEditor/extensions.ts";

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
