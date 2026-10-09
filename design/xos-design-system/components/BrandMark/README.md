# BrandMark

BrandMark renders the tenant's logo, switching light and dark files with the theme, or a token-driven monogram and name when no logo is set.

- Props: `name` (required, also the alt text), `logoLight`, `logoDark`, `monogram`, `size` (`sm` 20 px, `md` 28 px, `lg` 40 px), `iconOnly`.
- With no logo uploaded, the monogram tile uses `accent-default` and `accent-text-on`, so it follows the tenant accent automatically.
- The platform brand marks are not set yet; until they are, the platform also renders through this fallback.
