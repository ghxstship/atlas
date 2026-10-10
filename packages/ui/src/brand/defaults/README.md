# Brand

White-label slots. Each file marks where a tenant's brand file goes and at what size; the platform brand marks are not set yet.

| Slot          | File           | Delivery size   | Formats                | Plan                     |
| ------------- | -------------- | --------------- | ---------------------- | ------------------------ |
| Logo, Light   | logo-light.svg | 160 x 40        | SVG or transparent PNG | All                      |
| Logo, Dark    | logo-dark.svg  | 160 x 40        | SVG or transparent PNG | All                      |
| Favicon       | favicon.svg    | 32 x 32 minimum | SVG or PNG             | All                      |
| App Icon      | app-icon.svg   | 1024 x 1024     | PNG, no transparency   | Enterprise branded build |
| Splash Screen | splash.svg     | 1290 x 2796     | PNG                    | Enterprise branded build |

Until a tenant uploads a logo, BrandMark renders a monogram tile in `accent-default` with the name in Inter. Replace these files with real marks; nothing else changes.
