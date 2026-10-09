# ADR 0009: Design Tokens, Contrast and Themes

- Status: Accepted (part of the Wave 1 contract freeze)
- Date: 2026-10-09
- Decider: Owner, through the Claude Design session; recorded by the orchestrator
- Source: decisions D1, D2, D3, D4, D7 and D8 in `design/xos-design-system/README.md` (Decisions log), which holds the full values and ratios

## Context

Section 11.3 sets default token values and requires the token build to fail on any pair under WCAG 2.2 AA. Several spec values fail that check in real usage, and Compass needs an outdoor theme the spec only describes.

## Decision

1. **D1. Contrast is enforced by token, not by usage rule.** Text and boundary tokens are added beside the Section 11.3 fills: `border-control`, `accent-text`, `danger-text`, `warning-text` and `success-text`, each defined for Dark, Light and Sunlight. The fill values in Section 11.3 are unchanged.
2. **D2. Tertiary text and weights.** `text-tertiary` becomes #878A94 (dark) and #6A6D75 (light), the smallest shifts that clear 4.5:1 on `bg-hover`. Weights are 400, 500 and 600; 700 is reserved for the BrandMark monogram.
3. **D3. Sunlight is a full third theme derived from Light**, with opaque grounds, 2 px control borders and darker text on color, held to AA by the same gate.
4. **D4. Categorical data visualization** is themed and capped at the seven Okabe-Ito hues plus `viz-other`; the spec's eighth color (#999999) becomes the Other bucket.
5. **D7. Platform defaults live in the base CSS:** 44 px coarse-pointer targets, `color-scheme` per theme, forced-colors and print styles.
6. **D8. Emergency code swatches are tokens** (`ecode-*`) and the code word is always printed, because color alone cannot carry a code.

## Consequences

- `design/tokens.json` (169 tokens) is the single source; `packages/tokens` builds CSS variables and the React Native theme from it with Style Dictionary 5.6.0.
- The contrast gate runs over `contrast-pairs.json` in CI with zero failing pairs, and the white-label theme editor runs the same check before saving.
- These values supersede the Section 11.3 table where they differ.
