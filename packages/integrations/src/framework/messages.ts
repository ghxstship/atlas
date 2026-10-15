import { getMessages, type Locale } from "@xos/i18n";

/** Copy the integrations send to people outside Atlas (chat messages), from the `integrations` namespace. */
export type Translate = (key: string, args?: Readonly<Record<string, string | number>>) => string;

type Tree = { readonly [key: string]: string | Tree };

/**
 * A translator over the `integrations` namespace. Messages use simple `{name}` arguments only. A
 * missing key or argument throws, so a raw key or a stray brace never reaches a channel.
 */
export function integrationsTranslator(locale: Locale): Translate {
  const catalog = (getMessages(locale) as unknown as Tree)["integrations"];
  if (typeof catalog !== "object")
    throw new Error(`The ${locale} catalog has no integrations namespace.`);
  return (key, args = {}) => {
    let node: string | Tree | undefined = catalog;
    for (const segment of key.split(".")) {
      node = typeof node === "object" ? node[segment] : undefined;
    }
    if (typeof node !== "string")
      throw new Error(`Missing integrations message ${key} in ${locale}.`);
    return node.replace(/\{(\w+)\}/g, (_match, name: string) => {
      const value = args[name];
      if (value === undefined)
        throw new Error(`Message integrations.${key} needs the ${name} argument.`);
      return String(value);
    });
  };
}
