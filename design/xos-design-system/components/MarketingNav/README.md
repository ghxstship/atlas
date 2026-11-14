# MarketingNav

MarketingNav is the sticky header of a public page: brand, section links and the primary call to action.

A skip link comes first in the tab order and targets `#main`. From bp-lg the section links sit in the bar; below it they move into a menu panel opened by a labeled toggle with `aria-expanded`. `actions` stays visible at every width, so the primary call to action is never more than one tap away. `secondaryActions` hides below bp-sm and repeats inside the panel.

The consumer provides a BrandMark as `brand`, the links, and ButtonLink elements for the actions. Mark the current page with `current`.
