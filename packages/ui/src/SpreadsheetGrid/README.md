# SpreadsheetGrid

SpreadsheetGrid edits money and numbers at spreadsheet speed: arrow keys, Enter to edit, fill handle, Excel paste, NULL-aware cells.

- Deleting a cell sets it to Unpriced, never 0.
- A totals row is blank when any line is blank.
- `type: 'multiplier'` stores a plain number and displays it with one decimal and an x (1.5 shows as 1.5x, 2 as 2.0x). Typing 1.5x commits 1.5; the stored value is never text.
- `derive` makes a read-only column computed from the row. Use it for any value whose source of truth is another table, so the grid never holds a second copy. Derived cells use secondary text, refuse edits and explain why on hover.
- The preview is the Playbook Labor Rate Cards (decision D12). Each row stores only its own facts: rate card ID, role code, worker classification, pay basis, arrangement, standard rate and overtime rule. Classification, pay basis and arrangement are separate facts (decision D16): W2 Daily, Contractor 1099 and Vendor Master became Employee, Independent Contractor and Vendor-Supplied. Job Title comes from the Roles Library by role code; OT and DT come from the referenced overtime rule (decision D14), so the grid shows the multipliers and the row stores only the rule; GL Account is derived from the role code's class through the GL Accounts table (decision D13), which is why 9000.50.01 Production Stage Manager posts to 5900 Expense · Technology. The same joins are the `rate_card_resolved` view in `export/canon/schema.sql`.
