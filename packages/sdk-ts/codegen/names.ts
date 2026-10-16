/** Identifier conversions shared by the emitters. */

export function pascalCase(value: string): string {
  return value
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

export function camelCase(value: string): string {
  const pascal = pascalCase(value);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

export function snakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase();
}

const PYTHON_KEYWORDS: ReadonlySet<string> = new Set(
  "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield".split(
    " ",
  ),
);

/** Keyword arguments of the generated methods that a path or query parameter must not shadow. */
const PYTHON_SHADOWED: ReadonlySet<string> = new Set(
  "self body filter limit cursor fields sort options idempotency_key if_match".split(" "),
);

/** A Python identifier for a wire name; keywords and shadowed names get a trailing underscore. */
export function pythonIdentifier(wireName: string): string {
  const base = snakeCase(wireName);
  return PYTHON_KEYWORDS.has(base) || PYTHON_SHADOWED.has(base) ? `${base}_` : base;
}

export function isPythonKeyword(name: string): boolean {
  return PYTHON_KEYWORDS.has(name);
}

const TS_RESERVED = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "let",
  "static",
  "implements",
  "interface",
  "package",
  "private",
  "protected",
  "public",
  "await",
]);

/** A TypeScript local variable name for a wire name. */
export function tsIdentifier(wireName: string): string {
  const base = camelCase(wireName);
  return TS_RESERVED.has(base) ? `${base}Value` : base;
}

/** A property key in TypeScript source: bare when it is a valid identifier, quoted otherwise. */
export function tsPropertyKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}
