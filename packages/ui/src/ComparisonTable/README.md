# ComparisonTable

ComparisonTable compares one product with others, feature by feature, in a real table.

Every cell carries a word beside its icon: Yes, Partial, No or Unpublished. Unpublished means the other product's public pages do not state the feature; it never means the feature is absent. The caption states when the cells were last verified, and a cell may link to its source. The own-product column is marked with `highlight`.

From bp-md the table scrolls inside a labeled region with sticky row headers. Below bp-md it stacks into one card per feature with each product on its own labeled line, and explicit table roles keep it a table for screen readers. Sorting is off by design.

The consumer provides only rows where its own product is shipped and each other cell has a dated source. Other products' names appear in plain text, never as logos. The preview uses neutral product names.
