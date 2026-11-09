---
title: Mobile End User License Agreement
version: 1.0.0-draft
effective_date: The date GHXSTSHIP states when it makes this version final
status: Draft before launch
---

# Mobile End User License Agreement

> **Draft before launch.** This document is a draft. It is not in effect and no one may rely on it. Showing it at /legal does not put it in effect. It takes effect only on the effective date that GHXSTSHIP Industries LLC states at the top of a final version.

This Mobile End User License Agreement (the "EULA") is between you and GHXSTSHIP Industries LLC ("GHXSTSHIP", "we" or "us"), a Florida limited liability company. It covers the Compass mobile application for iOS and Android and any branded build of Compass made for an organization (the "App"). Branded builds are not offered at launch.

The App asks you to accept this EULA at your first sign-in, before anything else, and records your acceptance with the version, the time and your account. That step needs a connection. If you do not agree, you cannot use the App. From that step you can sign out, or delete your account, without agreeing to anything. You must be at least 18 years old to use the App, which is a work tool and is not directed to children. The App asks you to confirm your age, and we do not verify your answer. If you answer that you are under 18, you get no account, and an existing account is closed once you confirm that answer.

The App enforces acceptance of this EULA. On the server, XOS enforces your age answer for joining an organization, for AI features and for closing an account.

## 1. Relationship to Other Terms

The App is a client for the XOS 4.0 service. Your use of the service through the App is also governed by the terms that apply to you:

- If you are a member of an organization that subscribes to XOS, that organization's agreement with us governs the service, and this EULA governs the App.
- If you use the App as a crew member, staff member, vendor, contractor, artist or other external party, or you have no active membership of an organization, the Worker Terms govern your account and this EULA governs the App. The App asks you to accept the Worker Terms at your first sign-in, with this EULA, if you have not accepted them in Gateway.
- The Acceptable Use Policy and the Privacy Policy apply to everyone. The AI Features Notice explains the AI features.

## 2. License

We grant you a limited, non-exclusive, non-transferable, revocable license to install and use the App on devices you own or control, for using XOS as your account allows. The App is licensed to you, not sold. We keep all rights we do not grant here, including in our names and marks.

Source code for the App is published under the open source licenses described on our Open Source Licenses page, and those licenses govern that code. This EULA governs the App as distributed through an app store under our names and marks. Nothing in this EULA limits a right you have under those licenses.

## 3. Restrictions

You must not:

- use the App in violation of the Acceptable Use Policy or the law
- post or send content the Acceptable Use Policy prohibits, or abuse other people through the App
- bypass the App's security controls, including encrypted storage, biometric unlock, kiosk mode or remote wipe
- distribute the App under an XOS mark except as the Trademark Policy allows
- use the App on a device you know is compromised in a way that defeats its security controls

There is no tolerance in the App for objectionable content or abusive users: this EULA and the Acceptable Use Policy prohibit both. In chat and the feed you can report content and block a person. A block hides that person's posts, comments and messages from you at once. A report goes to the moderators of the organization that runs the workspace, who are notified at once and aim to decide within 24 hours. GHXSTSHIP does not see those reports. To reach GHXSTSHIP about any content in the App, including when an organization's moderators do not respond, write to support@ghxstship.pro with "Abuse Report" in the subject line. A person reads what you send, and Section 7 of the Acceptable Use Policy says what we can do.

Nothing in this EULA stops you from giving an honest review of the App or of XOS, including in an app store.

Commercial parental control tools, such as Screen Time from Apple and Family Link from Google, can help limit a minor's access to online material.

## 4. Device Data and Permissions

The App asks for a device permission when a feature first needs it, and you can turn any permission off in your device settings. If you decline, that feature does not work, and the rest of the App does. If your organization requires clock-in inside a work site geofence and the App cannot read your location, the App refuses the clock-in, so ask your supervisor how to record your time.

