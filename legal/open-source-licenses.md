---
title: Open Source Licenses
version: 1.0.0-draft
effective_date: The date this version is published at /legal
status: Draft for review by counsel before launch
---

# Open Source Licenses

> **Draft for review by counsel before launch.** This document is a draft. It is not in effect and no one may rely on it. It takes effect only when GHXSTSHIP Industries LLC publishes it at /legal, and its effective date is that date of publication.

XOS 4.0 is open source. This page explains the licenses on our own code and data, how to get the source of the hosted service, and where to find the licenses of every third-party component in each release.

## 1. Our Licenses

| Component                                                                                                            | License       |
| -------------------------------------------------------------------------------------------------------------------- | ------------- |
| Platform: `apps/atlas`, `apps/gateway`, `apps/compass`, `apps/console`, `packages/api`, `packages/data`, `supabase/` | AGPL-3.0-only |
| SDKs, design tokens, UI libraries, schemas, i18n, shared configuration, the CLI and the MCP server                   | MIT           |
| Canon data: the XOS Bible as published data in `canon/` and the generated `xpms` seed                                | CC BY 4.0     |

Copyright GHXSTSHIP Industries LLC. The `LICENSE` and `NOTICE` files in the repository and the `LICENSE` file in each package are the authoritative statements. The XOS, Atlas, Gateway and Compass names and logos are not licensed under any of these licenses; see the Trademark Policy.

## 2. Source Code of the Hosted Service

The source code of every release of the platform is available at the public repository `github.com/ghxstship/atlas`, tagged by version. Section 13 of the AGPL-3.0 entitles users who interact with a modified version of the platform over a network to the source of that version. The hosted XOS service runs the tagged release shown in Help, What's New, and the source of that release is at the matching tag. Anyone running a modified version for others must offer its source to their users in the same way.

## 3. Third-Party Components

Each release ships a software bill of materials in CycloneDX format. This page is generated from it at release time and lists, for every third-party component in the web applications, the mobile application and the API:

- component name and version
- license identifier (SPDX)
- copyright notice where the license requires one
- the full license text, grouped by license

The CycloneDX file for each release is attached to its release on the public repository, so anyone can verify this page against it.

## 4. License Compliance

Our CI checks every dependency's license on every change. It blocks licenses that are incompatible with the license of the package that uses them, such as GPL-licensed dependencies in MIT packages. Mobile app stores receive the same third-party notices inside the Compass app under Profile, Settings, About.

## 5. Contributing

Contributions are accepted under the Developer Certificate of Origin described in `CONTRIBUTING.md`. Contributors keep their copyright and license their contribution under the license of the component they change.

## 6. Questions

License questions go to the legal notices mailbox listed on our contact page at /legal/contact. A license change requires the Owner's written approval under `GOVERNANCE.md`.
