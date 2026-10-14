# Icon

Icon draws any lucide-react icon at 1.5 stroke, sized from the `icon-*` tokens.

- `name` takes PascalCase (`Hammer`) or kebab-case (`chevron-right`); a few short aliases are kept: `more`, `alert`, `check-circle`, `pin`, `home`, `undo`.
- Icons inherit `currentColor`. Pass `label` only when the icon carries meaning alone; otherwise it is hidden from screen readers.
- Names resolve through the `@xos/icons` registry, the closed set that keeps lucide-react tree-shaken (RRR-70). To draw a new icon by name, add it to `packages/icons/registry/<owner>.txt` and run `pnpm --filter @xos/icons generate:registry`. A name outside the registry renders an empty square of the same size and logs one console warning.
- For canon objects use DepartmentGlyph, PhaseGlyph and RecordKindGlyph so the assignment stays in one place.
