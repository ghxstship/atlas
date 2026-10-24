import { TYPE, parse, type MessageFormatElement } from "@formatjs/icu-messageformat-parser";

export type Catalog = { readonly [key: string]: string | Catalog };

/** Flattens a nested catalog to dotted keys. */
export function flatten(catalog: Catalog, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(catalog)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out.set(path, value);
    else for (const [k, v] of flatten(value, path)) out.set(k, v);
  }
  return out;
}

const KIND: Partial<Record<TYPE, string>> = {
  [TYPE.argument]: "argument",
  [TYPE.number]: "number",
  [TYPE.date]: "date",
  [TYPE.time]: "time",
  [TYPE.select]: "select",
  [TYPE.plural]: "plural",
  [TYPE.tag]: "tag",
};

function collect(elements: readonly MessageFormatElement[], out: Map<string, string>): void {
  for (const el of elements) {
    const kind = KIND[el.type];
    if (kind !== undefined && "value" in el && typeof el.value === "string") {
      out.set(
        el.value,
        kind === "plural" && "pluralType" in el && el.pluralType === "ordinal"
          ? "selectordinal"
          : kind,
      );
    }
    if (el.type === TYPE.select || el.type === TYPE.plural) {
      for (const option of Object.values(el.options)) collect(option.value, out);
    }
    if (el.type === TYPE.tag) collect(el.children, out);
  }
}

// The catalogs repeat most strings: a Beta locale reads en-US for every key it lacks, and the suites
// ask for the arguments of the same en-US message several times. Each distinct message is parsed once
// per test file.
const parsed = new Map<string, readonly string[]>();

/** Parses an ICU message and returns its arguments as `name:kind`, sorted. Throws on invalid ICU. */
export function icuArguments(message: string): readonly string[] {
  const known = parsed.get(message);
  if (known !== undefined) return known;
  const args = new Map<string, string>();
  collect(parse(message), args);
  const result = Object.freeze([...args].map(([name, kind]) => `${name}:${kind}`).sort());
  parsed.set(message, result);
  return result;
}
