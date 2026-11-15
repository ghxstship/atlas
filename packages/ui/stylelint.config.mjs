import shared from "@xos/config/stylelint";

/**
 * The shared rules (logical properties, no raw colors, sizes or durations) apply to every
 * stylesheet in this package except reference.css, the design export kept for comparison (design
 * handoff, section 2) without its remote font import. It is never imported and never published.
 */
export default {
  ...shared,
  ignoreFiles: [...(shared.ignoreFiles ?? []), "src/styles/reference.css", "storybook-static/**"],
};
