# WhiteLabelPreview

WhiteLabelPreview renders the same screen under two tenant brands to prove theming is token-only.

- `sample` is the screen rendered under every brand.
- Each brand passes token overrides (`accent-default`, optional neutral tint, `radius-*`) and a theme; nothing else changes.
- Every override must pass the ColorPicker contrast checks before it can be saved.
- Both tenants in the preview are fictional.
