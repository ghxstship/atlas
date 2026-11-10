/**
 * @xos/ui-native/gallery: every component of the library in its main states, page by page, for the
 * Compass component gallery and its visual snapshots (A141). Development and test builds only: nothing
 * in the package root imports it, so an app that does not open the gallery never bundles it.
 */
export { GalleryScreen, galleryPage, galleryThemes } from "./GalleryScreen.tsx";
export type { GalleryScreenProps, GalleryTheme } from "./GalleryScreen.tsx";
export { galleryPages, pagesShowing } from "./pages.tsx";
export type { GalleryEntry, GalleryPage } from "./pages.tsx";
export { clockHeld, holdClock, HELD_TIMER_MS } from "./clock.ts";
