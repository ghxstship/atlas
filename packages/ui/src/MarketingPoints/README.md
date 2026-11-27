# MarketingPoints

MarketingPoints is a list of short claims, each led by an icon. The persona, surface and plan cards draw their points with it, and a public page uses it for any list of the same kind.

- `points` holds the claims, one line each.
- `icon` names the registered icon that leads every point. It is a check by default.
- `iconColor` takes a CSS color such as `var(--color-text-secondary)`. The icon is success green by default; pass a neutral color when the icon is not a check, so green keeps meaning done.
- The icons are decorative and hidden from screen readers: the claim is the text.

It holds no state and prints no shared string, so it renders on the server from `@xos/ui/marketing` and takes no `locale` or `messages`.
