# Compass: age rating answers

Prepared by A68 (RRR-113). Compass is a workplace app for crews and staff of live events; it has no ads, no purchases, no gambling and no web browser. People can message coworkers and post in their organization's feed, and that is what drives the answers below.

## App Store (App Store Connect, Age Rating)

`eas metadata:push` uploads these answers from `store/store.config.json` (`apple.advisory`). The table explains each.

| Question (App Store Connect)                                                            | Answer                   | Why                                                                                              |
| --------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------ |
| Parental controls                                                                       | No                       | Not a family app                                                                                 |
| Age assurance                                                                           | No                       | Accounts come from an employer's invitation; Compass does not check ages itself                  |
| Unrestricted web access                                                                 | No                       | No in-app browser; links open Atlas or Gateway pages in the system browser                       |
| User-generated content                                                                  | Yes                      | Feed reactions and comments, lost and found posts, incident reports, all inside one organization |
| Messaging and chat                                                                      | Yes                      | Chat between members of the same organization                                                    |
| Advertising                                                                             | No                       |                                                                                                  |
| Profanity or crude humor                                                                | None                     |                                                                                                  |
| Horror or fear themes                                                                   | None                     |                                                                                                  |
| Alcohol, tobacco or drug use or references                                              | None                     | Bar names in a venue are place names, not content about alcohol                                  |
| Mature or suggestive themes                                                             | None                     |                                                                                                  |
| Medical or treatment information                                                        | None                     | Incident reports record what happened; Compass gives no medical information                      |
| Health or wellness topics                                                               | No                       |                                                                                                  |
| Sexual content or nudity; graphic sexual content                                        | None                     |                                                                                                  |
| Cartoon or fantasy violence; realistic violence; prolonged graphic or sadistic violence | None                     |                                                                                                  |
| Guns or other weapons                                                                   | None                     |                                                                                                  |
| Simulated gambling; gambling; contests; loot boxes                                      | None / No                |                                                                                                  |
| Made for Kids                                                                           | No (`kidsAgeBand` empty) |                                                                                                  |
| Age rating override                                                                     | None                     | Accept the rating App Store Connect calculates                                                   |

Expected result: the lowest rating App Store Connect allows for an app with messaging and user-generated content. Accept what the calculator shows; do not override it. If it shows anything above 13+, tell engineering, since nothing in Compass is mature content.

## Google Play (IARC questionnaire)

Play Console, App content, Content rating. Category: **"All other app types"** (the IARC category for utility, productivity and communication apps; not a game, not social media, not a reference or news app).

| Question                                                                             | Answer          | Note                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------ | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Violence, fear, sexuality, language, controlled substances, crude humor              | No              | No such content made by the developer                                                                                                                                                           |
| Gambling with real money or simulated gambling                                       | No              |                                                                                                                                                                                                 |
| Does the app allow users to interact or exchange content with other users?           | Yes             | Chat and feed comments between members of one organization                                                                                                                                      |
| Does the app share the user's current physical location with other users?            | No, with a note | The punch location goes to the person's employer (supervisors in Atlas), not to other app users in general; if Play's reviewer reads supervisors as "other users", answer Yes (open question 1) |
| Does the app allow users to purchase digital goods?                                  | No              |                                                                                                                                                                                                 |
| Does the app contain or promote content related to the sale of age-restricted goods? | No              |                                                                                                                                                                                                 |
| Is the app a web browser or search engine?                                           | No              |                                                                                                                                                                                                 |
| Is the app primarily a news or educational product?                                  | No              |                                                                                                                                                                                                 |

Expected result: IARC 3+ / PEGI 3 / ESRB Everyone with the interactive elements "Users Interact" (and "Shares Location" if question 4 is answered Yes). Target audience is set separately to 18 and over (`store/google-play/data-safety.md`).

## Open questions for the owner

1. **Location sharing (IARC).** Supervisors see where a punch happened. Answer No as the default reading; the owner may prefer Yes, which only adds the "Shares Location" element.
2. **Moderation (App Review guideline 1.2), decided.** The owner chose report and block (decision 19, 2026-10-23), and Compass has both: the three dots on a post, message or shout-out by someone else report it to the organization's moderators, who decide within 24 hours in Atlas, or block its author; Settings, Blocked People lifts a block (ADR 0026, amendment of 2026-10-23). The contact information is the Contact page at /legal/contact. The review notes (`store/review-notes.md`) tell App Review where to find them.
