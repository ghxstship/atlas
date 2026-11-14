# PricingTable

PricingTable shows the plans side by side with a monthly and annual billing toggle.

The toggle is a SegmentedControl, and a polite live region announces each change. Prices render through PriceDisplay, so tax labels and the silence rule apply. `terms` prints renewal, trial and cancellation terms with the plans, before anyone leaves the page. One plan may be marked `recommended`; nothing is preselected or pre-checked, and no countdown or scarcity copy belongs here.

From bp-lg the plans sit in one row. Below it they become a snapped horizontal list, with each plan's button reachable by keyboard.

The consumer provides plans from the plan registry (`packages/schemas/plans.yaml`); prices never come from anywhere else. Show only currencies of open territories.
