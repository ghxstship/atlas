# ADR 0013: Responsive and Cross-Engine Rules

- Status: Accepted
- Date: 2026-10-09
- Decider: Owner, through the Claude Design session; recorded by the orchestrator
- Source: decision D18 in `design/xos-design-system/README.md`

## Decision

1. Wide data scrolls inside a ScrollRegion, never the page.
2. Page-level layouts reflow by breakpoint; lists such as RecordRow and gate criteria reflow by the width of their own container through container queries.
3. Compass surfaces (`xos-compass`) raise every target to 48 pt; coarse pointers get 44 px targets, using invisible hit areas for dense controls.
4. The base reset matches the Tailwind preflight used in production, and calendar rows use CSS subgrid.

Accepted exceptions:

- calendar day cells are 37 by 44 px at 320 px wide, which still meets WCAG 2.5.8 AA;
- the Accordion body indent is a sum of tokens (32 px);
- WhiteLabelPreview renders a sample tenant's accent and radius by design;
- the Cover card is presentation art.

## Consequences

The responsive matrix (HANDOFF section 6, gate 5) runs every story in Chromium, Firefox and WebKit at 12 viewports from 320 to 1920 px and allows only these exceptions.
