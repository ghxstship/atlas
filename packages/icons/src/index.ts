/**
 * @xos/icons: the glyph map, the icon names XOS draws, the lucide-react components behind them
 * (native and server use) and the web sprite (`@xos/icons/sprite.svg`). Web bundles import the
 * `glyphs` and `names` entries, which pull in no icon components (ADR 0027).
 */
export * from "./glyphs.ts";
export * from "./names.ts";
export * from "./registry.ts";