- **Location**, only while the App is open and never in the background. The App uses it to check a clock-in against a work site geofence, including when a supervisor clocks in a team, to fill in the location of an incident report, for forms that require a location, and to tag a photo if your organization keeps photo location. It checks every 5 seconds while you have the clock open, about once a minute from 30 minutes before your call time to 15 minutes after it, about every 5 minutes while you are on shift, and not otherwise. Battery Saver in Settings lowers this to about every 15 minutes at low accuracy. A location leaves your device only when it is attached to a punch, an incident, a form or a photo. Its coordinates and accuracy are stored with that record, and your organization, including your supervisor, can see where a punch happened.
- **Camera** to scan barcodes, QR codes, badges and asset tags, and to take photos for incidents, inspections, proof of performance, forms and expense receipts. If a project requires it, the kiosk also takes a front-camera photo at clock-in. That is only a photo: the App does no face detection or face matching. Photos are resized, and location data in photo metadata is removed unless your organization turns photo location on. Receipt photos always lose it.
- **Photo picker** to choose one existing photo for a receipt. The App sees only the photo you choose, and asks for no photo library permission.
- **Microphone** for voice notes on incident reports, while you hold the button.
- **Notifications** for approvals, announcements and alerts. They are delivered through Expo, Apple Push Notification service and Firebase Cloud Messaging.
- **Biometrics** to unlock the App and to confirm account deletion. Biometric matching happens on your device through the operating system. We never receive your biometric data.
- **NFC** to read badges, wristbands and asset tags, and to write asset tags.

The App does not ask for your contacts, device calendar, motion data or background location.

**What stays on your device.** The App stores data in an encrypted database so it works offline, and your session and settings in the device's secure storage. Some things are outside the encrypted database: photos and voice notes wait in temporary files until they upload, and the clock widget, Live Activity and App Shortcuts keep their shift details and queued punches in storage shared between the App and those features. Shift details in the widget and Live Activity can show on your lock screen. On a shared kiosk device, workers enter a PIN, and an offline punch keeps that PIN in the encrypted database until the server checks it.

**Sign-out and remote wipe.** When you sign out, or when you or your organization ends your session remotely, the App deletes the offline records from the device. For a remote sign-out, this happens when the App next connects and learns of it, so a device that stays offline keeps its data until then. A few device settings, such as your chosen organization and project, stay until you delete the App.

**Wallet passes.** If you add a credential to Apple Wallet or Google Wallet, its details go to Apple or Google at your request.

**AI features.** If your organization has turned them on, organization members can use the assistant, and receipt reading. Before an AI feature first sends anything of yours, the App asks you, names Anthropic as the provider, and records your choice. The App sends nothing of yours to Anthropic until you choose Allowed. Then the assistant sends your question and the records it reads, and receipt reading sends the receipt photo when you take or choose it. If you decline, AI features are off for you across XOS, and Atlas and Compass tell you that you turned them off yourself. You can change your choice in Compass, Settings, AI Features. AI features also need your confirmation that you are 18 or older. Your choice covers the AI features you use yourself. It does not stop others in your organization from using AI features on records they can see, including records about you. AI output can be wrong, so check it before you rely on it. The AI Features Notice has the details.

**No tracking.** The App has no advertising, analytics or crash reporting SDK, and it does not track you across other companies' apps or websites.

## 5. Account Deletion

You can delete your account from inside the App: More, then Settings, then Delete Account. The App tells you if something must happen first, such as transferring ownership of an organization. Our Delete Your Account page at /legal/account-deletion explains how to delete your account without the App, and what is erased and kept. Deleting your account erases your sign-in, your full name and your profile. It does not yet erase separate given and family names, which you may have added or which Sign in with Apple may have set. To remove them, clear them in Settings, Account, before you delete. Organizations you worked with keep the engagement records the law requires them to keep, such as timesheets, payments and tax documents, as described in the Worker Terms.

## 6. Updates

We may update the App, including through over-the-air updates that it downloads from our update service when it opens. If your version falls below the minimum version the service supports, the App asks you to update before you continue.

## 7. Disclaimer and Limitation of Liability

**Not an emergency service.** The App is a work tool. It is not an emergency, dispatch or medical records service, and it does not replace on-site safety staff or calling your local emergency number. It can lose its connection or its battery, and anything you enter offline reaches your organization only after your device reconnects.

To the extent the law allows, the App is provided "as is", and we disclaim all implied warranties, including merchantability, fitness for a particular purpose and non-infringement. To the extent the law allows, we are not liable for indirect, incidental, special or consequential damages arising from the App, and our total liability to you for the App is limited to the greater of the amount you paid for the App and fifty US dollars. If the Worker Terms also apply to you, that is one limit, shared with the limit in the Worker Terms, and not fifty dollars under each. Some jurisdictions do not allow these exclusions, so they may not apply to you. Nothing in this EULA limits liability that the law does not allow to be limited, or rights you have under employment, consumer or data protection law that cannot be limited by contract.

## 8. Termination

You can stop using the App and delete it at any time. This license ends when your access to XOS ends. We may also suspend or end it if you breach this EULA. We then follow Section 7 of the Acceptable Use Policy: we send you a statement of reasons and you can appeal, and we act without prior notice only where that is needed to protect people, data or the Service, or where the law requires it. When this license ends, you must stop using the App and delete it. Sections 7, 12 and 14 continue after it ends.

