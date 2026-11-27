# Link

Link navigates; Button acts. External links show an arrow and open in a new tab.

- Dark theme links use `focus-ring` for contrast; light theme links use `accent-default`.

## On a public page

`@xos/ui/marketing` exports a Link that renders on the server with no client module. It draws the same anchor and takes `locale` and `messages` as props for the new-tab label, where the `@xos/ui` Link reads the nearest XOSProvider. Without them it reads what `configure` set, en-US by default.
