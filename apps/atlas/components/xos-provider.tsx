"use client";

/**
 * The @xos/ui provider for the root layout. A boundary file of its own: the root layout is part of
 * every route, and a shared boundary would bring along every component any server component in the
 * app imports from it (ADR 0027, A24-009).
 */
export { XOSProvider } from "@xos/ui";
