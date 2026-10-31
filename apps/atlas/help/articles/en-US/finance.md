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

## Expenses and change orders

Submit an expense with its receipt. Raise a change order when scope or cost changes. A change order can be saved without a price, and the budget updates when it is priced and approved. Nobody approves their own request.

## Invoices and payments

Invoices from vendors and to clients collect in **Invoices**. Approved invoices become payments. Atlas records each payment; it does not move money.

## Books

- **Journal** and **Periods**: post entries into an open period. Once a period is closed, posting into it is refused.
- **Chart of Accounts** comes from canon; map your general ledger to it. **Cost Centers** are what you report against.
- **Universal Posting Line Export** writes posting lines for your accounting system.
- **Year-End** lists contractors paid the 1099-NEC threshold and downloads the filing file. Full tax identifiers need a Restricted export with step-up.

## Read invoice lines with Aurora

On a Proposed payable invoice, **Read lines from a document** reads the vendor's lines and printed totals. Choose each line's budget line yourself; earlier lines of the same vendor are shown as hints, with a badge when the price differs by 10% or more. The tie-out compares the lines with the printed total on every edit, rounding as the invoice does. When they differ, check **I checked the difference** before you add the lines. A receipt read with Aurora shows its items and the same tie-out, read-only.
