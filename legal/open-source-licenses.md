---
title: Open Source Licenses
version: 1.0.0-draft
effective_date: The date GHXSTSHIP states when it makes this version final
status: Draft before launch
---

# Open Source Licenses

> **Draft before launch.** This document is a draft. It is not in effect and no one may rely on it. Showing it at /legal does not put it in effect. It takes effect only on the effective date that GHXSTSHIP Industries LLC states at the top of a final version.

XOS 4.0 is open source. This page explains the licenses on our own code and data, how to get the source of the hosted service and of Compass, and where to find the licenses of the third-party components in each release. Using the hosted service is governed by our terms. These licenses govern the code and data, and each has its own warranty disclaimer.

## 1. Our Licenses

| Component                                                                                                                                                                                                                                                                                                                                                       | License       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Platform: `apps/atlas`, `apps/gateway`, `apps/compass`, `apps/console`, `apps/docs`, `packages/ai`, `packages/api`, `packages/data`, `packages/email`, `packages/integrations`, `packages/platform`, `packages/testing`, `packages/workforce-native`, `supabase/`                                                                                               | AGPL-3.0-only |
| SDKs, design tokens, UI libraries, schemas, i18n, shared configuration, the CLI and the MCP server: `packages/cli`, `packages/config`, `packages/help`, `packages/i18n`, `packages/ia`, `packages/icons`, `packages/mcp`, `packages/schemas`, `packages/sdk-python`, `packages/sdk-ts`, `packages/sync`, `packages/tokens`, `packages/ui`, `packages/ui-native` | MIT           |
| Canon data: the XOS Bible as published data in `canon/` and the generated `xpms` seed                                                                                                                                                                                                                                                                           | CC BY 4.0     |

Copyright GHXSTSHIP Industries LLC. The license field and `LICENSE` file of each package are the authoritative statement for that package. A package without a `LICENSE` file of its own, and anything else in the repository not listed above, is covered by the `LICENSE` file at the repository root, which is AGPL-3.0-only. The XOS, Atlas, Gateway, Compass, Aurora and GHXSTSHIP names and logos are not licensed under any of these licenses; see the Trademark Policy.

CC BY 4.0 requires attribution. When you use the canon data, credit "XOS Bible, GHXSTSHIP Industries LLC", link to the license, and say if you changed the data. Attribution must not suggest that GHXSTSHIP endorses you or your use.

## 2. Source Code of the Hosted Service and of Compass

The source code of the platform is available at no charge from the public repository `github.com/ghxstship/atlas`. Each release is tagged by version, for example `v4.5.0`. The hosted XOS service is deployed from the repository's `main` branch, and a release moves `main` to the tagged commit, so the source of the running service is in `main` and the source of each release is at its tag. Compass shows its version at the bottom of Settings, and its source is in `apps/compass` at the matching tag.

Section 13 of the AGPL-3.0 applies to anyone who modifies the platform and lets others use the modified version over a network. That version must prominently offer those users its corresponding source, from a network server at no charge.

## 3. Third-Party Components

Each release has two files attached to it on the public repository once the release is published:

- `xos-<version>.cdx.json`, a software bill of materials in CycloneDX format, listing the production dependencies of that release
- `xos-<version>-third-party-notices.md`, generated from that file, which lists every npm component by name and version, grouped by license, with the license identifier (SPDX)

Each npm package's own `LICENSE` file, in the package on the npm registry, carries its copyright notice and full license text. The notices list covers npm components. Native libraries added when the iOS and Android apps are built are not on it. If you need information about a component that is not listed, or a release's files are not yet public, ask the legal notices mailbox in Section 6.

## 4. License Compliance

Our continuous integration checks the license of every production dependency on every change, against a list of licenses that permit use in both the AGPL-3.0 platform and the MIT packages. A license outside that list fails the check, unless it is recorded with its reason in `packages/config/license-exceptions.json`, which anyone can read in the repository.

That file records two exceptions now. Both were approved by the Owner on 2026-10-24:

- the Sentry command line tool, under FSL-1.1-Apache-2.0, which uploads source maps at build time and is not served to users
- prebuilt libvips for sharp, under LGPL-3.0-or-later, which is loaded as an unmodified shared library to optimize images on the server

Compass does not yet carry third-party notices inside the app. The list in Section 3 covers its npm components and not its native libraries, and it gives license identifiers, not the notice text.

## 5. Contributing

Contributions are accepted under the Developer Certificate of Origin described in `CONTRIBUTING.md`. Contributors keep their copyright and license their contribution under the license of the component they change.

## 6. Questions

License questions go to the legal notices mailbox listed on our contact page at /legal/contact. A license change requires the Owner's written approval under `GOVERNANCE.md`.
