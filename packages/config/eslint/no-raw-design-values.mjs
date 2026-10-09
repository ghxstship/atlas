/**
 * xos/no-raw-design-values (Section 3.15 source lint, design handoff build step 3).
 *
 * Design values have one home, packages/tokens. TypeScript outside it reads them through CSS
 * variables (`var(--color-bg-canvas)`) or the Tailwind preset classes, never as literals.
 * The rule reports, in string and template literals:
 *   - hex colors (`#0e0f11`) and color functions (`rgb()`, `hsl()`, `oklch()` and relatives);
 *   - pixel lengths other than zero (`12px`).
 * Inside a JSX `style` object it also reports numeric lengths (`{ padding: 12 }`, which React
 * renders as pixels) and literal durations on transition and animation properties.
 * Module specifiers and directives are not design values and are skipped.
 */

const HEX = /(?:^|[^&\w])(#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4}))(?![\w-])/gi;
const COLOR_FUNCTION = /\b((?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\()/gi;
const PIXELS = /(?:^|[^\w.-])(-?(?:\d+(?:\.\d*)?|\.\d+)px)\b/gi;
const DURATION = /(?:^|[^\w.-])((?:\d+(?:\.\d*)?|\.\d+)m?s)\b/gi;

/** CSS properties React renders in pixels when given a number. */
const LENGTH_PROPERTIES = new Set(
  [
    "width height minWidth minHeight maxWidth maxHeight blockSize inlineSize minBlockSize",
    "minInlineSize maxBlockSize maxInlineSize top right bottom left inset insetBlock insetInline",
    "insetBlockStart insetBlockEnd insetInlineStart insetInlineEnd gap rowGap columnGap",
    "margin marginTop marginRight marginBottom marginLeft marginBlock marginBlockStart marginBlockEnd",
    "marginInline marginInlineStart marginInlineEnd padding paddingTop paddingRight paddingBottom",
    "paddingLeft paddingBlock paddingBlockStart paddingBlockEnd paddingInline paddingInlineStart",
    "paddingInlineEnd fontSize letterSpacing borderRadius borderWidth borderTopWidth borderRightWidth",
    "borderBottomWidth borderLeftWidth borderBlockWidth borderInlineWidth outlineWidth outlineOffset",
    "borderTopLeftRadius borderTopRightRadius borderBottomLeftRadius borderBottomRightRadius",
    "borderStartStartRadius borderStartEndRadius borderEndStartRadius borderEndEndRadius flexBasis",
  ]
    .join(" ")
    .split(" "),
);

const DURATION_PROPERTIES = new Set([
  "transition",
  "transitionDuration",
  "transitionDelay",
  "animation",
  "animationDuration",
  "animationDelay",
]);

function matches(pattern, text) {
  return [...text.matchAll(pattern)].map((m) => m[1]);
}

function rawValues(text) {
  const found = [];
  for (const value of matches(HEX, text)) found.push({ kind: "color", value });
  for (const value of matches(COLOR_FUNCTION, text)) found.push({ kind: "color", value });
  for (const value of matches(PIXELS, text)) {
    if (Number.parseFloat(value) !== 0) found.push({ kind: "size", value });
  }
  return found;
}

function propertyName(property) {
  if (property.computed) return undefined;
  if (property.key.type === "Identifier") return property.key.name;
  if (property.key.type === "Literal" && typeof property.key.value === "string") {
    return property.key.value.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  }
  return undefined;
}

function isModuleSpecifier(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (
    (parent.type === "ImportDeclaration" ||
      parent.type === "ExportNamedDeclaration" ||
      parent.type === "ExportAllDeclaration" ||
      parent.type === "ImportExpression") &&
    parent.source === node
  ) {
    return true;
  }
  if (parent.type === "TSExternalModuleReference" || parent.type === "TSImportType") return true;
  if (parent.type === "TSLiteralType" && parent.parent?.type === "TSImportType") return true;
  return (
    parent.type === "CallExpression" &&
    parent.callee.type === "Identifier" &&
    parent.callee.name === "require" &&
    parent.arguments[0] === node
  );
}

function isDirective(node) {
  return node.parent?.type === "ExpressionStatement" && typeof node.parent.directive === "string";
}

/** The property of a JSX `style={{ ... }}` object that a value node belongs to, if any. */
function styleProperty(node) {
  const property = node.parent;
  if (property?.type !== "Property" || property.value !== node) return undefined;
  const object = property.parent;
  const container = object?.parent;
  const attribute = container?.parent;
  if (
    object?.type === "ObjectExpression" &&
    container?.type === "JSXExpressionContainer" &&
    attribute?.type === "JSXAttribute" &&
    attribute.name.type === "JSXIdentifier" &&
    attribute.name.name === "style"
  ) {
    return propertyName(property);
  }
  return undefined;
}

/** @type {import("eslint").Rule.RuleModule} */
export const noRawDesignValues = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow raw colors, pixel sizes and durations outside packages/tokens; use design tokens.",
    },
    schema: [],
    messages: {
      color:
        "Raw color {{value}}. Use a color token: a var(--color-*) variable or a Tailwind preset class.",
      size: "Raw size {{value}}. Use a spacing, radius, stroke or layout token variable or preset class.",
      duration:
        "Raw duration {{value}}. Use a var(--motion-duration-*) token or a duration-* class.",
    },
  },
  create(context) {
    function checkText(node, text) {
      for (const { kind, value } of rawValues(text)) {
        context.report({ node, messageId: kind, data: { value } });
      }
      const property = styleProperty(node);
      if (property !== undefined && DURATION_PROPERTIES.has(property)) {
        for (const value of matches(DURATION, text)) {
          context.report({ node, messageId: "duration", data: { value } });
        }
      }
    }

    return {
      Literal(node) {
        if (typeof node.value === "string") {
          if (isModuleSpecifier(node) || isDirective(node)) return;
          checkText(node, node.value);
          return;
        }
        if (typeof node.value === "number" && node.value !== 0) {
          const property = styleProperty(node);
          if (property !== undefined && LENGTH_PROPERTIES.has(property)) {
            context.report({ node, messageId: "size", data: { value: `${node.value} (pixels)` } });
          }
          if (property !== undefined && DURATION_PROPERTIES.has(property)) {
            context.report({ node, messageId: "duration", data: { value: `${node.value}` } });
          }
        }
      },
      TemplateLiteral(node) {
        const text = node.quasis.map((q) => q.value.cooked ?? q.value.raw).join(" ");
        checkText(node, text);
      },
    };
  },
};

/** ESLint plugin namespace `xos`. */
export const xosPlugin = {
  meta: { name: "@xos/eslint-plugin" },
  rules: { "no-raw-design-values": noRawDesignValues },
};

/**
 * Flat config block that turns the rule on for TypeScript sources. Test files are exempt because
 * fixtures assert on literal values; packages/tokens turns the rule off because it is the home
 * of the values.
 */
export const designValues = [
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
    ignores: ["**/test/**", "**/tests/**", "**/*.test.ts", "**/*.test.tsx"],
    plugins: { xos: xosPlugin },
    rules: { "xos/no-raw-design-values": "error" },
  },
];
