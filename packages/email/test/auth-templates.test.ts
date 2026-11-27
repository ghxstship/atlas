import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AUTH_EMAIL_LINK_SECONDS,
  AUTH_EMAIL_POSTAL_ADDRESS,
  AUTH_EMAIL_SITE_PATHS,
  AUTH_EMAIL_SUPPORT_ADDRESS,
  AUTH_EMAILS,
  allowedVariables,
  authEmailConfig,
  renderAuthEmail,
} from "../src/auth-templates.ts";

/**
 * The emails Supabase Auth sends (release 4.19): every template file in supabase/templates is generated from
 * src/auth-templates.ts, named in supabase/config.toml with its subject, parses as HTML and as a Go template, uses only
 * the variables Supabase Auth fills for it, and loads nothing remote. Production applies the same files
 * (infra/runbooks/promote-to-production.md, step 6).
 */
const root = fileURLToPath(new URL("../../../", import.meta.url));
const config = readFileSync(`${root}supabase/config.toml`, "utf8");
const read = (file: string) => readFileSync(`${root}supabase/templates/${file}`, "utf8");

const VOID = new Set(["meta", "br", "img", "hr", "link", "input"]);

/** The tags left open or closed out of order, or an empty list when the document nests. */
function unbalanced(html: string): string[] {
  const stack: string[] = [];
  const problems: string[] = [];
  const body = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<!doctype[^>]*>/i, "");
  for (const m of body.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g)) {
    const [, closing, rawName, selfClosing] = m;
    const name = (rawName ?? "").toLowerCase();
    if (VOID.has(name) || selfClosing === "/") continue;
    if (closing === "/") {
      const open = stack.pop();
      if (open !== name) problems.push(`</${name}> closes <${open ?? "nothing"}>`);
    } else {
      stack.push(name);
    }
  }
  return [...problems, ...stack.map((s) => `<${s}> left open`)];
}

