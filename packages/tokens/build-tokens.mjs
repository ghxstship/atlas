/* XOS Design System: Style Dictionary build for packages/tokens (verified on 5.6.0, the repo pin, and on 4.3.0).
   Emits one CSS file per theme (CSS variables scoped to [data-theme]), a shared base file,
   and a React Native theme module per theme for packages/ui-native.
   Usage, from packages/tokens with tokens/ beside it: node build-tokens.mjs
   This is a build script that calls the Style Dictionary API; it is not a CLI config file. */
import StyleDictionary from "style-dictionary";

const THEMES = ["dark", "light", "sunlight"];
const DEFAULT_THEME = "dark";

const base = new StyleDictionary({
  source: ["tokens/base.tokens.json"],
  log: { verbosity: "verbose" },
  platforms: {
    css: {
      transformGroup: "css",
      buildPath: "dist/css/",
      files: [
        {
          destination: "base.css",
          format: "css/variables",
          options: { selector: ":root", outputReferences: true },
        },
      ],
    },
    native: {
      transformGroup: "react-native",
      buildPath: "dist/native/",
      files: [{ destination: "base.js", format: "javascript/es6" }],
    },
  },
});
await base.buildAllPlatforms();

for (const theme of THEMES) {
  const selector =
    theme === DEFAULT_THEME ? `:root, [data-theme="${theme}"]` : `[data-theme="${theme}"]`;
  const sd = new StyleDictionary({
    include: ["tokens/base.tokens.json"],
    source: [`tokens/theme.${theme}.tokens.json`],
    platforms: {
      css: {
        transformGroup: "css",
        buildPath: "dist/css/",
        files: [
          {
            destination: `theme.${theme}.css`,
            format: "css/variables",
            filter: (t) => t.filePath.includes(`theme.${theme}`),
            options: { selector, outputReferences: true },
          },
        ],
      },
      native: {
        transformGroup: "react-native",
        buildPath: "dist/native/",
        files: [
          {
            destination: `theme.${theme}.js`,
            format: "javascript/es6",
            filter: (t) => t.filePath.includes(`theme.${theme}`),
          },
        ],
      },
    },
  });
  await sd.buildAllPlatforms();
}
