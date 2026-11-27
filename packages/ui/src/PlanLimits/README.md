# PlanLimits

PlanLimits is a list of label and value rows, with the value in tabular figures at the end of the row. PricingTable draws a plan's limits with it, and a public page uses it for any short list of named amounts, such as a price summary or an allowance.

- `limits` holds the rows in order. Each has a `label` and a `value`, and both arrive written for the page's locale: the component formats nothing.
- It renders a description list, so a screen reader reads each value with its label.

It holds no state and prints no shared string, so it renders on the server from `@xos/ui/marketing` and takes no `locale` or `messages`.
