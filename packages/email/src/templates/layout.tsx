import type { ReactNode } from "react";
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import type { Locale } from "@xos/i18n";
import type { Translate } from "../messages.ts";
import { brandAccent, color, fontFamily, layout, radius, space, stroke, text } from "../theme.ts";

/** Who sends the email and how the recipient opts out (CAN-SPAM and CASL, Section 14.5). */
export interface Sender {
  /** Organization name shown as the sender. */
  readonly orgName: string;
  /** Physical postal address of the sender, required in every email. */
  readonly postalAddress: string;
  /** Link to the recipient's notification preferences. */
  readonly preferencesUrl: string;
  /** One-click unsubscribe link; required for non-transactional email. */
  readonly unsubscribeUrl?: string;
  /**
   * The org's brand while white label is in force for it (A138, Section 12). Without it, or for
   * platform email (sign-in, billing), the email wears the platform brand.
   */
  readonly brand?: EmailBrand;
}

/** What an org's brand changes on its email: the logo above the heading and the accent. */
export interface EmailBrand {
  /** Public URL of the org's light logo, shown with the org name as its text alternative. */
  readonly logoUrl?: string;
  /** Six-digit hex accent, applied only when it passes the email contrast check (brandAccent). */
  readonly accentHex?: string;
}

export interface LayoutProps {
  readonly locale: Locale;
  readonly t: Translate;
  readonly sender: Sender;
  readonly preview: string;
  readonly heading: string;
  readonly transactional: boolean;
  readonly action?: { readonly label: string; readonly url: string };
  readonly children: ReactNode;
}

const styles = {
  body: {
    backgroundColor: color("bg-surface"),
    fontFamily,
    margin: "0",
    padding: `${space("space-24")} 0`,
  },
  container: {
    backgroundColor: color("bg-raised"),
    border: `${stroke("stroke-hairline")} solid ${color("border-subtle")}`,
    borderRadius: radius("radius-card"),
    margin: "0 auto",
    maxWidth: layout("layout-peek"),
    padding: space("space-32"),
  },
  heading: {
    ...text("heading-20"),
    color: color("text-primary"),
    margin: `0 0 ${space("space-16")}`,
  },
  button: {
    ...text("label-13"),
    backgroundColor: color("accent-default"),
    borderRadius: radius("radius-control"),
    color: color("accent-text-on"),
    padding: `${space("space-12")} ${space("space-20")}`,
    textDecoration: "none",
  },
  logo: { display: "block", height: space("space-32"), margin: `0 0 ${space("space-24")}` },
  rule: { borderColor: color("border-subtle"), margin: `${space("space-24")} 0` },
  footer: { ...text("text-12"), color: color("text-secondary"), margin: `0 0 ${space("space-8")}` },
  link: { color: color("accent-text") },
} as const;

/** Body copy paragraph in the email text style. */
export function Paragraph({ children }: { readonly children: ReactNode }) {
  return (
    <Text
      style={{
        ...text("text-14"),
        color: color("text-primary"),
        margin: `0 0 ${space("space-16")}`,
      }}
    >
      {children}
    </Text>
  );
}

/**
 * Shared email frame: a language-tagged document with a preview line, one heading, the content in
 * a main landmark, an optional single call to action, and a footer naming the sender, its postal
 * address, why the email was sent and, for non-transactional email, how to unsubscribe. An org's
 * brand adds its logo above the heading and paints the call to action in its accent; an accent that
 * fails the contrast check keeps the platform accent.
 */
export function Layout({
  locale,
  t,
  sender,
  preview,
  heading,
  transactional,
  action,
  children,
}: LayoutProps) {
  const accent = brandAccent(sender.brand?.accentHex);
  const button = accent === null ? styles.button : { ...styles.button, backgroundColor: accent };
  const logoUrl = sender.brand?.logoUrl;
  return (
    <Html lang={locale} dir="ltr">
      <Head />
      <Preview>{preview}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <main>
            {logoUrl !== undefined && (
              <Img src={logoUrl} alt={sender.orgName} style={styles.logo} />
            )}
            <Heading as="h1" style={styles.heading}>
              {heading}
            </Heading>
            {children}
            {action !== undefined && (
              <Section>
                <Button href={action.url} style={button}>
                  {action.label}
                </Button>
              </Section>
            )}
          </main>
          <Hr style={styles.rule} />
          <footer>
            <Text style={styles.footer}>
              {transactional
                ? t("common.whyTransactional")
                : t("common.whyNotification", { orgName: sender.orgName })}
            </Text>
            <Text style={styles.footer}>
              {t("common.sentBy", { orgName: sender.orgName, postalAddress: sender.postalAddress })}
            </Text>
            <Text style={styles.footer}>
              <Link href={sender.preferencesUrl} style={styles.link}>
                {t("common.managePreferences")}
              </Link>
              {!transactional && sender.unsubscribeUrl !== undefined && (
                <>
                  {" · "}
                  <Link href={sender.unsubscribeUrl} style={styles.link}>
                    {t("common.unsubscribe")}
                  </Link>
                </>
              )}
            </Text>
            <Text style={styles.footer}>{t("common.poweredBy")}</Text>
          </footer>
        </Container>
      </Body>
    </Html>
  );
}
