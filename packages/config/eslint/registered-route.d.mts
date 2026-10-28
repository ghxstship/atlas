import type { Rule } from "eslint";

export type RouteSegment =
  | { readonly kind: "static"; readonly value: string }
  | { readonly kind: "param"; readonly suffix: string }
  | { readonly kind: "rest" };

export declare function compileRoute(pattern: string): RouteSegment[];
export declare function pathSegments(text: string): string[] | null;
export declare function pathMatches(
  route: readonly RouteSegment[],
  segments: readonly string[],
): boolean;
export declare const registeredRoute: Rule.RuleModule;
