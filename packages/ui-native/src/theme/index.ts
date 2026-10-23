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

type TypographyStyle = (typeof baseTokens.typography)[keyof typeof baseTokens.typography];

/** Type styles with sizes a person's text size may scale (me.text_size). */
export type NativeTypography = {
  readonly [K in keyof typeof baseTokens.typography]: Omit<
    TypographyStyle,
    "fontSize" | "lineHeight"
  > & { readonly fontSize: number; readonly lineHeight: number };
};

/** Motion durations in milliseconds; reduced motion shortens every one (me.reduced_motion). */
export type NativeDurations = { readonly [K in keyof typeof baseTokens.duration]: number };

/**
 * The person's accessibility settings a theme applies (Section 4.5.6 Accessibility, A65-001): text size as a
 * scale, high contrast, and reduced motion.
 */
export interface ThemeOptions {
  readonly textScale?: number;
  readonly highContrast?: boolean;
  readonly reduceMotion?: boolean;
  /**
   * A tenant brand's colors per theme (Section 12): token values that replace the platform's in that theme.
   * The app passes only overrides it has checked against the contrast pairs; a theme left out keeps the
   * platform colors.
   */
  readonly brandColors?: Readonly<
    Partial<Record<ThemeName, Readonly<Partial<Record<ColorToken, string>>>>>
  >;
}

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
  readonly duration: NativeDurations;
  readonly easing: typeof baseTokens.easing;
  readonly spring: typeof baseTokens.spring;
  readonly fontWeight: typeof baseTokens.fontWeight;
  readonly typography: NativeTypography;
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

function scaledTypography(scale: number): NativeTypography {
  const out: Record<string, TypographyStyle> = {};
  for (const [key, style] of Object.entries(baseTokens.typography)) {
    out[key] = {
      ...style,
      fontSize: Math.round(style.fontSize * scale),
      lineHeight: Math.round(style.lineHeight * scale),
    } as TypographyStyle;
  }
  return out as unknown as NativeTypography;
}

function reducedDurations(): NativeDurations {
  const d = baseTokens.duration;
  const reduced = (ms: number) => (ms === 0 ? 0 : Math.min(ms, d.reduced));
  return {
    base: reduced(d.base),
    deliberate: reduced(d.deliberate),
    fast: reduced(d.fast),
    instant: 0,
    reduced: d.reduced,
    slow: reduced(d.slow),
  };
}

/**
 * Builds the full native theme object for a theme name. Options apply the person's accessibility settings:
 * a text scale, high contrast (secondary text and borders as strong as primary ones) and reduced motion.
 */
export function createTheme(name: ThemeName, options: ThemeOptions = {}): XosNativeTheme {
  const theme = themeTokens[name];
  const branded = { ...theme.color, ...options.brandColors?.[name] };
  const color = options.highContrast
    ? {
        ...branded,
        textSecondary: theme.color.textPrimary,
        textTertiary: theme.color.textPrimary,
        borderSubtle: theme.color.borderStrong,
        borderControl: theme.color.borderStrong,
      }
    : branded;
  return {
    name,
    dark: name === "dark",
    color,
    shadow: theme.shadow,
    space: baseTokens.space,
    radius: baseTokens.radius,
    strokeWidth: baseTokens.strokeWidth,
    controlBorderWidth: name === "sunlight" ? 2 : 1,
    opacity: baseTokens.opacity,
    iconSize: baseTokens.iconSize,
    density: baseTokens.density,
    duration: options.reduceMotion ? reducedDurations() : baseTokens.duration,
    easing: baseTokens.easing,
    spring: baseTokens.spring,
    fontWeight: baseTokens.fontWeight,
    typography:
      options.textScale && options.textScale !== 1
        ? scaledTypography(options.textScale)
        : baseTokens.typography,
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
  /** The person's text size, contrast and motion settings. */
  options?: ThemeOptions;
  children: ReactNode;
}

/** Supplies the active XOS theme to every @xos/ui-native component below it. */
export function ThemeProvider({
  preference = "system",
  systemColorScheme,
  onHaptic,
  options,
  children,
}: ThemeProviderProps): ReactElement {
  const name = resolveThemeName(preference, systemColorScheme);
  const textScale = options?.textScale ?? 1;
  const highContrast = options?.highContrast ?? false;
  const reduceMotion = options?.reduceMotion ?? false;
  const brand = options?.brandColors?.[name];
  // One key for the brand's colors, so a new options object with the same colors keeps the theme.
  const brandKey = brand ? JSON.stringify(brand) : "";
  const value = useMemo(
    () =>
      textScale === 1 && !highContrast && !reduceMotion && brandKey === ""
        ? themes[name]
        : createTheme(name, {
            textScale,
            highContrast,
            reduceMotion,
            ...(brandKey
              ? {
                  brandColors: {
                    [name]: JSON.parse(brandKey) as Partial<Record<ColorToken, string>>,
                  },
                }
              : {}),
          }),
    [name, textScale, highContrast, reduceMotion, brandKey],
  );
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
