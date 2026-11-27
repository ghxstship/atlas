# SegmentedControl

SegmentedControl switches between two to five peer options, such as the view switcher.

- The view switcher offers only views that fit the data; it never shows a disabled option.
- Keyboard: the group is one tab stop, on the segment that is on. Arrow keys, Home and End move focus between segments without turning one on; Enter, Space or a click turns the focused segment on. This is intended: a segment can load a view, and an arrow key that passes over a segment must not load it.
- The billing period group of PricingTable and the theme group of MarketingFooter are the exception. Their change is instant and stays on the page, so an arrow key, Home or End turns on the segment it moves to, as a native radio group does, and the tab stop is always the focused segment.
