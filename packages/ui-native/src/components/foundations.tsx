import type { ReactElement } from "react";
import { Text as RNText } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import { iconAliases } from "@xos/icons";
import { nativeIconRegistry } from "../icons.generated.ts";
import { useTheme, type XosNativeTheme } from "../theme/index.ts";
import type { IconProps, RecordState, StateIconProps, TextProps } from "../types.ts";

type Tone = NonNullable<TextProps["tone"]>;

/** The theme color for a text tone. */
export function toneColor(theme: XosNativeTheme, tone: Tone = "primary"): string {
  switch (tone) {
    case "secondary":
      return theme.color.textSecondary;
    case "tertiary":
      return theme.color.textTertiary;
    case "accent":
      return theme.color.accentText;
    case "success":
      return theme.color.successText;
    case "warning":
      return theme.color.warningText;
    case "danger":
      return theme.color.dangerText;
    default:
      return theme.color.textPrimary;
  }
}

/** Text drawn in an exact theme color; internal, for labels on filled controls. */
export function Ink({
  variant = "text16",
  color,
  numberOfLines,
  heading = false,
  testID,
  children,
}: Omit<TextProps, "tone"> & { color: string }): ReactElement {
  const theme = useTheme();
  const type = theme.typography[variant];
  return (
    <RNText
      {...(numberOfLines === undefined ? {} : { numberOfLines })}
      {...(heading ? { role: "heading" as const } : {})}
      {...(testID === undefined ? {} : { testID })}
      style={{
        fontFamily: type.fontFamily,
        fontSize: type.fontSize,
        lineHeight: type.lineHeight,
        fontWeight: type.fontWeight,
        color,
      }}
    >
      {children}
    </RNText>
  );
}

/** Body and heading text from the typography tokens; scales with the system font size. */
export function Text({ tone = "primary", ...props }: TextProps): ReactElement {
  const theme = useTheme();
  return <Ink {...props} color={toneColor(theme, tone)} />;
}

function pascal(name: string): string {
  const aliased = Object.hasOwn(iconAliases, name) ? (iconAliases[name] ?? name) : name;
  if (/^[A-Z]/.test(aliased)) return aliased;
  return aliased
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

const warned = new Set<string>();

/**
 * A lucide-react-native icon from the @xos/icons registry at 1.5 stroke. Hidden from assistive
 * technology unless `label` says it carries meaning alone. An unregistered name draws an empty box
 * of the same size and warns once.
 */
export function Icon({ tone, ...props }: IconProps): ReactElement {
  const theme = useTheme();
  return <IconInk {...props} color={tone ? toneColor(theme, tone) : theme.color.textPrimary} />;
}

/** An icon drawn in an exact theme color; internal, for icons on filled controls and state hues. */
export function IconInk({
  name,
  size = 24,
  label,
  color,
  testID,
}: Omit<IconProps, "tone" | "size"> & { size?: number; color: string }): ReactElement {
  const key = pascal(name);
  const Glyph = Object.hasOwn(nativeIconRegistry, key) ? nativeIconRegistry[key] : undefined;
  const a11y = label
    ? { role: "img" as const, "aria-label": label }
    : { "aria-hidden": true as const, accessibilityElementsHidden: true };
  if (!Glyph) {
    if (!warned.has(name)) {
      warned.add(name);
      console.warn(
        `@xos/ui-native Icon: "${name}" is not in the @xos/icons registry. Add ${key} to packages/icons/registry/<owner>.txt and regenerate.`,
      );
    }
    return <Svg width={size} height={size} {...a11y} />;
  }
  return (
    <Glyph
      {...a11y}
      {...(testID === undefined ? {} : { testID })}
      size={size}
      strokeWidth={1.5}
      color={color}
    />
  );
}

/** The state hue for each record state; the shape carries the meaning. */
export function stateColor(theme: XosNativeTheme, state: RecordState): string {
  const map: Record<RecordState, string> = {
    proposed: theme.color.stateProposed,
    ready: theme.color.stateReady,
    scheduled: theme.color.stateScheduled,
    active: theme.color.stateActive,
    blocked: theme.color.stateBlocked,
    "in-review": theme.color.stateInReview,
    complete: theme.color.stateComplete,
    deferred: theme.color.stateDeferred,
    canceled: theme.color.stateCanceled,
  };
  return map[state];
}

/** One of the nine record state icons, the same shapes as the web StateIcon. Decorative: pair it with a label. */
export function StateIcon({ state, size = 20, testID }: StateIconProps): ReactElement {
  const theme = useTheme();
  const ink = stateColor(theme, state);
  const cut = theme.color.bgCanvas;
  const ring = (dash?: string) => (
    <Circle
      cx={8}
      cy={8}
      r={6}
      fill="none"
      stroke={ink}
      strokeWidth={1.5}
      {...(dash ? { strokeDasharray: dash } : {})}
    />
  );
  const line = { fill: "none", stroke: ink, strokeWidth: 1.5, strokeLinecap: "round" as const };
  let body: ReactElement;
  switch (state) {
    case "proposed":
      body = ring("2.2 2.2");
      break;
    case "scheduled":
      body = (
        <>
          {ring()}
          <Path d="M8 5v3.25l2 1.25" {...line} />
        </>
      );
      break;
    case "active":
      body = (
        <>
          {ring()}
          <Path d="M8 4.5a3.5 3.5 0 0 1 0 7z" fill={ink} />
        </>
      );
      break;
    case "blocked":
      body = (
        <>
          <Path d="M5.5 2h5L14 5.5v5L10.5 14h-5L2 10.5v-5z" fill={ink} />
          <Path d="M5.5 8h5" stroke={cut} strokeWidth={1.5} strokeLinecap="round" />
        </>
      );
      break;
    case "in-review":
      body = (
        <>
          {ring()}
          <Path
            d="M4.75 8s1.25-2 3.25-2s3.25 2 3.25 2s-1.25 2-3.25 2s-3.25-2-3.25-2z"
            fill="none"
            stroke={ink}
            strokeWidth={1.25}
          />
          <Circle cx={8} cy={8} r={0.9} fill={ink} />
        </>
      );
      break;
    case "complete":
      body = (
        <>
          <Circle cx={8} cy={8} r={6.75} fill={ink} />
          <Path
            d="M5.25 8.25l1.75 1.75l3.5-4"
            fill="none"
            stroke={cut}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      );
      break;
    case "deferred":
      body = (
        <>
          {ring()}
          <Path d="M6.75 5.75v4.5M9.25 5.75v4.5" {...line} />
        </>
      );
      break;
    default:
      body = (
        <>
          {ring()}
          <Path d="M4 12l8-8" {...line} />
        </>
      );
  }
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden
      {...(testID === undefined ? {} : { testID })}
    >
      {body}
    </Svg>
  );
}
