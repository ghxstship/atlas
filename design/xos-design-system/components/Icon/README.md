# Icon

Icon draws any lucide-react icon at 1.5 stroke, sized from the `icon-*` tokens.

- `name` takes PascalCase (`Hammer`) or kebab-case (`chevron-right`); a few short aliases are kept: `more`, `alert`, `check-circle`, `pin`, `home`, `undo`.
- Icons inherit `currentColor`. Pass `label` only when the icon carries meaning alone; otherwise it is hidden from screen readers.
- For canon objects use DepartmentGlyph, PhaseGlyph and RecordKindGlyph so the assignment stays in one place.
