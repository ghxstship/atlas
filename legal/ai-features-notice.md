---
title: AI Features Notice
version: 1.0.0-draft
effective_date: The date GHXSTSHIP states when it makes this version final
status: Draft before launch
---

# AI Features Notice

> **Draft before launch.** This document is a draft. It is not in effect and no one may rely on it. Showing it at /legal does not put it in effect. It takes effect only on the effective date that GHXSTSHIP Industries LLC states at the top of a final version.

This notice explains the artificial intelligence features in XOS 4.0, called Aurora: what they do, what data they use, how to turn them off, and what GHXSTSHIP Industries LLC ("GHXSTSHIP") does to tell people about them. Sections 11 and 12 cover AI and translation tools outside Aurora.

**Check what AI tells you.** AI output can be wrong. Do not rely on a factual statement in an output without checking it yourself, particularly a price, date, quantity, name or legal, safety or medical point.

## 1. Off by Default

Every Aurora feature is off until an organization Admin turns it on in Settings, AI Features. There are six switches: Assistant, Ask in Plain Language, Document Extraction, Drafting, Summaries and Mapping Help. Turning a feature off stops new data being sent for it. Usage is metered per organization and limited per plan.

**Each person's own choice.** Compass asks each person before an AI feature first sends anything of theirs, names Anthropic as the provider, and records the choice with the wording version and the time. Compass sends nothing of the person's to Anthropic until they choose Allowed. A decline turns AI features off for that person across XOS until they change it in Compass, Settings, AI Features. Atlas does not show this question yet. It honors a decline made in Compass, and then tells the person that they turned AI features off themselves, not that an Admin did, and where to turn them back on. In Atlas, a person who has confirmed they are 18 or older and has recorded no choice follows the organization's setting. A person's choice covers the features they use themselves. It does not stop others in the organization from using AI features on records they can see, including records about that person.

**Age.** AI features require a confirmation that the person is 18 or older, and the server refuses a person's request without it. That confirmation is the person's own statement, and XOS does not verify it. A service account is not a person and is not asked: the organization that created it answers for what its API keys do. A personal access token acts as the person, and that person's answer and choice apply to it.

## 2. The Model Provider

