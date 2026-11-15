# ScreenshotFrame

ScreenshotFrame presents a product image, or live XOS components standing in for one, inside a window frame.

With `src` it draws an image at a fixed aspect ratio, lazy by default; pass `eager` for the hero image. Without `src` it frames the components passed as children: the content is inert, hidden from assistive technology and exposed as a single image, so it adds no tab stops.

`alt` is required in both modes and says what the picture shows, not that it is a screenshot. Provide one image per locale so the picture matches the page language. Pictures use only the fictional Northwind Live tenant.
