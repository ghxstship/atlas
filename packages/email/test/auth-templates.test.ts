import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The sign-in emails Supabase Auth sends wear the XOS platform brand (4.9 email branding audit): one template per
 * Auth email in supabase/templates, each named in supabase/config.toml with its subject. Production sets the same
 * subjects and HTML in the hosted project (infra/runbooks/promote-to-production.md, step 6).
 */
const root = fileURLToPath(new URL("../../../", import.meta.url));
const config = readFileSync(`${root}supabase/config.toml`, "utf8");
const POSTAL = "66 W Flagler St, Suite 900, PMB 12524, Miami, FL 33130";

const TEMPLATES = {
  confirmation: { subject: "Confirm your email for XOS", needs: "{{ .ConfirmationURL }}" },
  invite: { subject: "You are invited to XOS", needs: "{{ .ConfirmationURL }}" },
  magic_link: { subject: "Your XOS sign-in link", needs: "{{ .ConfirmationURL }}" },
  email_change: { subject: "Confirm your new email for XOS", needs: "{{ .NewEmail }}" },
  recovery: { subject: "Reset your XOS password", needs: "{{ .ConfirmationURL }}" },
  reauthentication: { subject: "Your XOS confirmation code", needs: "{{ .Token }}" },
} as const;

describe("Supabase Auth email templates", () => {
  for (const [name, { subject, needs }] of Object.entries(TEMPLATES)) {
    it(`${name} is configured with its subject and wears the XOS brand`, () => {
      const section = new RegExp(
        `\\[auth\\.email\\.template\\.${name}\\]\\nsubject = "${subject}"\\ncontent_path = "\\./supabase/templates/${name}\\.html"`,
      );
      expect(config).toMatch(section);
      const html = readFileSync(`${root}supabase/templates/${name}.html`, "utf8");
      expect(html).toContain('<html lang="en"');
      expect(html).toContain(needs);
      expect(html).toContain(">XOS</td>");
      expect(html).toContain(`Sent by XOS, ${POSTAL}.`);
      // What a recipient reads never names the release, staging, the demo tenant or the provider.
      const shown = html.replace(/<!--[\s\S]*?-->/g, "");
      expect(shown).not.toMatch(/XOS 4\.0|staging|demo|Supabase/i);
      // Only the variables Supabase Auth fills.
      const variables = [...html.matchAll(/\{\{\s*\.(\w+)\s*\}\}/g)].map((m) => m[1]);
      expect(
        variables.every((v) => ["ConfirmationURL", "Token", "Email", "NewEmail"].includes(v ?? "")),
      ).toBe(true);
    });
  }

  it("names the postal address the legal Contact page gives", () => {
    expect(readFileSync(`${root}legal/contact.md`, "utf8")).toContain(
      "66 W Flagler St, Suite 900, PMB 12524",
    );
  });
});
