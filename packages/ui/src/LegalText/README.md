# LegalText

LegalText renders a legal document's Markdown as plain, styled elements on a server component. It has no hooks and no script, so it adds nothing to the browser's bundle, and it writes no HTML string.

- Import it from `@xos/ui/legal-text`, not through an app's client boundary.
- The text stays in English in every locale and is marked `lang="en-US"`.
- A wide table scrolls in a labeled region in the tab order; the page itself never scrolls sideways.
- A `/legal/{slug}` path in the text, an email address, and a "Section 3.6" of the same document become links. The page decides where a document's path leads through `hrefFor`.
- `LegalOutline` fits TemplateDocument's sidebar; `LegalContents` is the same list in the flow of the page, for where there is no sidebar.
- `legalTextSource` writes the module an app's generator checks in, so the text reaches the server without reading a file at runtime.
