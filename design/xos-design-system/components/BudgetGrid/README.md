# BudgetGrid

BudgetGrid groups budget lines by GL account in numeric order, then by cost center and URID, with a grade toggle.

- GL posting is derived, never stored. A line carries its URID; the URID class (first segment) selects that class's one account of the requested type from the GL Accounts table passed as `accounts` (Expense by default). 5000.01.02 posts to 5500 Expense · Production because class 5000 owns 5500. A line whose class has no account groups last under Unmapped Account with a warning icon, so a gap in the chart is visible rather than silently misposted.
- Amount is derived as quantity times the selected grade's rate. It is never stored, and a blank input gives a blank amount.
- Totals follow the silence rule: any unpriced line makes its subtotal and the total Unpriced.
- Line types are Scope, Overhead, Contingency, Fee and Retainer. Fee and Contingency are line types, not accounts.
- Grades are Base, Elevated and Premium (build prompt, decision D11). Grade labels are passed as `grades` from the enumeration table, never hard-coded.
- The preview uses Item Catalog lines and prices verbatim. Ungraded items carry the same rate in every grade; graded touchpoint items such as Artist-Rooted Cultural Menu are unpriced in the catalog, which is why the Hospitality subtotal and the total read Unpriced.
