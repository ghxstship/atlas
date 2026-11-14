import { currentConfig, translate, type Messages, type MessageVars } from "../lib/i18n.ts";

/** A locale and a `t` bound to it, for components that render without hooks or context. */
export interface MarketingCopy {
  locale: string;
  t: (key: string, vars?: MessageVars) => string;
}

/**
 * Resolves the shared Marketing strings without a provider: the `locale` and `messages` props when
 * the page gives them, otherwise what `configure` set. It reads no context, so a server component
 * can call it (ADR 0027).
 */
export function marketingCopy({
  locale,
  messages,
}: {
  locale: string | undefined;
  messages: Messages | undefined;
}): MarketingCopy {
  const config = currentConfig();
  const resolved = locale ?? config.locale;
  const merged = messages === undefined ? config.messages : { ...config.messages, ...messages };
  return { locale: resolved, t: (key, vars) => translate(resolved, key, vars, merged) };
}
