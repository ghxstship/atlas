---
title: Work, work orders and punch lists
summary: Track every record of a project, issue work orders, and close out punch items.
kind: page
nodes:
  [
    work.all-records,
    work.by-kind,
    work.work-orders,
    work.punch-lists,
    work.recurring,
    project.work,
    record,
    work,
  ]
order: 21
---

## Records

Every task, decision, issue and deliverable in a project is a record. A record has a kind, a state, an owner and dates. **All records** lists them; **By kind** groups them. Open a record in the peek with **Enter**, or open its full page from the peek.

## Quick add

Type one line in the quick add field above the list, or in the **Create** menu, and press **Enter**. Words become chips before you save: a date such as "Friday 8am" sets when the record is due (a range such as "Friday 8am-10am" sets when it starts and ends), `@` names the owner, `#` the canon category, `/` the kind and `~` the scope. A token that matches nothing you can see stays in the title, one that matches several offers a choice, and removing a chip keeps its words in the title. Without a kind, the record is the page's kind, a Task on most pages.

## Work orders

A work order asks a team or vendor to do a defined job. It carries its scope, location, due date and, when priced, its cost against a budget line. Move it through its states from the peek.

## Punch lists

Punch items are the small fixes found during inspections and walkthroughs. Each one belongs to a location and closes when the fix is verified.

## Recurring work

Recurring work creates records on a schedule, such as daily checks or weekly reports, so nothing depends on memory.

## Reviews

Turn on **Requires review** on a record, or on a template's record item, when the work must be checked before it is done. A record that requires review becomes Complete only after its latest review is approved. While the record is Active, choose **Request review**, pick a reviewer and add a note: the record moves to In Review and the reviewer is notified. The reviewer, or any other approver who may change the project's records, chooses **Approve** or **Request changes** with a note; asking for changes moves the record back to Active with the note in its history. Whoever asked for the review never decides it. Only someone who may change the project's settings turns Requires review off.

## File reviews

On a submittal or a record, each version of a file can be approved or sent back with what to change, by someone other than the person who uploaded it. Each version keeps its own history, and a new version starts unreviewed. A submittal cannot be approved while the current version of one of its files has changes requested.

Related: [Schedule](help:schedule).