describe("Supabase Auth email templates", () => {
  it("covers every auth email and security notice the installed Supabase CLI configures", () => {
    expect(AUTH_EMAILS.map((e) => `${e.kind}.${e.name}`)).toEqual([
      "template.confirmation",
      "template.invite",
      "template.magic_link",
      "template.email_change",
      "template.recovery",
      "template.reauthentication",
      "notification.password_changed",
      "notification.email_changed",
      "notification.phone_changed",
      "notification.mfa_factor_enrolled",
      "notification.mfa_factor_unenrolled",
      "notification.identity_linked",
      "notification.identity_unlinked",
    ]);
    const files = readdirSync(`${root}supabase/templates`).sort();
    expect(files).toEqual(AUTH_EMAILS.map((e) => e.file).sort());
  });

  it("states the expiry that supabase/config.toml sets", () => {
    expect(config).toMatch(new RegExp(`\\notp_expiry = ${AUTH_EMAIL_LINK_SECONDS}\\n`));
    expect(AUTH_EMAIL_LINK_SECONDS).toBe(3600);
  });

  it("names the support and postal addresses legal/contact.md gives", () => {
    const contact = readFileSync(`${root}legal/contact.md`, "utf8");
    expect(contact).toContain(`**${AUTH_EMAIL_SUPPORT_ADDRESS}** is for everything else`);
    expect(contact).toContain(
      "| Postal address                                 | 66 W Flagler St, Suite 900, PMB 12524, Miami, FL 33130, United States",
    );
    expect(AUTH_EMAIL_POSTAL_ADDRESS).toBe(
      "GHXSTSHIP Industries LLC, 66 W Flagler St, Suite 900, PMB 12524, Miami, FL 33130, United States",
    );
  });

  it("tells the reader to open a PKCE link where they asked: sign-up, sign-in and reset", () => {
    for (const name of ["confirmation", "magic_link", "recovery"]) {
      const html = read(AUTH_EMAILS.find((e) => e.name === name)?.file ?? "");
      expect(html, name).toMatch(/in the browser where you/);
      expect(html, name).toMatch(/en el navegador donde/);
    }
  });

  /**
   * Site URL paths that arrive with another 4.19 branch. /auth/forgot-password is added by r419-forgot-password; once
   * the 4.19 train merges both branches the page exists, this test fails on the entry, and the train deletes it, so
   * from then on the route is checked like any other. Production applies these emails only once the route answers 200
   * (infra/runbooks/promote-to-production.md, step 6).
   */
  const ARRIVING_WITH_4_19 = new Set<string>(["/auth/forgot-password"]);

  it("links only to Site URL paths it lists, each an Atlas page", () => {
    const linked = new Set<string>();
    for (const email of AUTH_EMAILS) {
      for (const m of read(email.file).matchAll(/\{\{ \.SiteURL \}\}(\/[^"<\s]*)/g))
        linked.add(m[1] ?? "");
    }
    expect([...linked].sort()).toEqual([...AUTH_EMAIL_SITE_PATHS].sort());
    for (const path of AUTH_EMAIL_SITE_PATHS) {
      const page = existsSync(`${root}apps/atlas/app${path}/page.tsx`);
      if (ARRIVING_WITH_4_19.has(path)) {
        expect(page, `${path} is now a page: remove it from ARRIVING_WITH_4_19`).toBe(false);
      } else {
        expect(page, `${path} has no page in apps/atlas/app`).toBe(true);
      }
    }
  });

  for (const email of AUTH_EMAILS) {
    describe(`${email.kind} ${email.name}`, () => {
      const html = read(email.file);
      const shown = html.replace(/<!--[\s\S]*?-->/g, "");

      it("is the generated file, configured in supabase/config.toml with its subject", () => {
        expect(html).toBe(renderAuthEmail(email));
        expect(config).toContain(`${authEmailConfig(email)}\n`);
        expect(html).toContain(`<title>${email.subject}</title>`);
      });

      it("parses: nested tags and Go template actions that name a variable", () => {
        expect(unbalanced(html)).toEqual([]);
        const actions = [...html.matchAll(/\{\{[\s\S]*?\}\}/g)].map((m) => m[0]);
        expect(actions.length).toBeGreaterThan(0);
        for (const action of actions) expect(action).toMatch(/^\{\{ \.[A-Z][A-Za-z]* \}\}$/);
        // Go's template parser opens an action only at "{{"; a lone "}}" (the end of a CSS rule) is text.
        expect(html.replace(/\{\{ \.[A-Z][A-Za-z]* \}\}/g, "")).not.toContain("{{");
      });

      it("uses only the variables Supabase Auth fills for it", () => {
        const allowed = allowedVariables(email);
        const used = [...html.matchAll(/\{\{ \.(\w+) \}\}/g)].map((m) => m[1] ?? "");
        expect(used.filter((v) => !allowed.includes(v))).toEqual([]);
        for (const v of email.variables) expect(used).toContain(v);
      });

      it("loads nothing remote: no image, font, stylesheet, script or tracking URL", () => {
        expect(shown).not.toMatch(/<img|<link|<script|<iframe|@import|@font-face|url\(/i);
        expect(shown).not.toMatch(/fonts\.googleapis|fonts\.gstatic|typekit|use\.fontawesome/i);
        expect(shown).not.toMatch(/utm_|pixel|beacon|track|open\.gif|\/o\/|width="1" height="1"/i);
        // Every link is Supabase Auth's own address, the Site URL or the support mailbox.
        const hrefs = [...shown.matchAll(/href="([^"]*)"/g)].map((m) => m[1] ?? "");
        for (const href of hrefs) {
          expect(href).toMatch(
            /^(\{\{ \.ConfirmationURL \}\}|\{\{ \.SiteURL \}\}\/auth\/forgot-password|mailto:support@ghxstship\.pro)$/,
          );
        }
      });

      it("reads in both launch locales, with the action, the expiry and what to do if it was not you", () => {
        expect(shown).toContain('<html lang="en-US"');
        expect(shown).toContain('lang="en-US"');
        expect(shown).toContain('lang="es-US"');
        expect(shown).toContain(email.en.heading);
        expect(shown).toContain(email.es.heading);
        expect(shown).toContain(email.en.expiry);
        expect(shown).toContain(email.es.expiry);
        expect(shown).toContain("If you did not");
        expect(shown).toContain("Si no ");
        if (email.url !== undefined) {
          expect(shown).toContain(`>${email.en.action ?? ""}</a>`);
          expect(shown).toContain(`>${email.url}</a>`);
        } else {
          expect(shown).toContain(email.code);
        }
        if (email.kind === "template" && email.name !== "reauthentication") {
          expect(email.en.expiry).toContain("expires in 1 hour");
        }
      });

      it("wears the platform brand, light and dark, with the legal footer", () => {
        expect(shown).toContain(">XOS</td>");
        expect(shown).toContain('<meta name="color-scheme" content="light dark">');
        expect(shown).toContain("@media (prefers-color-scheme: dark)");
        expect(shown).toContain("[data-ogsc]");
        expect(shown).toContain(`Sent by XOS, ${AUTH_EMAIL_POSTAL_ADDRESS}.`);
        expect(shown).toContain(`mailto:${AUTH_EMAIL_SUPPORT_ADDRESS}`);
        // What a recipient reads never names the release, staging, the demo tenant or the provider.
        expect(shown).not.toMatch(/XOS 4\.|staging|demo|Supabase/i);
        expect(shown).not.toMatch(/\{\{accent-text\}\}/);
      });
    });
  }
});
