---
title: Finance
summary: Budgets, expenses, change orders, invoices and payments, and the books behind them.
kind: page
nodes: [finance, "finance.*", project.budget]
order: 30
---

Finance tracks what a project is expected to cost, what it commits and what it pays.

## Budgets

Build a budget from the catalog at the Base, Elevated or Premium tier. A line with no price shows **Unpriced** and is never counted as zero; the totals say how many lines are still unpriced. A project in another currency shows converted totals with the rate date.

Client pricing sits beside cost. Set a **Default markup %** on the budget or a **Markup %** on a line, or type a **Client unit price** to override both; clearing it returns to the markup. A line with no cost price and no override has no client price and shows **Unpriced**. **Quote lines** chooses which lines go on quotes; the rest stay internal. Switch the grid between **Cost**, **Client pricing** and **Forecast**.

## Versions

**Versions** freezes the budget's plan with **Take snapshot**, and **Compare** shows what was added, removed and changed against the live budget or another version, with deltas that stay blank when either side is unpriced. A version does not replace the gate 3 baseline. Quotes keep their own captures, which cannot be deleted.

## Forecast

The **Forecast** columns show **Remaining commitment**, **Estimate to complete** (type a figure, or leave it blank to derive it), **Estimated final cost** and **Variance at completion**. They are derived from Actual, Committed and approved change orders, so they move with each expense, approval and purchase order. If you can't read the project's purchase orders, expenses or change orders, the figures stay blank rather than partial.

## Actual and Transactions

Actual is approved and paid expenses plus approved crew hours. A shift names the Labor line its time posts to, and approving a timesheet posts that time at the rate in force on each work date. Time with no rate posts unpriced: it shows as **n unpriced hours** and is never counted as zero. Select a line and choose **Transactions** to see what stands behind Actual and Committed. Vendor invoices on the line are listed apart: they post to the ledger and count in the final cost report, not in Actual.

## Quotes

**Quotes** builds a client quote from a budget. A Draft reads live prices, with cost and margin shown only to you under **Internal: never on the quote**. Choose the client engagement on the Draft until a version has been sent; **Send quote** needs one. With a new version open, the page shows the Draft's lines and totals, since those are what you send next. **Send quote** freezes the version and its content fingerprint. Enter an email to get a signing link and access code, shown once, or leave it blank and the client signs in Gateway's Documents tab. Sending a new version supersedes the last one. When the client signs, the quote is accepted and locked; record later changes as a change order. Atlas never holds funds, so a quote has no payment state.

## Import lines

**Import lines** brings budget lines in from .xlsx or .csv through the import wizard, with a reason for every cell it can't read. A row with a line number updates that line, changing only the cells the sheet fills, and the word Unpriced clears its price. Other rows are added in sheet order, and a blank price there stays unpriced. Undo removes the lines the batch created, unless something has come to depend on them since.

## Expenses and change orders

Submit an expense with its receipt. Raise a change order when scope or cost changes. A change order can be saved without a price, and the budget updates when it is priced and approved. Nobody approves their own request.

## Invoices and payments

Invoices from vendors and to clients collect in **Invoices**. Approved invoices become payments. Atlas records each payment; it does not move money.

## Books

- **Journal** and **Periods**: post entries into an open period. Once a period is closed, posting into it is refused.
- **Chart of Accounts** comes from canon; map your general ledger to it. **Cost Centers** are what you report against.
- **Universal Posting Line Export** writes posting lines for your accounting system.
- **Year-End** lists contractors paid the 1099-NEC threshold and downloads the filing file. Full tax identifiers need a Restricted export with step-up.
