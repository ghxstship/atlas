"use client";

import dynamic from "next/dynamic";

/**
 * Finance client components that a page renders only in some states: a budget's grid once one is
 * chosen, the table view, the side peek, a create or edit sheet and its form, and a record's
 * comments and attachments. Server components render them through next/dynamic, so their code loads
 * when they render, not with every finance route (ADR 0027, A24-009). What a page renders in its
 * default state is imported directly, so the route budget counts it.
 */
export const BudgetEditor = dynamic(() => import("./budget-editor").then((m) => m.BudgetEditor));
export const BudgetForm = dynamic(() => import("./forms-budget-form").then((m) => m.BudgetForm));
export const CollectionTable = dynamic(() =>
  import("./kit-collection-table").then((m) => m.CollectionTable),
);
export const EditButton = dynamic(() => import("./kit-edit-button").then((m) => m.EditButton));
export const FinanceAttachments = dynamic(() =>
  import("./collab").then((m) => m.FinanceAttachments),
);
export const FinanceComments = dynamic(() => import("./collab").then((m) => m.FinanceComments));
export const FormSheet = dynamic(() => import("./kit-form-sheet").then((m) => m.FormSheet));
export const InlineActionButton = dynamic(() =>
  import("./kit-inline-action-button").then((m) => m.InlineActionButton),
);
export const RecordPeek = dynamic(() => import("./kit-record-peek").then((m) => m.RecordPeek));
