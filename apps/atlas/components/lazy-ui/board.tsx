"use client";

import dynamic from "next/dynamic";

/** @xos/ui Board, loaded when first rendered (see deferred.tsx and ADR 0027). */
export const Board = dynamic(() => import("./targets/board").then((m) => m.Board));
