import { expect, test } from "./engine-test";
import { asPerson, newSignIn, PEOPLE, PROJECT, suffix, transition } from "./role-fixtures";
import { expectAccessible, reloadSettled, signIn, sql } from "./support";

/**
 * Ratings of a person stay with the org that gave them (RRR-248, ADR 0158). A freelancer the demo org rated reads the rating
 * on their own profile. Nobody else does until they opt in, and then only a signed-in person who decides no hiring anywhere:
 * an Account Owner, who may place people on shifts, still sees nothing. Withdrawing takes effect on the next read. The rating
 * stays shown after the person disputes it, so a dispute hides nothing.
 */
test("a rated person opts in, withdraws at once and disputes a rating", async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  const tag = suffix().toLowerCase();
  const email = `rated-${tag}@example.com`;
  const handle = `rated-${tag}`;
  const comment = `Late to the rigging call ${tag}.`;
  const person = await newSignIn(email, `Demo Rated ${tag.toUpperCase()}`);
  const viewerEmail = `peer-${tag}@example.com`;
  await newSignIn(viewerEmail, `Demo Peer ${tag.toUpperCase()}`);

  const [engagement] = await sql<{ id: string }>(
    `insert into app.engagements (project_id, person_id, role_type, role_code, worker_classification, pay_basis, arrangement,
       start_date, end_date)
     values ($1, $2, 'Staff', '5000.51.02', 'INDEPENDENT_CONTRACTOR', 'Day Rate', 'Per Engagement', '2027-02-10', '2027-02-12')
     returning id`,
    [PROJECT, person],
    PEOPLE.owner,
  );
  const engagementId = engagement?.id as string;
  for (const [from, to] of [
    ["Onboarding", "Active"],
    ["Active", "Closing"],
    ["Closing", "Complete"],
  ] as const) {
    await transition("engagement", engagementId, from, to);
  }
  await sql(
    `insert into app.ratings (engagement_id, rater_side, score, comment) values ($1, 'Organization', 2, $2)`,
    [engagementId, comment],
    PEOPLE.owner,
  );
  await asPerson(
    person,
    `insert into app.ratings (engagement_id, rater_side, score) values ($1, 'Party', 4)`,
    [engagementId],
  );
  await asPerson(person, `select app.ensure_my_profile()`);
  await asPerson(person, `update app.person_profiles set handle = $1, visibility = 'Public'`, [
    handle,
  ]);

  const peer = await browser.newContext();
  const peerPage = await peer.newPage();
  await signIn(peerPage, viewerEmail);
  const hirer = await browser.newContext();
  const hirerPage = await hirer.newPage();
  await signIn(hirerPage, "vendor@example.com");

  // Off by default: nobody else reads it on the profile.
  await peerPage.goto(`/u/${handle}`);
  await expect(peerPage.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(peerPage.getByText(comment)).toHaveCount(0);

  // The person reads it, with who said it, and opts in.
  await signIn(page, email, "/profile");
  const rating = page.getByRole("listitem").filter({ hasText: comment });
  await expect(rating.getByText("2 of 5")).toBeVisible();
  await expect(rating.getByText("Demo Productions")).toBeVisible();
  await page.goto("/settings/profile-privacy");
  const form = page.getByRole("form", { name: "Ratings about you" });
  const choice = form.getByRole("checkbox", { name: "Show all my ratings on my profile" });
  await expect(choice).not.toBeChecked();
  await expect(form).toBeVisible();
  await expectAccessible(page);
  await choice.check();
  await form.getByRole("button", { name: "Save this choice" }).click();
  await expect(form.getByText("Saved", { exact: false })).toBeVisible();

  // A signed-in peer who decides no hiring now reads it, low score and all. No average appears.
  await reloadSettled(peerPage);
  await expect(peerPage.getByText(comment)).toBeVisible();
  await expect(peerPage.getByText("2 of 5", { exact: true })).toBeVisible();
  await expect(peerPage.getByText(/average/i)).toHaveCount(0);

  // Someone who runs an account reads nothing, even with the opt-in.
  await hirerPage.goto(`/u/${handle}`);
  await expect(hirerPage.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(hirerPage.getByText(comment)).toHaveCount(0);

  // Withdrawal takes effect at once.
  await reloadSettled(page);
  await expect(choice).toBeChecked();
  await choice.uncheck();
  await form.getByRole("button", { name: "Save this choice" }).click();
  await expect(form.getByText("Saved", { exact: false })).toBeVisible();
  await reloadSettled(peerPage);
  await expect(peerPage.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(peerPage.getByText(comment)).toHaveCount(0);

  // The person disputes the rating through a route that exists, and it stays shown.
  await page.goto("/profile");
  const mine = page.getByRole("listitem").filter({ hasText: comment });
  await mine.getByText("Dispute this rating", { exact: true }).click();
  const dispute = mine.getByRole("form", { name: "Dispute this rating" });
  await dispute.getByLabel("Why you dispute it", { exact: true }).selectOption("False Statement");
  await dispute.getByLabel("What is wrong", { exact: true }).fill(`I was on time ${tag}.`);
  await dispute.getByRole("button", { name: "Send dispute" }).click();
  await expect(mine.getByText("Your dispute: Open.", { exact: false })).toBeVisible();
  await expect(mine.getByText(comment)).toBeVisible();
  await expect(mine.getByRole("form", { name: "Dispute this rating" })).toHaveCount(0);

  const [row] = await sql<{ dispute_state: string; details: string }>(
    `select dispute_state, details from app.rating_disputes where disputant_person_id = $1`,
    [person],
  );
  expect(row).toEqual({ dispute_state: "Open", details: `I was on time ${tag}.` });

  await peer.close();
  await hirer.close();
});
