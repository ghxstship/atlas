# Fonts

The tokens name two font families. No package in the XOS Design System ships a font file, and no stylesheet or script in
`@xos/tokens` or `@xos/ui` requests one from another host: the release check in `infra/ci/pack-design-packages.mjs` fails
on any remote `@import`, remote `url()` or other remote address in a published file. A site that wants the two families
serves the files from its own origin. `fonts.json` beside this file holds the same facts for tools, and
`test/fonts.test.ts` keeps it equal to the tokens.

## What to serve

| Family         | Token                                     | `font-family` names the token matches | Weights            | Style  | Used for                    |
| -------------- | ----------------------------------------- | ------------------------------------- | ------------------ | ------ | --------------------------- |
| Inter          | `font.family.sans` (`--font-family-sans`) | `Inter`, then `Inter Variable`        | 400, 500, 600, 700 | normal | All interface text          |
| JetBrains Mono | `font.family.mono` (`--font-family-mono`) | `JetBrains Mono`                      | 400, 500           | normal | URIDs, codes, keys and URNs |

The weights are the four `font.weight` tokens: regular 400, medium 500, semibold 600 and bold 700. The components set
monospace text in regular and medium; a browser synthesizes a heavier weight that monospace text inherits. No italic
face is needed: the components set no italic text, and a browser slants the upright face for italic a person types in
the rich text editor.

## Files

Both families are published under the SIL Open Font License 1.1, which allows a site to host them. Take the files from
each project's own release, keep its `OFL.txt` beside them, and serve them from the same origin as the page.

| Family         | Files, as the upstream release names them                                                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inter          | `InterVariable.woff2`, one file for every weight. Or the four static files `Inter-Regular.woff2`, `Inter-Medium.woff2`, `Inter-SemiBold.woff2` and `Inter-Bold.woff2`. |
| JetBrains Mono | `JetBrainsMono-Regular.woff2` and `JetBrainsMono-Medium.woff2`.                                                                                                        |

Declare them under the family names above, before the token stylesheet or after it. With the files in `/fonts/` on the
site's origin:

```css
@font-face {
  font-family: "Inter";
  font-style: normal;
  font-weight: 400 700;
  font-display: swap;
  src: url("/fonts/InterVariable.woff2") format("woff2");
}
@font-face {
  font-family: "JetBrains Mono";
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url("/fonts/JetBrainsMono-Regular.woff2") format("woff2");
}
@font-face {
  font-family: "JetBrains Mono";
  font-style: normal;
  font-weight: 500;
  font-display: swap;
  src: url("/fonts/JetBrainsMono-Medium.woff2") format("woff2");
}
```

In Next.js, `next/font/local` serves files kept in the consuming repository and names the family itself. Set its
`variable` option and put that variable first in the two token properties, for example
`--font-family-sans: var(--font-inter), system-ui, sans-serif`, in a rule that follows the token stylesheet.

## Without the files

Nothing breaks. Each token is a list: a browser uses a copy of Inter or JetBrains Mono installed on the device, and
otherwise the next family (`system-ui` for text, `ui-monospace` for code). Atlas and Gateway run this way: they serve no
font file, and their content security policy allows fonts from their own origin only.

## Why the packages do not ship the files

Atlas keeps no web font file in the repository, so there is nothing for a package to carry, and a consumer chooses its
own subset, format and caching. The design export under `design/` loads both families from Google Fonts in the first
line of `components/bundle.css`; that line is not ported. `packages/ui/src/styles/reference.css` is the export without
it, and `packages/ui/test/styles.test.ts` fails if any stylesheet of `@xos/ui` names another host.
