/**
 * Components that render without hooks, context or event handlers, for React Server Components. A
 * boundary that renders only these (a not-found page, a loading skeleton) sends no JavaScript,
 * while one that imports from "@xos/ui" needs a client module, which loads with every route
 * (ADR 0027).
 */
export { Skeleton, type SkeletonProps } from "./Surface/Skeleton.tsx";
export { TemplateSystemLink } from "./Templates/TemplateSystemLink.tsx";
export type { TemplateSystemLinkProps } from "./Templates/Templates.types.ts";
