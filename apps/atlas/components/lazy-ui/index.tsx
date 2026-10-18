"use client";

import dynamic from "next/dynamic";

/**
 * @xos/ui components a page renders only in some states: the collection views a person switches to
 * (board, calendar, gallery, list, timeline, tree, chart), and overlays that open on an action or a
 * query parameter (Drawer, Dialog). Through next/dynamic their code loads when they first render,
 * not with every route that might show them (ADR 0027, A24-009). A component a route renders in its
 * default state is imported from @xos/ui directly, so the route budget counts it.
 *
 * Each target module re-exports one component from @xos/ui, so a chunk holds only that component.
 */
export const Board = dynamic(() => import("./board").then((m) => m.Board));
export const Calendar = dynamic(() => import("./calendar").then((m) => m.Calendar));
export const Chart = dynamic(() => import("./chart").then((m) => m.Chart));
export const Dialog = dynamic(() => import("./dialog").then((m) => m.Dialog));
export const Drawer = dynamic(() => import("./drawer").then((m) => m.Drawer));
export const Gallery = dynamic(() => import("./gallery").then((m) => m.Gallery));
export const RecordList = dynamic(() => import("./record-list").then((m) => m.RecordList));
export const RecordRow = dynamic(() => import("./record-list").then((m) => m.RecordRow));
export const Timeline = dynamic(() => import("./timeline").then((m) => m.Timeline));
export const TreeView = dynamic(() => import("./tree-view").then((m) => m.TreeView));
