/* @xos/ui public API. Component names and prop shapes follow the frozen reference contracts in
   src/types/reference.d.ts (design/xos-design-system/components/index.d.ts). */

export { cx } from "./lib/cx.ts";
export {
  configure,
  t,
  translate,
  catalogFor,
  flattenMessages,
  directionOf,
  type XOSConfig,
  type MessageVars,
  type Messages,
} from "./lib/i18n.ts";
export {
  XOSProvider,
  useLocale,
  useT,
  useFormat,
  type XOSProviderProps,
  type Translate,
} from "./lib/context.tsx";
export {
  applyTheme,
  resolveTheme,
  isThemePreference,
  themes,
  themePreferences,
  type Theme,
  type ThemePreference,
} from "./lib/theme.ts";
export * from "./lib/format.ts";
