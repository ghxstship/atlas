/**
 * The help content model (Section 11.16) for Atlas. Help content lives in apps/atlas/help:
 *
 *   articles/<locale>/<slug>.md   one article per page or workflow, with frontmatter (title,
 *                                 summary, kind, nodes, order) naming the sitemap nodes it helps with
 *   tours.yaml                    guided tours (copy in help.tours.<key>)
 *   tips.yaml                     contextual tips (copy in help.tips.<key>)
 *   whats-new.yaml                dated release notes (copy in help.whatsNew.<key>)
 *
 * The model, its Markdown subset and the queries are shared with Gateway, Compass and the docs help
 * center in @xos/help. The generator test (test/help.test.ts, XOS_WRITE_GENERATED=1) parses
 * everything into content.generated.ts (the index: articles without bodies, tours, tips and What's
 * New), guides.generated.ts (tours and tips) and bodies.generated.ts (article bodies), which the help
 * panel loads only when it opens (A24-009). Every article exists in every locale.
 */
export * from "@xos/help";
