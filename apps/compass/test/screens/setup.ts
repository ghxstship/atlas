import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, vi } from "vitest";

/** A DOM for the screens (vitest.screens.config.ts says why it is borrowed), set up before anything imports the renderer. */
const borrowed = createRequire(
  fileURLToPath(new URL("../../../../packages/workforce-native/package.json", import.meta.url)),
);
const { JSDOM } = borrowed("jsdom") as typeof import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
const { window } = dom;
Object.assign(globalThis, {
  window,
  document: window.document,
  HTMLElement: window.HTMLElement,
  Node: window.Node,
  Element: window.Element,
  MutationObserver: window.MutationObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });

const { cleanup } = await import("@testing-library/react");
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
