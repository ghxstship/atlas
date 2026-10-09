# ADR 0011: Preview Data and Brand Slots

- Status: Accepted
- Date: 2026-10-09
- Decider: Owner, through the Claude Design session; recorded by the orchestrator
- Source: decisions D9 and D10 in `design/xos-design-system/README.md`

## Decision

1. **D9. Preview and fixture data come from canon.** Gate 3 criteria verbatim, Labor Rate Cards, catalog items in `{URID}-{ORG}-{SEQ}` form, Emergency Codes and Radio Channels, under the fictional Northwind Live tenant. Previews double as acceptance fixtures.
2. **D10. Platform brand marks stay white-label slots** (BrandMark, BrandSlot and the Brand assets) until the owner sets the marks. No layout depends on the final art; BrandMark renders a monogram tile in `accent-default` today.

## Consequences

Setting the platform marks later is an asset drop into `packages/ui/src/brand/defaults/`, not a layout change.
