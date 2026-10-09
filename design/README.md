# Design exports

Claude Design exports for agent A05 (ADR 0004 path ownership, ADR 0005 item 5). Files here are kept as exported; nothing in `apps/` or `packages/` imports from this folder.

| Path | Contents |
| --- | --- |
| `tokens.json` | The token export Section 11.5 names: 169 tokens, usage notes and the Dark, Light and Sunlight themes. Identical to `xos-design-system/tokens.json`. |
| `xos-design-system/` | The XOS Design System: components with previews and READMEs, token exports, ICU catalogs, the canon reference model and the QA audit. Start with `xos-design-system/HANDOFF.md`. |
| `xos-screens/` | The XOS 4.0 Screens canvas: the Section 11.5 items 2 to 6 boards (`*.dc.html`) and `canvas.json`. `xos-screens/ds/xos/` is the design system copy the boards render with. |

The finish guard and Prettier skip this folder, because the exports carry design tool markup and vendored libraries. Anything copied out of it into `packages/` or `supabase/` must pass both.
