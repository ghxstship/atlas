import { useMemo, type ReactElement } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import * as Y from "yjs";
import { MapView, RichTextEditor } from "../src/index.ts";

/**
 * Checks jsdom cannot make (RRR-75), run in real engines by test/visual/browser-checks.spec.ts:
 * MapLibre drawing raster tiles over WebGL, and two editors converging through Yjs.
 */
const meta: Meta = { title: "Browser Checks/Engines", parameters: { layout: "padded" } };
export default meta;

const zones = [
  { label: "Stage", x: 40, y: 30, w: 200, h: 90 },
  { label: "Front of House", x: 260, y: 150, w: 120, h: 70 },
];
const pins = [
  { x: 140, y: 75, label: "First Aid", tone: "accent" as const },
  { x: 320, y: 185, label: "Medical", tone: "danger" as const },
];

export const MapViewTiles: StoryObj = {
  name: "MapView on tiles",
  render: () => (
    <MapView
      label="Bayfront Park site map"
      width={420}
      height={260}
      zones={zones}
      pins={pins}
      geo={{ styleUrl: "./map-style.json", bounds: [-80.19, 25.77, -80.18, 25.78] }}
    />
  ),
};

function Linked(): ReactElement {
  const [a, b] = useMemo(() => {
    const left = new Y.Doc();
    const right = new Y.Doc();
    left.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== right) Y.applyUpdate(right, update, left);
    });
    right.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== left) Y.applyUpdate(left, update, right);
    });
    return [left, right];
  }, []);
  return (
    <div className="grid grid-cols-2 gap-16">
      <RichTextEditor label="Editor A" html="" ydoc={a} />
      <RichTextEditor label="Editor B" html="" ydoc={b} />
    </div>
  );
}

export const YjsCoEditing: StoryObj = { name: "Yjs co-editing", render: () => <Linked /> };
