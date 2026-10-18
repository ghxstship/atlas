import { useEffect, useRef, useState, type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { useT } from "../lib/context.tsx";
import { type MapViewProps } from "./Media.types.ts";
import { toLngLat } from "./toLngLat.tsx";

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
