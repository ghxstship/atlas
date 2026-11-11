/**
 * xos/registered-capability (Section 3.15 source lint, S3.15-10).
 *
 * Every capability a check names must exist in packages/schemas/capabilities.yaml. The rule reports
 * a string literal shaped like a capability code (`module.object.verb`) that the registry lacks,
 * wherever the code reads it as a capability:
 *   - an argument of a capability check: `ctx.capabilities.has(…)`, `access.can(…)` and the other
 *     callees in `callees`, or any function whose name says capability (`requireCapability(…)`);
 *   - the value of a property, variable or JSX attribute whose name says capability
 *     (`capability: …`, `SUPERVISOR_CAPABILITIES = […]`, `<RefusalPanel capability=… />`), and the
 *     JSX attributes in `attributes`.
 * Conditionals, logical operators and arrays inside those positions are followed, and nested
 * objects inside a capability-named variable or call; function bodies are not. Catalog keys that
 * merely look alike (`advancing.packets.create`) sit in none of these positions and are left alone.
 */

const CODE_SHAPE = /^[a-z][a-z_]*(?:\.[a-z][a-z_]*){2,3}$/;
const SAYS_CAPABILITY = /capabilit/i;

/** Calls whose string arguments are capability codes in this repository. */
export const DEFAULT_CAPABILITY_CALLEES = [
  "has",
  "can",
  "canAll",
  "canAny",
  "rw",
  "refusal",
  "writableProjects",
];

/** JSX attributes whose value is a capability code in this repository. */
export const DEFAULT_CAPABILITY_ATTRIBUTES = ["refusal"];

function nameOf(node) {
  if (!node) return null;
  if (node.type === "Identifier" || node.type === "JSXIdentifier") return node.name;
  if (node.type === "PrivateIdentifier") return node.name;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "MemberExpression" && !node.computed) return nameOf(node.property);
  if (node.type === "ChainExpression") return nameOf(node.expression);
  return null;
}

const BOUNDARIES = new Set([
  "ArrowFunctionExpression",
  "FunctionExpression",
  "FunctionDeclaration",
  "Program",
  "ClassBody",
]);

/** Node types a capability value passes through on its way into a capability position. */
const CONDUITS = new Set([
  "ConditionalExpression",
  "LogicalExpression",
  "ArrayExpression",
  "ObjectExpression",
  "SpreadElement",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "JSXExpressionContainer",
  "ChainExpression",
]);

/** @type {import("eslint").Rule.RuleModule} */
export const registeredCapability = {
  meta: {
    type: "problem",
    docs: {
      description: "Require every capability code a check names to exist in capabilities.yaml.",
    },
    schema: [
      {
        type: "object",
        properties: {
          codes: { type: "array", items: { type: "string" } },
          callees: { type: "array", items: { type: "string" } },
          attributes: { type: "array", items: { type: "string" } },
        },
        required: ["codes"],
        additionalProperties: false,
      },
    ],
    messages: {
      unknown:
        'Capability "{{code}}" is not in packages/schemas/capabilities.yaml. Use a registry code or add it to the registry.',
    },
  },
  create(context) {
    const options = context.options[0] ?? { codes: [] };
    const codes = new Set(options.codes);
    const callees = new Set(options.callees ?? DEFAULT_CAPABILITY_CALLEES);
    const attributes = new Set(options.attributes ?? DEFAULT_CAPABILITY_ATTRIBUTES);

    const says = (name) => name !== null && (callees.has(name) || SAYS_CAPABILITY.test(name));

    /**
     * Whether the value at `node` sits in a capability position. A property that says capability
     * holds the code itself; an object below it (`capability: { title: "…" }`) is something else.
     */
    function inCapabilityPosition(node) {
      let child = node;
      let nested = false;
      for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
        if (BOUNDARIES.has(parent.type)) return false;
        if (parent.type === "ObjectExpression") nested = true;
        if (CONDUITS.has(parent.type)) continue;
        switch (parent.type) {
          case "CallExpression":
          case "NewExpression":
            if (parent.callee === child) return false;
            if (says(nameOf(parent.callee))) return true;
            return false;
          case "Property":
            if (parent.key === child) return false;
            if (!nested && SAYS_CAPABILITY.test(nameOf(parent.key) ?? "")) return true;
            continue;
          case "VariableDeclarator":
            return parent.init === child && SAYS_CAPABILITY.test(nameOf(parent.id) ?? "");
          case "AssignmentExpression":
            return parent.right === child && SAYS_CAPABILITY.test(nameOf(parent.left) ?? "");
          case "PropertyDefinition":
            return parent.value === child && SAYS_CAPABILITY.test(nameOf(parent.key) ?? "");
          case "JSXAttribute": {
            const name = nameOf(parent.name) ?? "";
            return attributes.has(name) || SAYS_CAPABILITY.test(name);
          }
          default:
            return false;
        }
      }
      return false;
    }

    function check(node, value) {
      if (!CODE_SHAPE.test(value) || codes.has(value)) return;
      if (!inCapabilityPosition(node)) return;
      context.report({ node, messageId: "unknown", data: { code: value } });
    }

    return {
      Literal(node) {
        if (typeof node.value !== "string") return;
        if (node.parent?.type === "TSLiteralType") return;
        check(node, node.value);
      },
      TemplateLiteral(node) {
        if (node.expressions.length > 0) return;
        check(node, node.quasis[0]?.value.cooked ?? "");
      },
    };
  },
};
