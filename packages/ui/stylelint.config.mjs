import shared from "@xos/config/stylelint";

/**
 * The shared rules (logical properties, no raw colors, sizes or durations) apply to every
 * stylesheet in this package except reference.css, the verbatim design export kept for comparison
 * (design handoff, section 2). It is never imported.
 */
export default {
  ...shared,
  ignoreFiles: [...(shared.ignoreFiles ?? []), "src/styles/reference.css"],
};
