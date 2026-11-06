---
title: Weather
summary: Recording wind, lightning and heat readings and seeing active alerts.
kind: workflow
nodes: [workforce.weather]
order: 1
---

Weather shows active alerts, recent readings and the thresholds for the project.

Choose **Record a Reading**, pick wind, lightning or heat, enter the value and **Save Reading**. A reading past a threshold raises an alert: Monitor, Restrict or Evacuate.

Thresholds are set in Atlas.

For a US venue with the official feed on, Weather also shows the National Weather Service warnings for the venue.

A dispatcher can **Call hold**: write or keep the message and send it. It reaches the alert-role people, the dispatchers and everyone inside the project's zones. **All clear** ends it. Offline, both wait in the Offline Queue. A hold sent late still goes out and says when you called it; an all-clear that reaches the server more than 10 minutes after you gave it is not sent, so check the weather and give it again.
