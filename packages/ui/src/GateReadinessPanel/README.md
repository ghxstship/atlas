# GateReadinessPanel

GateReadinessPanel lists a gate's criteria as a checklist with evidence, blocking flags and the action that clears each gap.

- Criteria, statements and blocking flags come from `xpms.dim_gate_criterion` (Bible tab 06, 35 criteria); the panel never defines them.
- Codes display as stored (`G3.PERMITS_FILED`) beside a plain statement, in numeric gate order.
- The next-gate button enables the moment the last blocking criterion is met; the database enforces the same rule.
- The preview shows all five Gate 3 criteria with their Bible statements verbatim, in Bible order. All five are blocking.

## On a public page

`@xos/ui/marketing` exports a GateReadinessPanel that renders on the server with no client module. It draws the same markup and takes `locale` and `messages` as props, where the `@xos/ui` panel reads the nearest XOSProvider. It takes no `onAdvance` and no `onCriterionAction`, because a function cannot cross from a server component to the browser, so its buttons act on nothing. Show it inside ScreenshotFrame, which makes it inert and names it as one image.
