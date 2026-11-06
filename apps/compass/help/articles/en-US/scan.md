---
title: Scan
summary: Scan badges at access points, gear, deliveries and any code, or show your own badge.
kind: workflow
nodes: [scan, scan.*]
order: 1
---

Scan is the raised button in the middle of the tab bar. Choose a mode at the top; your role decides which modes you have. The first time, allow the camera.

## Modes

- **Asset**: point at an asset tag, serial or barcode. Compass checks the item out to you or returns it. An item assigned to someone else says so.
- **Receiving**: scan each case of a delivery. The count runs as you go; review the batch, remove a miscounted unit, then save.
- **Credential**: choose the access point, then scan a badge. Compass says Access granted or denied, with the reason.
- **Lookup**: scan any code to find what it belongs to.

A code Compass does not know goes to the desk to identify. You can also type a code, or tap **Read NFC tag** and hold a badge, wristband or tag to the top of your phone. In Lookup, **Write to an NFC tag** puts a found item's asset tag on a blank NFC sticker.

## In and Out

In Credential mode, choose **In** or **Out** for the access point. This device remembers your choice. Out is never refused. A denied scan says why.

A guest's pass opens that guest at the door.

If you may issue badges and read the scan log, a denial other than a revoked badge offers **Override** for 15 minutes: say why, then confirm. Offline, it waits after the scan; if the scan uploads as granted, the queue says the override was not needed.

**Inside now** counts the people scanned in at the access point. It needs the scan log.

## Your badge

If you scan your own badge at access points, Scan shows **My Badge** with the screen brightened. Artists also see their party's badges. Vendors see their dock slots, and crew see the gear assigned to them.

Clients and sponsors have nothing to scan in Compass.
