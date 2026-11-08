import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/*
 * The first sign-in screens in a DOM, as a person answers them (test/screens). Compass's own React pairs with React Native
 * and has no DOM renderer, so these tests borrow the renderer @xos/workforce-native's screen tests use, with the same
 * React it pairs with, instead of adding a second React to Compass's production dependency graph.
 */
const borrowed = createRequire(
  fileURLToPath(new URL("../../packages/workforce-native/package.json", import.meta.url)),
);
const packageDir = (name: string) => dirname(borrowed.resolve(`${name}/package.json`));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^react$/, replacement: `${packageDir("react")}/index.js` },
      { find: /^react\/jsx-runtime$/, replacement: `${packageDir("react")}/jsx-runtime.js` },
      { find: /^react\/jsx-dev-runtime$/, replacement: `${packageDir("react")}/jsx-dev-runtime.js` },
      { find: /^react-dom$/, replacement: `${packageDir("react-dom")}/index.js` },
      { find: /^react-dom\/client$/, replacement: `${packageDir("react-dom")}/client.js` },
      { find: /^react-dom\/test-utils$/, replacement: `${packageDir("react-dom")}/test-utils.js` },
      {
        find: /^@testing-library\/react$/,
        replacement: `${packageDir("@testing-library/react")}/dist/@testing-library/react.esm.js`,
      },
    ],
  },
  test: {
    include: ["test/screens/**/*.test.tsx"],
    setupFiles: ["test/screens/setup.ts"],
    testTimeout: 30_000,
    server: { deps: { inline: [/@testing-library/] } },
  },
});
