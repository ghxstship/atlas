/* Tailwind 4 loads this through `@config` in src/styles/index.css. Every utility reads a token
   variable through the shared preset, so a theme or white-label change needs no rebuild. */
module.exports = { presets: [require("@xos/config/tailwind/preset.js")] };
