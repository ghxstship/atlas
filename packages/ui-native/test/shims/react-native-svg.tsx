/* Test-only DOM renderer for react-native-svg: each element maps to its SVG tag. */
import { createElement, type ReactNode } from "react";

type AnyProps = Record<string, unknown> & { children?: ReactNode };

const tag = (name: string) =>
  function SvgElement({ children, ...props }: AnyProps) {
    return createElement(name, props, children);
  };

export default tag("svg");
export const Svg = tag("svg");
export const Circle = tag("circle");
export const Path = tag("path");
export const Rect = tag("rect");
export const G = tag("g");
