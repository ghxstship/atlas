/**
 * xos/registered-route (Section 3.15 source lint, S3.15-10).
 *
 * Routes are generated from the sitemap, so every in-app path the code links or navigates to must
 * be one the sitemap (or the shell's own routes) defines. The rule checks the path in
 *   - an `href` JSX attribute or `href` property;
 *   - `router.push`, `router.replace`, `router.prefetch`, and Expo Router's `router.navigate` and
 *     `router.dismissTo`, with a path or a `{ pathname }` object (`[param]` stands for a value);
 *   - `redirect` and `permanentRedirect`, and `NextResponse.redirect(new URL(…))`.
 * String literals and template literals are checked; a template's `${…}` parts stand for one path
 * segment each (or part of one), so `/${org}/p/${key}/gates` matches `/{org}/p/{projectKey}/gates`.
 * Only absolute in-app paths are checked: values that do not start with one `/` (external URLs,
 * `mailto:`, `?peek=…`, a template that starts with a variable) are left alone. The query string
 * and fragment are ignored.
 *
 * Options: `routes`, the route patterns in the sitemap's syntax (`/{org}/home`, `{token}.ics`,
 * `{...path}` for the rest of the path); `ignore`, regular expressions for paths the app serves
 * outside its route tree (static files).
 */

const HOLE = "\u0000";
const NAVIGATION_METHODS = new Set(["push", "replace", "prefetch", "navigate", "dismissTo"]);
const REDIRECTS = new Set(["redirect", "permanentRedirect"]);

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Parses a route pattern into segments the matcher compares. */
export function compileRoute(pattern) {
  if (pattern === "/") return [];
  return pattern
    .slice(1)
    .split("/")
    .map((segment) => {
      const rest = /^\{\.\.\.[A-Za-z][A-Za-z0-9]*\}$/.exec(segment);
      if (rest) return { kind: "rest" };
      const param = /^\{[A-Za-z][A-Za-z0-9]*\}(.*)$/.exec(segment);
      if (param) return { kind: "param", suffix: param[1] ?? "" };
      return { kind: "static", value: segment };
    });
}

/**
 * Whether one path segment can match one route segment. A segment that is only a `${…}` stands for
 * a parameter value; it may stand for a fixed segment only at the end of the path, where code picks
 * a tab (`/${org}/p/${key}/${tab}`). Otherwise `/${org}/hom` would match `/legal/{document}`.
 */
function segmentMatches(routeSegment, pathSegment, last) {
  if (routeSegment.kind === "param") {
    const { suffix } = routeSegment;
    if (!pathSegment.includes(HOLE)) {
      return pathSegment.length > suffix.length && pathSegment.endsWith(suffix);
    }
    // `${token}.ics` fits `{feedToken}.ics`; `${token}.ical` does not.
    const tail = pathSegment.slice(pathSegment.lastIndexOf(HOLE) + 1);
    return tail.endsWith(suffix) || suffix.endsWith(tail);
  }
  if (!pathSegment.includes(HOLE)) return routeSegment.value === pathSegment;
  if (pathSegment === HOLE) return last;
  const pattern = pathSegment.split(HOLE).map(escape).join(".*");
  return new RegExp(`^${pattern}$`).test(routeSegment.value);
}

/** Whether a path (holes marked with U+0000) can match the compiled route. */
export function pathMatches(route, segments) {
  for (let i = 0; i < route.length; i += 1) {
    const routeSegment = route[i];
    if (routeSegment.kind === "rest") return segments.length > i;
    const pathSegment = segments[i];
    const last = i === segments.length - 1;
    if (pathSegment === undefined || !segmentMatches(routeSegment, pathSegment, last)) return false;
  }
  return segments.length === route.length;
}

