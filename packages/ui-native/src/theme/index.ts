import { createContext, createElement, useContext, useMemo } from "react";
import type { ReactElement, ReactNode } from "react";
import { baseTokens, themeTokens } from "./tokens.generated.ts";

export { baseTokens, themeTokens };

/** The three XOS themes. Dark is the default; Sunlight is the Compass maximum-contrast outdoor theme. */
export type ThemeName = keyof typeof themeTokens;

/** A person's stored preference: a theme, or "system" to follow the device. */
export type ThemePreference = ThemeName | "system";

/** The device appearance as React Native's useColorScheme reports it. */
export type SystemColorScheme = "light" | "dark" | null | undefined;

export const themeNames: readonly ThemeName[] = ["dark", "light", "sunlight"];

export type ColorToken = keyof (typeof themeTokens)["dark"]["color"];
export type TypographyToken = keyof typeof baseTokens.typography;
export type SpaceToken = keyof typeof baseTokens.space;

/** Everything a native component reads to draw itself: base tokens plus the active theme's colors. */
export interface XosNativeTheme {
  readonly name: ThemeName;
  readonly dark: boolean;
  readonly color: Readonly<Record<ColorToken, string>>;
  readonly shadow: (typeof themeTokens)[ThemeName]["shadow"];
  readonly space: typeof baseTokens.space;
  readonly radius: typeof baseTokens.radius;
  readonly strokeWidth: typeof baseTokens.strokeWidth;
  /** Boundary width of inputs, switches, checkboxes and segmented controls: 2 in Sunlight (decision D3), 1 otherwise. */
  readonly controlBorderWidth: number;
  readonly opacity: typeof baseTokens.opacity;
  readonly iconSize: typeof baseTokens.iconSize;
  readonly density: typeof baseTokens.density;
  readonly duration: typeof baseTokens.duration;
  readonly easing: typeof baseTokens.easing;
  readonly spring: typeof baseTokens.spring;
  readonly fontWeight: typeof baseTokens.fontWeight;
  readonly typography: typeof baseTokens.typography;
}

export const DEFAULT_THEME: ThemeName = "dark";

/** The theme to draw for a preference. "system" follows the device and falls back to Dark. */
export function resolveThemeName(
  preference: ThemePreference,
  system: SystemColorScheme,
): ThemeName {
  if (preference !== "system") return preference;
  return system === "light" ? "light" : DEFAULT_THEME;
}

/** Builds the full native theme object for a theme name. */
export function createTheme(name: ThemeName): XosNativeTheme {
  const theme = themeTokens[name];
  return {
    name,
    dark: name === "dark",
    color: theme.color,
    shadow: theme.shadow,
    space: baseTokens.space,
    radius: baseTokens.radius,
    strokeWidth: baseTokens.strokeWidth,
    controlBorderWidth: name === "sunlight" ? 2 : 1,
    opacity: baseTokens.opacity,
    iconSize: baseTokens.iconSize,
    density: baseTokens.density,
    duration: baseTokens.duration,
    easing: baseTokens.easing,
    spring: baseTokens.spring,
    fontWeight: baseTokens.fontWeight,
    typography: baseTokens.typography,
  };
}

export const themes: Readonly<Record<ThemeName, XosNativeTheme>> = {
  dark: createTheme("dark"),
  light: createTheme("light"),
  sunlight: createTheme("sunlight"),
};

const ThemeContext = createContext<XosNativeTheme>(themes[DEFAULT_THEME]);

/** Haptic feedback kinds components request; the app maps them to expo-haptics. */
export type HapticKind = "impact" | "selection" | "success" | "warning";
export type HapticHandler = (kind: HapticKind) => void;

const HapticContext = createContext<HapticHandler | undefined>(undefined);

export interface ThemeProviderProps {
  /** The person's preference; "system" by default. */
  preference?: ThemePreference;
  /** Pass React Native's useColorScheme() result so "system" can follow the device. */
  systemColorScheme?: SystemColorScheme;
  /** Plays haptic feedback, for example with expo-haptics. Omit it, or pass nothing when the person turns haptics off. */
  onHaptic?: HapticHandler;
  children: ReactNode;
}

/** Supplies the active XOS theme to every @xos/ui-native component below it. */
export function ThemeProvider({
  preference = "system",
  systemColorScheme,
  onHaptic,
  children,
}: ThemeProviderProps): ReactElement {
  const name = resolveThemeName(preference, systemColorScheme);
  const value = useMemo(() => themes[name], [name]);
  return createElement(
    ThemeContext.Provider,
    { value },
    createElement(HapticContext.Provider, { value: onHaptic }, children),
  );
}

/** The active XOS theme. Outside a ThemeProvider this is Dark. */
export function useTheme(): XosNativeTheme {
  return useContext(ThemeContext);
}

/** A function that plays a haptic of the given kind when the app supplied a handler, and does nothing otherwise. */
export function useHaptic(): HapticHandler {
  const handler = useContext(HapticContext);
  return (kind) => handler?.(kind);
}
