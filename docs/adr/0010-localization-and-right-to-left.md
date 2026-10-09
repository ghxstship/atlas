# ADR 0010: Localization and Right-to-Left Layout

- Status: Accepted (part of the Wave 1 contract freeze)
- Date: 2026-10-09
- Decider: Owner, through the Claude Design session; recorded by the orchestrator
- Source: decisions D5 and D6 in `design/xos-design-system/README.md`

## Decision

1. **D5. Logical CSS only.** Every style uses logical properties, so right-to-left locales mirror with `dir="rtl"` and no extra CSS. Pseudo-locales `en-XA` (accented and about 60 percent longer) and `ar-XB` (right to left) ship with the catalogs for development and CI; they are not in the shipped `locales` list.
2. **D6. One ICU catalog for component strings.** The 319 design system messages merge into `packages/i18n/messages/{en-US,es-US}.json` nested under the `ui` namespace (`feedback.hint` becomes `ui.feedback.hint`), and the `packages/ui` message helper prefixes `ui.`. The pseudo-locale catalogs go to `packages/i18n/messages/pseudo/`.

## Consequences

Stylelint enforces logical properties. CI renders every story in `ar-XB` and `en-XA` (Section 15). The `ui` namespace belongs to A05 under ADR 0004.