/** Splits a path, with holes, into segments; null when it is not an absolute in-app path. */
export function pathSegments(text) {
  if (!text.startsWith("/") || text.startsWith("//")) return null;
  const bare = (text.split(/[?#]/, 1)[0] ?? "").replace(
    /\[(?:\.\.\.)?[A-Za-z][A-Za-z0-9]*\]/g,
    HOLE,
  );
  const trimmed = bare.length > 1 && bare.endsWith("/") ? bare.slice(0, -1) : bare;
  if (trimmed === "/") return [];
  return trimmed.slice(1).split("/");
}

function displayPath(text) {
  return text.replaceAll(HOLE, "${…}");
}

/** @type {import("eslint").Rule.RuleModule} */
export const registeredRoute = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require every in-app path the code links or navigates to to exist in the sitemap.",
    },
    schema: [
      {
        type: "object",
        properties: {
          routes: { type: "array", items: { type: "string" } },
          ignore: { type: "array", items: { type: "string" } },
        },
        required: ["routes"],
        additionalProperties: false,
      },
    ],
    messages: {
      unknown:
        'Path "{{path}}" matches no route this app serves (its sitemap and shell routes). Link to a registered route.',
    },
  },
  create(context) {
    const options = context.options[0] ?? { routes: [] };
    const routes = options.routes.map(compileRoute);
    const ignore = (options.ignore ?? []).map((source) => new RegExp(source));

    function checkText(node, text) {
      const segments = pathSegments(text);
      if (segments === null) return;
      const plain = displayPath(text);
      if (ignore.some((pattern) => pattern.test(plain))) return;
      if (routes.some((route) => pathMatches(route, segments))) return;
      context.report({ node, messageId: "unknown", data: { path: plain } });
    }

    function checkValue(node) {
      if (!node) return;
      switch (node.type) {
        case "Literal":
          if (typeof node.value === "string") checkText(node, node.value);
          return;
        case "TemplateLiteral": {
          let text = "";
          node.quasis.forEach((quasi, i) => {
            text += quasi.value.cooked ?? quasi.value.raw;
            if (i < node.expressions.length) text += HOLE;
          });
          checkText(node, text);
          return;
        }
        case "ConditionalExpression":
          checkValue(node.consequent);
          checkValue(node.alternate);
          return;
        case "LogicalExpression":
          checkValue(node.left);
          checkValue(node.right);
          return;
        case "JSXExpressionContainer":
        case "ChainExpression":
          checkValue(node.expression);
          return;
        case "TSAsExpression":
        case "TSSatisfiesExpression":
        case "TSNonNullExpression":
          checkValue(node.expression);
          return;
        case "NewExpression":
          // NextResponse.redirect(new URL("/path", request.url)).
          if (node.callee.type === "Identifier" && node.callee.name === "URL") {
            checkValue(node.arguments[0]);
          }
          return;
        default:
          return;
      }
    }

    return {
      JSXAttribute(node) {
        if (node.name.type === "JSXIdentifier" && node.name.name === "href") checkValue(node.value);
      },
      Property(node) {
        if (node.computed) return;
        const key = node.key.type === "Identifier" ? node.key.name : node.key.value;
        if (key === "href") checkValue(node.value);
      },
      CallExpression(node) {
        const { callee } = node;
        if (callee.type === "Identifier" && REDIRECTS.has(callee.name)) {
          checkValue(node.arguments[0]);
          return;
        }
        if (callee.type !== "MemberExpression" || callee.computed) return;
        const method = callee.property.type === "Identifier" ? callee.property.name : null;
        const object = callee.object.type === "Identifier" ? callee.object.name : null;
        if (
          method !== null &&
          NAVIGATION_METHODS.has(method) &&
          object !== null &&
          /router$/i.test(object)
        ) {
          const [target] = node.arguments;
          if (target?.type === "ObjectExpression") {
            const pathname = target.properties.find(
              (p) =>
                p.type === "Property" &&
                !p.computed &&
                p.key.type === "Identifier" &&
                p.key.name === "pathname",
            );
            checkValue(pathname?.value);
          } else {
            checkValue(target);
          }
          return;
        }
        if (method === "redirect" && object === "NextResponse") checkValue(node.arguments[0]);
      },
    };
  },
};