Aurora uses Anthropic's Claude models through the Anthropic API. Anthropic is a third party, and Anthropic, PBC is listed on our Subprocessor List. The model in use for each feature is set in configuration and shown in Settings, AI Features. Use of Aurora is also subject to Anthropic's [Usage Policy](https://www.anthropic.com/legal/aup) and [Supported Regions Policy](https://www.anthropic.com/supported-countries), which our Acceptable Use Policy applies to Customers and their users.

## 3. The Features and the Data They Use

| Feature               | What it does                                                                                                                                                                | Data sent to the model                                                                                                                                                                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Assistant             | Answers questions about your organization's data, with links to the records it used, in Atlas and in Compass. It can propose a change for you to confirm                    | Your question and the conversation so far, unfiltered, and the records it retrieves through the public API using your own permissions, with the fields in Section 4 removed                                                                                                |
| Ask in plain language | Turns a sentence into a saved view or filter, and shows the filter it built                                                                                                 | Your sentence and the names of the fields and values available to you. Restricted fields are left out                                                                                                                                                                      |
| Document extraction   | Reads a document into structured fields with a confidence score per field, on forms that offer it, such as riders, insurance certificates, invoices, receipts and quotes    | The whole document you choose, as a file, with whatever it prints. In Compass, a receipt photo is sent when you take or choose it, once this feature is on and you have chosen Allowed                                                                                     |
| Drafting              | Drafts SOPs, advance packets, emails, day sheets, change order descriptions, running orders, risk assessments and similar documents in your organization's verbiage library | Your instructions, unfiltered, the relevant records with the fields in Section 4 removed, and the verbiage library                                                                                                                                                         |
| Summaries             | Summarizes a record's activity, a project's week, gate readiness and similar views                                                                                          | The activity and records being summarized, with the fields in Section 4 removed                                                                                                                                                                                            |
| Mapping help          | Suggests column mappings in the import wizard and catalog bindings for unknown scanned codes                                                                                | Column headers from your import. Atlas sends no sample values, though the API accepts them, and a caller that sends them must leave out Restricted columns. Or the unknown code and candidate catalog items. Do not scan a driver license or other identification with XOS |
| Compass assistant     | Answers policy, procedure and role questions from your organization's own SOPs, handbook and records. It shares the Assistant's switch and is for internal members only     | Your question and the matching content from your organization's SOPs, handbook and records, with the fields in Section 4 removed                                                                                                                                           |

## 4. What Is Removed Before Sending, and What Is Not

**Removed from record data sent to the model:**

- Medical encounter records.
- Any stored field classified Restricted, including pay rates, bank details, tax identifiers and government identifiers.
- Work Details other than loyalty program numbers, emergency contacts, badge photos, supplier diversity certifications, and project travel, uniform and vehicle records.
- Guest care needs, sensitive data consent records and their field records (the `guest_care_needs`, `sensitive_data_consents` and `sensitive_field_records` tables).
- Data you are not permitted to see. Aurora acts through the public API with your own token, so it can never see or do more than you.

**Not removed. This data can reach the model when a person uses a feature:**

- **Documents.** Document extraction sends the file itself. An invoice with bank details, a form with a tax identifier, a contract with a fee or a passport page goes to the model whole. Leave out pages you do not want sent. Copies of identity documents must not be uploaded as general files at all (Acceptable Use Policy, Section 2), so do not send one through extraction.
- **What you type.** Questions and instructions are not filtered.
- **Free text in records.** Text in records that are not listed above can be sent, including incident descriptions, guest list notes and comments. Any personal data in that text goes with it.
- **Your own loyalty program numbers.** These are not yet removed. The assistant can read your own numbers through your own access and send them to the model when you use it.

## 5. No Training on Customer Data

GHXSTSHIP does not use Customer data, including prompts and outputs, to train any model. Under Anthropic's [Commercial Terms](https://www.anthropic.com/legal/commercial-terms), as published when this draft was revised, Anthropic may not train its models on it unless the account holder opts in, for example through its Development Partner setting. This commitment rules that out for the account behind XOS.

## 6. Human Control

- **Nothing changes without you.** Aurora never writes, sends or approves anything without an explicit confirmation step that shows what will change. It proposes a change and you confirm it, and it runs as you. Other tools are in Section 11.
- **Extraction is reviewed.** Extracted fields show a confidence score and are recorded with provenance `agent`. A person reviews them before anything is saved.
- **Saying when it cannot answer.** Aurora is built to return NO ANSWER and say what is missing when your data does not support an answer, and to cite the records it used. A model can still be wrong, so check what it tells you.
- **Decisions about people stay with people.** No Aurora feature is built to decide whom to engage, rank applicants for selection, set pay or shifts, evaluate or discipline anyone, or classify workers. The assistant answers free-form questions, so a person could ask it about those things. If you use AI output to recommend a decision about a specific person's employment, pay, shifts, health, legal rights or finances, a qualified person with authority to change it must review it first and stays accountable, and the person affected must be told AI was used. The Customer is responsible for this.
- **Rule-based sorting is separate.** XOS also has fixed rules that are not AI, such as the suggested order of people for a shift and the ordering of opportunities on Gateway. Section 18 of the Privacy Policy lists them. A person makes the decision, and Customers answer for how they use them.
- **People under 18.** AI features are for people 18 or older, and an organization must not give them to anyone younger (Acceptable Use Policy, Section 8). Every account holder must be 18 or older, and the server refuses a person's AI request until that person has confirmed it (Section 1). AI features are labeled as AI wherever they appear.

## 7. Transparency Labels

When you use the assistant, the interface shows that you are interacting with an AI system. Text an AI feature produces carries a visible label on the panel where it appears, and API answers carry an `ai_generated` flag. These labels do not follow the text once you save, copy or export it, and XOS adds no machine-readable mark to AI output. We make no claim that XOS meets Article 50 of the EU Artificial Intelligence Act, and we have not done the work to meet it. Nothing in XOS stops an organization in the European Union from turning Aurora on. If you publish or send AI-generated text, tell readers where your law requires.

## 8. Logging and Retention

**In XOS.** Prompts and outputs are logged as a record of AI use. Access to the log is limited to people in the organization who hold the audit capability, and each person for their own requests. Before storage, email addresses, US Social Security number patterns, card-length numbers and phone numbers are replaced with labels. Names, addresses and other details stay in the log. Prompts include the record text sent to the model. Document contents are not logged, only a note that a document was sent. The log is kept for 7 years under our Data Retention and Deletion Policy. A Customer cannot shorten that period, the log can outlast the record it quotes, and deleting an account does not change it. To have a person's data erased from the log, a Customer writes to the privacy mailbox as Section 3 of that Policy describes.

**At Anthropic.** As read on 6 November 2026, Anthropic's published retention policy says API inputs and outputs are deleted within 30 days, content flagged for a usage policy violation can be kept for up to 2 years and safety scores for up to 7 years, with other exceptions for law or agreement. Check [its current policy](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data). We do not claim any shorter retention arrangement with Anthropic.

## 9. Quality

Each feature has a fixed evaluation test set and an accuracy threshold. The evaluations are set to run nightly, separately from our release build, so a low score does not itself stop a release, and they run only when the evaluation key is configured. We publish no accuracy figure and make no claim about how often a feature is right.

## 10. Your Choices

- **Organizations** can turn any feature off in Settings, AI Features at any time.
- **Individuals** can decline AI features in Compass, Settings, AI Features, which turns them off for that person across XOS (Section 1), and can ask their organization's Admin to turn them off for everyone. Records are always available without AI. A person whose records are in an organization that uses AI cannot turn it off for those records alone.
- **Questions** go to your organization's Admin, or to the privacy mailbox listed on our contact page at /legal/contact.

## 11. AI Assistants a Customer Connects

A Customer may connect its own AI assistant to XOS, such as Claude or ChatGPT, where hosted connectors are available, or use API keys and other connected apps. These are the Customer's tools under its own agreement with that provider. They are not Aurora, and these providers are not our subprocessors.

- **Reads happen at once.** What the person's token can read goes to the provider they connected. Restricted capability groups are refused.
- **Hosted connectors cannot write directly.** Each change becomes a proposal the person confirms in Personal Settings, Connected Apps. A proposal expires after 7 days, and there is no confirm-all.
- **Other tools can write.** A locally run `xos-mcp` server with an API key can write, and delete if its operator passes those options. Other connected apps and API keys can act within their grant. Section 6's "Nothing changes without you" does not cover them.

## 12. Other Automated Tools

- **Semantic search.** Off until an Admin turns it on. A small embedding model, gte-small, runs inside Supabase and indexes published documents, SOPs, handbook articles and search words. Text is redacted first, and no text goes to an outside model provider.
- **Chat translation.** Google Cloud Translation, not Anthropic. It is off by default for the platform and for each organization, and no screen offers it yet. When it is on, a chat message someone asks to translate goes to Google.
