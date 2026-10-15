import { createElement } from "react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import * as darkTokens from "@xos/tokens/native/theme.dark";
import * as sunlightTokens from "@xos/tokens/native/theme.sunlight";
import {
  DEFAULT_THEME,
  ThemeProvider,
  baseTokens,
  createTheme,
  nativeComponentGroups,
  nativeComponentNames,
  nativeComponentStatus,
  resolveThemeName,
  themeNames,
  themes,
  useTheme,
} from "../src/index.ts";

describe("token wiring", () => {
  it("carries every Style Dictionary native color into each theme", () => {
    expect(themes.dark.color.bgCanvas).toBe(darkTokens.colorBgCanvas);
    expect(themes.sunlight.color.textPrimary).toBe(sunlightTokens.colorTextPrimary);
    const darkColorCount = Object.keys(darkTokens).filter((k) => k.startsWith("color")).length;
    for (const name of themeNames) {
      expect(Object.keys(themes[name].color)).toHaveLength(darkColorCount);
    }
  });

  it("normalizes dimensions, durations, springs and typography for React Native", () => {
    expect(baseTokens.density.touchMin).toBe(48);
    expect(baseTokens.space["16"]).toBe(16);
    expect(baseTokens.duration.fast).toBe(120);
    expect(baseTokens.spring.default).toEqual({ damping: 20, stiffness: 220, mass: 1 });
    expect(baseTokens.typography.text16).toEqual({
      fontFamily: "Inter",
      fontSize: 16,
      lineHeight: 23,
      fontWeight: "400",
    });
  });

  it("thickens control borders in Sunlight only (decision D3)", () => {
    expect(createTheme("sunlight").controlBorderWidth).toBe(2);
    expect(createTheme("light").controlBorderWidth).toBe(1);
    expect(themes.dark.dark).toBe(true);
    expect(themes.light.dark).toBe(false);
  });
});

describe("theme resolution", () => {
  it("follows the device for system and falls back to Dark", () => {
    expect(resolveThemeName("system", "light")).toBe("light");
    expect(resolveThemeName("system", "dark")).toBe("dark");
    expect(resolveThemeName("system", null)).toBe(DEFAULT_THEME);
    expect(resolveThemeName("sunlight", "light")).toBe("sunlight");
  });

  it("provides the resolved theme through context", () => {
    function Probe(): ReactElement {
      return createElement("span", null, useTheme().name);
    }
    const inside = renderToStaticMarkup(
      createElement(ThemeProvider, { preference: "sunlight", children: createElement(Probe) }),
    );
    expect(inside).toBe("<span>sunlight</span>");
    const system = renderToStaticMarkup(
      createElement(ThemeProvider, { systemColorScheme: "light", children: createElement(Probe) }),
    );
    expect(system).toBe("<span>light</span>");
    expect(renderToStaticMarkup(createElement(Probe))).toBe("<span>dark</span>");
  });
});

describe("published component list", () => {
  it("names every Compass component from Section 11.4 once", () => {
    expect(new Set(nativeComponentNames).size).toBe(nativeComponentNames.length);
    expect(nativeComponentGroups.compass).toEqual([
      "ClockButton",
      "ScanSheet",
      "OfflineBanner",
      "QuickIncidentSheet",
      "ChecklistRunner",
      "ShiftCard",
      "DaySheetView",
      "SignaturePad",
      "PhotoCapture",
      "LiveActivity",
      "ForceUpdateScreen",
      "SyncConflictSheet",
      "UpNextCard",
    ]);
    expect(nativeComponentStatus.ThemeProvider).toBe("shipped");
    expect(nativeComponentStatus.ClockButton).toBe("published");
  });
});
