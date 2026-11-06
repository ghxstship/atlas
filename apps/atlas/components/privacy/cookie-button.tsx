"use client";

/**
 * Button for the cookie banner. A boundary file of its own: the root layout is part of every route,
 * and importing it through components/ui.tsx brings every component any server component in the app
 * imports from there (ADR 0027).
 */
export { Button } from "@xos/ui";
