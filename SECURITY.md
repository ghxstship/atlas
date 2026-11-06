# Security Policy

## Reporting a vulnerability

Email **security@ghxstship.tech**. Do not put details of a finding in a public issue. If this repository's Security tab shows "Report a vulnerability", you may use GitHub private vulnerability reporting instead.

If your email bounces, or you have no answer within 3 business days, open a GitHub issue that says only that you need a private way to report a security finding, with no details of it, and we will give you one.

Include the affected surface (Atlas, Gateway, Compass, API, SDK, CLI or MCP server), the steps to reproduce, and the impact you observed. Keep other people's data out of your report. We acknowledge reports within 3 business days and share a remediation plan within 10 business days. We do not pay bounties.

## Scope

In scope: the code in this repository, the published SDKs, CLI and MCP server, the Compass apps GHXSTSHIP publishes, and the hosted XOS services at `atlas.ghxstship.tech`, `gateway.ghxstship.tech`, `api.ghxstship.tech`, `docs.ghxstship.tech`, `status.ghxstship.tech` and `console.ghxstship.tech`. Out of scope: denial of service through volume, social engineering of staff, self-hosted deployments run by others, and findings in third-party services that XOS integrates with or runs on, which go to those vendors.

## Safe harbor

We will not pursue legal action for research that follows this policy, avoids privacy violations and service disruption, and gives us reasonable time to fix an issue before disclosure. We can authorize testing only of systems we control, and this does not cover a demand for payment in exchange for keeping or disclosing a finding. The Responsible Disclosure Policy (`legal/responsible-disclosure-policy.md`) gives the full rules of engagement. Once it is published at `/legal`, the published version controls.

## Supported versions

Security fixes ship for the latest release line. The hosted service always runs the latest release.
