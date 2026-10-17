# Icon

Icon draws a registered lucide icon at 1.5 stroke, sized from the `icon-*` tokens.

- `name` takes PascalCase (`Hammer`) or kebab-case (`chevron-right`); a few short aliases are kept: `more`, `alert`, `check-circle`, `pin`, `home`, `undo`.
- Icons inherit `currentColor`. Pass `label` only when the icon carries meaning alone: the icon is then an image named by its label and a `<title>`. Otherwise it is hidden from screen readers.
- Icons draw from one SVG sprite (`@xos/icons/sprite.svg`) with `<use href>`, so no icon geometry ships in page JavaScript (ADR 0027). The bundler emits the sprite with a content hash under `/_next/static/media`, and browsers cache it as a static asset.
- Names come from the `@xos/icons` registry, the closed set the sprite is built from (RRR-70). To draw a new icon by name, add it to `packages/icons/registry/<owner>.txt` and run `pnpm --filter @xos/icons generate:registry`, which rewrites the sprite too. A name outside the registry renders an empty square of the same size and, in development, logs one console warning.
- For canon objects use DepartmentGlyph, PhaseGlyph and RecordKindGlyph so the assignment stays in one place.
