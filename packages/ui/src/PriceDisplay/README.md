# PriceDisplay

PriceDisplay prints one price with its billing period and tax label.

Amounts format with the page locale and currency, with no decimals on whole amounts. `taxMode` prints the tax label for the visitor's region: exclusive for United States business pricing, inclusive where consumer price rules require the total. A plan sold by quote passes `from` with its starting price.

The silence rule holds: a `null` amount is unpriced and renders Quoted, never zero. Zero is a claim, used only for a plan that is free.