## 9. Export Control

You represent that you are not located in a country subject to a United States government embargo or designated as a "terrorist supporting" country, and that you are not listed on any United States government list of prohibited or restricted parties. You must follow the export control and sanctions laws that apply to your use of the App.

## 10. Terms Required by Apple

If you obtained the App from the Apple App Store, these terms also apply and control over any conflicting term of this EULA:

1. **Parties.** This EULA is between you and GHXSTSHIP only, not with Apple Inc. ("Apple"). GHXSTSHIP, not Apple, is solely responsible for the App and its content.
2. **Scope of license.** The license in Section 2 is limited to use of the App on Apple-branded products that you own or control, as permitted by the Usage Rules in the Apple Media Services Terms and Conditions, except that the App may be accessed by other accounts associated with you through Family Sharing or volume purchasing where available.
3. **Maintenance and support.** GHXSTSHIP alone is responsible for maintenance and support of the App, as described in the support information we publish. Apple has no obligation to provide any maintenance or support for the App.
4. **Warranty.** GHXSTSHIP is solely responsible for any product warranties, whether express or implied by law, to the extent not effectively disclaimed. If the App fails to conform to any applicable warranty, you may notify Apple, and Apple will refund the purchase price, if any, for the App. To the maximum extent permitted by law, Apple has no other warranty obligation with respect to the App, and any other claims, losses, liabilities, damages, costs or expenses attributable to a failure to conform to a warranty are GHXSTSHIP's sole responsibility.
5. **Product claims.** GHXSTSHIP, not Apple, is responsible for addressing any claims by you or a third party relating to the App or your possession and use of it, including product liability claims, claims that the App fails to conform to any applicable legal or regulatory requirement, and claims arising under consumer protection, privacy or similar legislation. This EULA does not limit GHXSTSHIP's liability to you beyond what the law permits.
6. **Intellectual property.** If a third party claims that the App or your possession and use of it infringes that third party's intellectual property rights, GHXSTSHIP, not Apple, is solely responsible for the investigation, defense, settlement and discharge of that claim.
7. **Legal compliance.** You represent and warrant that you are not located in a country subject to a United States government embargo or designated by the United States government as a "terrorist supporting" country, and that you are not listed on any United States government list of prohibited or restricted parties.
8. **Developer name and address.** Questions, complaints and claims about the App go to GHXSTSHIP Industries LLC, Miami, FL, United States, at support@ghxstship.pro. The full postal address and telephone number are listed on our contact page at /legal/contact.
9. **Third-party terms.** You must comply with applicable third-party terms when using the App, for example your wireless data service agreement.
10. **Third-party beneficiary.** Apple and its subsidiaries are third-party beneficiaries of this EULA. Once you accept this EULA, Apple has the right, and is deemed to have accepted the right, to enforce this EULA against you as a third-party beneficiary.

## 11. Terms for Google Play

If you obtained the App from Google Play, Google LLC is not a party to this EULA and has no responsibility for the App or its support. Your use of Google Play is governed by the Google Play Terms of Service. If this EULA conflicts with the Google Play Terms of Service on the subject of your relationship with Google, the Google Play Terms of Service control on that subject.

## 12. Governing Law

This EULA is governed by the laws of the State of Florida, United States, without regard to conflict of laws rules. Disputes go to the state and federal courts in Miami-Dade County, Florida, as stated under Governing Jurisdiction on our contact page at /legal/contact. There is no arbitration agreement and no class action waiver. This Section does not take away any mandatory protection given by the law of the place where you live that cannot be waived by contract, including any right to bring a claim in the courts of that place.

## 13. Changes to This EULA

Each version of this EULA is shown at /legal/mobile-eula with its version number and is in effect from the effective date it states. We keep earlier versions, which you can ask for at support@ghxstship.pro with "Support" in the subject line. For a material change, the App asks you to accept the new version during the 30 days' notice we give before it takes effect. From its effective date, the App holds until you accept it. If you do not agree to the new version, you can sign out or delete your account from that step, and stop using the App and delete it.

## 14. General

If a court finds part of this EULA unenforceable, the rest stays in effect. If we do not enforce a term, we can still enforce it later. You may not transfer this EULA. We may transfer it to a successor to our business. Apart from the terms named in Section 1, this EULA is the whole agreement between you and us about the App.

## 15. Contact

Questions about this EULA go to support@ghxstship.pro with "Support" in the subject line.
