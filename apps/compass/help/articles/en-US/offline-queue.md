---
title: Offline queue
summary: Changes waiting to upload, uploading now, and deciding on changes the server did not take.
kind: workflow
nodes: [offline-queue]
order: 1
---

Every change you make offline waits here until it uploads: punches, incident reports, scans, inspections, messages and more. Each shows what it is and when you made it.

- **Waiting to upload**: it sends when you reconnect.
- **Retrying**: Compass is trying again.
- **Needs your decision**: the server did not take it.

**Upload Now** sends everything at once when you are online.

## Decide on a change

Open a change that needs your decision. Compare your version with the server's, then **Send Mine Again** or **Keep Server's**. If the server refused it because of your role, ask your supervisor.

Signing out deletes changes that have not uploaded, so Compass warns you first.
