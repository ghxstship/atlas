# PersonaSwitcher

PersonaSwitcher routes each audience to its own proof with a tab per role.

Every panel is rendered, so each audience's copy is in the document for search and answer engines; only the selected panel is shown. Left, Right, Home and End move between tabs, and the direction follows `dir`. The selected tab is kept in the URL hash (`#for-finance`), which makes each audience linkable from an ad or an email. Tabs scroll sideways below bp-sm.

The consumer provides the personas: a label, a headline, one paragraph, up to four points and one primary and one secondary call to action. Set `hash={false}` inside a sandboxed frame.
