# Architecture Decision Records

Each record states one decision, the alternatives considered and the reason. A decision changes only through a new record that supersedes it.

| ADR                                            | Title                               | Status   |
| ---------------------------------------------- | ----------------------------------- | -------- |
| [0001](0001-stack.md)                          | Stack and Pinned Versions           | Accepted |
| [0002](0002-schema-conventions.md)             | Schema Conventions                  | Accepted |
| [0003](0003-api-conventions.md)                | API Conventions                     | Accepted |
| [0004](0004-migration-ranges-and-ownership.md) | Migration Ranges and Path Ownership | Accepted |
| [0005](0005-wave-1-ownership.md)               | Wave 1 Ownership Clarifications     | Accepted |
| [0006](0006-sitemap-interpretation.md)         | Sitemap Interpretation Decisions    | Accepted |

The [denormalization register](denormalization-register.md) lists every materialized view and stored derived value, with its source, refresh rule and reason.
