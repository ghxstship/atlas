import tokens from "@xos/tokens/tokens.json" with { type: "json" };
import { color, fontFamily, layout, radius, space, stroke, text } from "./theme.ts";

/**
 * The emails Supabase Auth sends (release 4.19, owner request of 2026-11-27): the six auth emails and the seven
 * security notices, in the XOS platform brand and the look of templates/layout.tsx. Supabase Auth sends one template
 * per email whatever the reader's language, so each email carries the en-US text first and a short es-US version
 * under it, the two launch locales. The files in supabase/templates are generated from this module
 * (`pnpm --filter @xos/email auth-templates`); supabase/config.toml names each file with its subject, and
 * infra/runbooks/promote-to-production.md, step 6, applies them to the hosted project.
 *
 * Every link goes through Supabase Auth's own `{{ .ConfirmationURL }}`, as the apps expect: Atlas and Gateway start
 * each email flow with PKCE and a redirect to /auth/callback, which exchanges the code (a reset link goes on to
 * /auth/reset-password). The security notices point at /auth/forgot-password on the Site URL.
 *
 * The emails load nothing: no image, font, stylesheet or tracking pixel. The mark is the platform brand's monogram
 * tile, drawn in HTML as BrandMark draws it until the platform marks are set (packages/ui/src/brand/defaults).
 */

/** The postal address the legal footer uses (legal/contact.md, Company). */
export const AUTH_EMAIL_POSTAL_ADDRESS =
  "GHXSTSHIP Industries LLC, 66 W Flagler St, Suite 900, PMB 12524, Miami, FL 33130, United States";

/** The help address (legal/contact.md, Email: help with Atlas, Gateway, Compass or the API). */
export const AUTH_EMAIL_SUPPORT_ADDRESS = "support@ghxstship.pro";

/** How long an email link or code works: `[auth.email] otp_expiry` in supabase/config.toml, in seconds. */
export const AUTH_EMAIL_LINK_SECONDS = 3600;

/** The variables Supabase Auth fills in every email, and those it adds to every auth email (not the notices). */
const COMMON_VARIABLES = ["SiteURL", "Email", "Data"] as const;
const AUTH_VARIABLES = ["ConfirmationURL", "Token", "TokenHash", "RedirectTo"] as const;

export type AuthEmailKind = "template" | "notification";

/** One copy of the email in one language. Text may hold inline HTML and Supabase Auth variables. */
interface LocaleCopy {
  readonly heading: string;
  readonly paragraphs: readonly string[];
  readonly action?: string;
  /** The line under the action: how long it works, or that the notice needs nothing. */
  readonly expiry: string;
  /** What to do if the reader did not ask for this. */
  readonly notYou: string;
}

export interface AuthEmail {
  /** The key in supabase/config.toml: `[auth.email.template.<name>]` or `[auth.email.notification.<name>]`. */
  readonly name: string;
  readonly kind: AuthEmailKind;
  /** The file in supabase/templates. */
  readonly file: string;
  readonly subject: string;
  /** The hidden preview line inbox lists show. */
  readonly preview: string;
  /** The address the button and the raw link open. */
  readonly url?: string;
  /** A one-time code shown in place of a link. */
  readonly code?: string;
  /** The variables Supabase Auth adds for this email alone, beyond allowedVariables' common ones. */
  readonly variables: readonly string[];
  readonly en: LocaleCopy;
  readonly es: LocaleCopy;
}

const CONFIRMATION_URL = "{{ .ConfirmationURL }}";
const RESET_URL = "{{ .SiteURL }}/auth/forgot-password";
const EMAIL = "<strong>{{ .Email }}</strong>";

const LINK_HOUR_EN = "The link works once and expires in 1 hour.";
const LINK_HOUR_ES = "El enlace funciona una vez y vence en 1 hora.";
const NOTICE_EN = "This notice needs no action if the change was yours.";
const NOTICE_ES = "Este aviso no requiere ninguna acción si el cambio fue tuyo.";
const NOT_YOU_NOTICE_EN = `If you did not make this change, reset your password now with the button above and write to <a href="mailto:${AUTH_EMAIL_SUPPORT_ADDRESS}" class="x-link" style="color:{{accent-text}}">${AUTH_EMAIL_SUPPORT_ADDRESS}</a> with "Security" in the subject line.`;
const NOT_YOU_NOTICE_ES = `Si no hiciste este cambio, restablece tu contraseña ahora con el botón de arriba y escribe a <a href="mailto:${AUTH_EMAIL_SUPPORT_ADDRESS}" class="x-link" style="color:{{accent-text}}">${AUTH_EMAIL_SUPPORT_ADDRESS}</a> con "Security" en el asunto.`;

function notice(
  name: string,
  subject: string,
  variables: readonly string[],
  en: { heading: string; body: string },
  es: { heading: string; body: string },
): AuthEmail {
  return {
    name,
    kind: "notification",
    file: `${name}_notification.html`,
    subject,
    preview: en.body.replace(/<[^>]+>/g, ""),
    url: RESET_URL,
    variables,
    en: {
      heading: en.heading,
      paragraphs: [en.body],
      action: "Reset password",
      expiry: NOTICE_EN,
      notYou: NOT_YOU_NOTICE_EN,
    },
    es: {
      heading: es.heading,
      paragraphs: [es.body],
      action: "Restablecer contraseña",
      expiry: NOTICE_ES,
      notYou: NOT_YOU_NOTICE_ES,
    },
  };
}

/** Every email Supabase Auth sends, in the order of supabase/config.toml. */
export const AUTH_EMAILS: readonly AuthEmail[] = [
  {
    name: "confirmation",
    kind: "template",
    file: "confirmation.html",
    subject: "Confirm your email for XOS",
    preview: "Confirm your email address to finish signing up for XOS.",
    url: CONFIRMATION_URL,
    variables: [],
    en: {
      heading: "Confirm your email",
      paragraphs: [`Confirm ${EMAIL} to finish signing up for XOS.`],
      action: "Confirm email",
      expiry: LINK_HOUR_EN,
      notYou:
        "If you did not sign up for XOS, ignore this email. No account is made without this step.",
    },
    es: {
      heading: "Confirma tu correo",
      paragraphs: [`Confirma ${EMAIL} para terminar de registrarte en XOS.`],
      action: "Confirmar correo",
      expiry: LINK_HOUR_ES,
      notYou:
        "Si no te registraste en XOS, ignora este correo. Sin este paso no se crea ninguna cuenta.",
    },
  },
  {
    name: "invite",
    kind: "template",
    file: "invite.html",
    subject: "You are invited to XOS",
    preview: "Accept your invitation to XOS.",
    url: CONFIRMATION_URL,
    variables: [],
    en: {
      heading: "You are invited to XOS",
      paragraphs: [
        `An XOS account is ready for ${EMAIL}. Accept the invitation to sign in and set it up.`,
      ],
      action: "Accept invitation",
      expiry: LINK_HOUR_EN,
      notYou: "If you did not expect this invitation, ignore this email. The account stays unused.",
    },
    es: {
      heading: "Te invitaron a XOS",
      paragraphs: [
        `Hay una cuenta de XOS lista para ${EMAIL}. Acepta la invitación para iniciar sesión y configurarla.`,
      ],
      action: "Aceptar invitación",
      expiry: LINK_HOUR_ES,
      notYou: "Si no esperabas esta invitación, ignora este correo. La cuenta queda sin usar.",
    },
  },
  {
    name: "magic_link",
    kind: "template",
    file: "magic_link.html",
    subject: "Your XOS sign-in link",
    preview: "Sign in to XOS with one click.",
    url: CONFIRMATION_URL,
    variables: [],
    en: {
      heading: "Sign in to XOS",
      paragraphs: [
        `Use the button below to sign in as ${EMAIL}. Open it on the device where you asked for it.`,
      ],
      action: "Sign in",
      expiry: LINK_HOUR_EN,
      notYou:
        "If you did not ask to sign in, ignore this email. Nobody can sign in without this link.",
    },
    es: {
      heading: "Inicia sesión en XOS",
      paragraphs: [
        `Usa el botón de abajo para iniciar sesión como ${EMAIL}. Ábrelo en el dispositivo donde lo pediste.`,
      ],
      action: "Iniciar sesión",
      expiry: LINK_HOUR_ES,
      notYou:
        "Si no pediste iniciar sesión, ignora este correo. Nadie puede entrar sin este enlace.",
    },
  },
  {
    name: "email_change",
    kind: "template",
    file: "email_change.html",
    subject: "Confirm your new email for XOS",
    preview: "Confirm the change of your XOS email address.",
    url: CONFIRMATION_URL,
    variables: ["NewEmail"],
    en: {
      heading: "Confirm your new email",
      paragraphs: [
        `Confirm the change of your XOS email from ${EMAIL} to <strong>{{ .NewEmail }}</strong>. The same email goes to both addresses, and the change takes effect once both confirm.`,
      ],
      action: "Confirm change",
      expiry: LINK_HOUR_EN,
      notYou: `If you did not ask for this change, ignore this email and your email address stays the same. Write to <a href="mailto:${AUTH_EMAIL_SUPPORT_ADDRESS}" class="x-link" style="color:{{accent-text}}">${AUTH_EMAIL_SUPPORT_ADDRESS}</a> with "Security" in the subject line.`,
    },
    es: {
      heading: "Confirma tu nuevo correo",
      paragraphs: [
        `Confirma el cambio de tu correo de XOS de ${EMAIL} a <strong>{{ .NewEmail }}</strong>. Este correo llega a las dos direcciones, y el cambio se aplica cuando ambas lo confirman.`,
      ],
      action: "Confirmar cambio",
      expiry: LINK_HOUR_ES,
      notYou: "Si no pediste este cambio, ignora este correo y tu dirección sigue igual.",
    },
  },
  {
    name: "recovery",
    kind: "template",
    file: "recovery.html",
    subject: "Reset your XOS password",
    preview: "Choose a new password for your XOS account.",
    url: CONFIRMATION_URL,
    variables: [],
    en: {
      heading: "Reset your password",
      paragraphs: [`Use the button below to choose a new password for ${EMAIL}.`],
      action: "Reset password",
      expiry: LINK_HOUR_EN,
      notYou:
        "If you did not ask to reset your password, ignore this email. Your password stays the same.",
    },
    es: {
      heading: "Restablece tu contraseña",
      paragraphs: [`Usa el botón de abajo para elegir una nueva contraseña para ${EMAIL}.`],
      action: "Restablecer contraseña",
      expiry: LINK_HOUR_ES,
      notYou:
        "Si no pediste restablecer tu contraseña, ignora este correo. Tu contraseña sigue igual.",
    },
  },
  {
    name: "reauthentication",
    kind: "template",
    file: "reauthentication.html",
    subject: "Your XOS confirmation code",
    preview: "Your XOS confirmation code is inside.",
    code: "{{ .Token }}",
    variables: [],
    en: {
      heading: "Your confirmation code",
      paragraphs: [`Enter this code in XOS to confirm a change to the account of ${EMAIL}.`],
      expiry: "The code works once and expires in 1 hour.",
      notYou: `If you did not ask for a code, someone may know your password. Reset it at <a href="{{ .SiteURL }}/auth/forgot-password" class="x-link" style="color:{{accent-text}}">{{ .SiteURL }}/auth/forgot-password</a> and never share this code.`,
    },
    es: {
      heading: "Tu código de confirmación",
      paragraphs: [`Escribe este código en XOS para confirmar un cambio en la cuenta de ${EMAIL}.`],
      expiry: "El código funciona una vez y vence en 1 hora.",
      notYou:
        "Si no pediste un código, alguien podría conocer tu contraseña. Restablécela y nunca compartas este código.",
    },
  },
  notice(
    "password_changed",
    "Your XOS password was changed",
    [],
    {
      heading: "Your password was changed",
      body: `The password of the XOS account ${EMAIL} was changed.`,
    },
    {
      heading: "Se cambió tu contraseña",
      body: `Se cambió la contraseña de la cuenta de XOS ${EMAIL}.`,
    },
  ),
  notice(
    "email_changed",
    "Your XOS email address was changed",
    ["OldEmail"],
    {
      heading: "Your email address was changed",
      body: `The email address of your XOS account changed from <strong>{{ .OldEmail }}</strong> to ${EMAIL}.`,
    },
    {
      heading: "Se cambió tu correo",
      body: `El correo de tu cuenta de XOS cambió de <strong>{{ .OldEmail }}</strong> a ${EMAIL}.`,
    },
  ),
  notice(
    "phone_changed",
    "Your XOS phone number was changed",
    ["Phone", "OldPhone"],
    {
      heading: "Your phone number was changed",
      body: `The phone number of the XOS account ${EMAIL} changed from <strong>{{ .OldPhone }}</strong> to <strong>{{ .Phone }}</strong>.`,
    },
    {
      heading: "Se cambió tu teléfono",
      body: `El teléfono de la cuenta de XOS ${EMAIL} cambió de <strong>{{ .OldPhone }}</strong> a <strong>{{ .Phone }}</strong>.`,
    },
  ),
  notice(
    "mfa_factor_enrolled",
    "A verification method was added to your XOS account",
    ["FactorType"],
    {
      heading: "A verification method was added",
      body: `A <strong>{{ .FactorType }}</strong> verification method was added to the XOS account ${EMAIL}.`,
    },
    {
      heading: "Se agregó un método de verificación",
      body: `Se agregó un método de verificación <strong>{{ .FactorType }}</strong> a la cuenta de XOS ${EMAIL}.`,
    },
  ),
  notice(
    "mfa_factor_unenrolled",
    "A verification method was removed from your XOS account",
    ["FactorType"],
    {
      heading: "A verification method was removed",
      body: `A <strong>{{ .FactorType }}</strong> verification method was removed from the XOS account ${EMAIL}.`,
    },
    {
      heading: "Se quitó un método de verificación",
      body: `Se quitó un método de verificación <strong>{{ .FactorType }}</strong> de la cuenta de XOS ${EMAIL}.`,
    },
  ),
  notice(
    "identity_linked",
    "A sign-in method was linked to your XOS account",
    ["Provider"],
    {
      heading: "A sign-in method was linked",
      body: `Your <strong>{{ .Provider }}</strong> account can now sign in to the XOS account ${EMAIL}.`,
    },
    {
      heading: "Se vinculó un método de inicio de sesión",
      body: `Tu cuenta de <strong>{{ .Provider }}</strong> ahora puede iniciar sesión en la cuenta de XOS ${EMAIL}.`,
    },
  ),
  notice(
    "identity_unlinked",
    "A sign-in method was removed from your XOS account",
    ["Provider"],
    {
      heading: "A sign-in method was removed",
      body: `Your <strong>{{ .Provider }}</strong> account can no longer sign in to the XOS account ${EMAIL}.`,
    },
    {
      heading: "Se quitó un método de inicio de sesión",
      body: `Tu cuenta de <strong>{{ .Provider }}</strong> ya no puede iniciar sesión en la cuenta de XOS ${EMAIL}.`,
    },
  ),
];

/** The variables `email` may use. */
export function allowedVariables(email: AuthEmail): readonly string[] {
  return [
    ...COMMON_VARIABLES,
    ...(email.kind === "template" ? AUTH_VARIABLES : []),
    ...email.variables,
  ];
}

interface ColorToken {
  readonly name: string;
  readonly value: string | { readonly dark?: string };
}

/** A color token in the Dark theme, for mail clients that honor prefers-color-scheme. */
function dark(name: string): string {
  const token = (tokens.color.tokens as readonly ColorToken[]).find((t) => t.name === name);
  const value = typeof token?.value === "string" ? token.value : token?.value.dark;
  if (value === undefined || !/^#[0-9A-Fa-f]{6}$/.test(value)) {
    throw new Error(`Color token ${name} has no dark hex value`);
  }
  return value;
}

const MONO: string = tokens.type.families.mono;

/** Inline font stacks keep their quotes as single quotes, so they sit inside double-quoted style attributes. */
const SANS_INLINE = fontFamily.replace(/"/g, "'");
const MONO_INLINE = MONO.replace(/"/g, "'");

function paint(html: string): string {
  return html.replace(/\{\{accent-text\}\}/g, color("accent-text"));
}

/** A type style as inline CSS. */
function type(name: string): string {
  const style = text(name);
  return `font-size:${style.fontSize};line-height:${String(style.lineHeight)};font-weight:${String(style.fontWeight)}`;
}

const S = {
  4: space("space-4"),
  8: space("space-8"),
  12: space("space-12"),
  16: space("space-16"),
  20: space("space-20"),
  24: space("space-24"),
  32: space("space-32"),
} as const;
const HAIRLINE = `${stroke("stroke-hairline")} solid ${color("border-subtle")}`;
const CONTROL = radius("radius-control");

function darkStyles(): string {
  const rules = [
    `.x-bg{background-color:${dark("bg-surface")} !important}`,
    `.x-card{background-color:${dark("bg-raised")} !important;border-color:${dark("border-subtle")} !important}`,
    `.x-text{color:${dark("text-primary")} !important}`,
    `.x-muted{color:${dark("text-secondary")} !important}`,
    `.x-link{color:${dark("accent-text")} !important}`,
    `.x-rule{border-color:${dark("border-subtle")} !important}`,
    `.x-btn{background-color:${dark("accent-default")} !important}`,
    `.x-code{background-color:${dark("bg-surface")} !important;color:${dark("text-primary")} !important}`,
  ];
  // Apple Mail and iOS Mail honor the media query; Outlook.com marks dark mode with data-ogsc and data-ogsb.
  return [
    "      :root{color-scheme:light dark;supported-color-schemes:light dark}",
    `      @media (prefers-color-scheme: dark){${rules.join("")}}`,
    `      ${rules.map((r) => `[data-ogsc] ${r}`).join("")}`,
    "      a{text-decoration:underline}",
    `      @media (max-width:${layout("layout-form")}){.x-pad{padding:${S[24]} !important}}`,
  ].join("\n");
}

function section(email: AuthEmail, copy: LocaleCopy, lang: "en" | "es"): string {
  const body = `${type("text-14")};color:${color("text-primary")}`;
  const muted = `${type("text-12")};color:${color("text-secondary")}`;
  const level = lang === "en" ? 1 : 2;
  const heading = type(lang === "en" ? "heading-20" : "heading-16");
  const rows: string[] = [
    `<tr><td style="padding:0 0 ${S[16]}"><h${String(level)} class="x-text" style="margin:0;${heading};color:${color("text-primary")}">${copy.heading}</h${String(level)}></td></tr>`,
    ...copy.paragraphs.map(
      (p) => `<tr><td class="x-text" style="padding:0 0 ${S[16]};${body}">${p}</td></tr>`,
    ),
  ];
  if (email.code !== undefined) {
    rows.push(
      `<tr><td style="padding:0 0 ${S[16]}"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td class="x-code" style="padding:${S[12]} ${S[20]};background-color:${color("bg-surface")};border-radius:${CONTROL};font-family:${MONO_INLINE};${type("heading-32")};letter-spacing:${S[4]};color:${color("text-primary")}">${email.code}</td></tr></table></td></tr>`,
    );
  }
  if (email.url !== undefined && copy.action !== undefined) {
    rows.push(
      `<tr><td style="padding:${S[8]} 0 ${S[16]}"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td class="x-btn" bgcolor="${color("accent-default")}" style="border-radius:${CONTROL};background-color:${color("accent-default")}"><a href="${email.url}" class="x-btn" style="display:inline-block;padding:${S[12]} ${S[20]};border-radius:${CONTROL};background-color:${color("accent-default")};color:${color("accent-text-on")};${type("label-13")};text-decoration:none">${copy.action}</a></td></tr></table></td></tr>`,
    );
    rows.push(
      lang === "en"
        ? `<tr><td class="x-muted" style="padding:0 0 ${S[16]};${muted}">If the button does not open, paste this link into your browser:<br><a href="${email.url}" class="x-link" style="color:${color("accent-text")};word-break:break-all">${email.url}</a></td></tr>`
        : `<tr><td class="x-muted" style="padding:0 0 ${S[16]};${muted}">Si el botón no se abre, usa el enlace de arriba.</td></tr>`,
    );
  }
  rows.push(
    `<tr><td class="x-muted" style="padding:0 0 ${S[8]};${muted}">${copy.expiry}</td></tr>`,
    `<tr><td class="x-muted" style="padding:0 0 ${S[8]};${muted}">${paint(copy.notYou)}</td></tr>`,
  );
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" lang="${lang === "en" ? "en-US" : "es-US"}">\n${rows.map((r) => `                  ${r}`).join("\n")}\n                </table>`;
}

/** The HTML of one Supabase Auth email, as the file in supabase/templates holds it. */
export function renderAuthEmail(email: AuthEmail): string {
  const muted = `${type("text-12")};color:${color("text-secondary")}`;
  const support = `<a href="mailto:${AUTH_EMAIL_SUPPORT_ADDRESS}" class="x-link" style="color:${color("accent-text")}">${AUTH_EMAIL_SUPPORT_ADDRESS}</a>`;
  const tile = S[32];
  return `<!doctype html>
<html lang="en-US" dir="ltr" xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="x-apple-disable-message-reformatting">
    <meta name="color-scheme" content="light dark">
    <meta name="supported-color-schemes" content="light dark">
    <title>${email.subject}</title>
    <style>
${darkStyles()}
    </style>
  </head>
  <!-- Generated from packages/email/src/auth-templates.ts by \`pnpm --filter @xos/email auth-templates\`. Never edit by hand:
       edit the module, regenerate, and keep supabase/config.toml's subject in step (packages/email/test/auth-templates.test.ts). -->
  <body class="x-bg" style="margin:0;padding:0;background-color:${color("bg-surface")};font-family:${SANS_INLINE};-webkit-text-size-adjust:100%">
    <div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${email.preview}</div>
    <table role="presentation" class="x-bg" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${color("bg-surface")}" style="background-color:${color("bg-surface")}">
      <tr>
        <td align="center" style="padding:${S[24]} ${S[16]}">
          <table role="presentation" class="x-card" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${color("bg-raised")}" style="max-width:${layout("layout-peek")};background-color:${color("bg-raised")};border:${HAIRLINE};border-radius:${radius("radius-card")}">
            <tr>
              <td class="x-pad" style="padding:${S[32]};font-family:${SANS_INLINE}">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td class="x-btn" width="${tile.replace("px", "")}" height="${tile.replace("px", "")}" align="center" valign="middle" bgcolor="${color("accent-default")}" aria-hidden="true" style="width:${tile};height:${tile};border-radius:${CONTROL};background-color:${color("accent-default")};color:${color("accent-text-on")};${type("heading-16")};line-height:${tile};font-weight:700">X</td>
                    <td class="x-text" style="padding:0 0 0 ${S[8]};${type("heading-20")};line-height:${tile};color:${color("text-primary")}">XOS</td>
                  </tr>
                </table>
                <div style="height:${S[24]};line-height:${S[24]};font-size:0">&nbsp;</div>
                ${section(email, email.en, "en")}
                <div class="x-rule" style="height:${S[16]};line-height:${S[16]};font-size:0;border-top:${HAIRLINE};margin-top:${S[16]}">&nbsp;</div>
                ${section(email, email.es, "es")}
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr><td class="x-muted x-rule" style="padding:${S[16]} 0 0;border-top:${HAIRLINE};${muted}">Questions? Write to ${support}. / ¿Preguntas? Escribe a ${support}.</td></tr>
                  <tr><td class="x-muted" style="padding:${S[8]} 0 0;${muted}">You are receiving this email because of activity on your XOS account. / Recibes este correo por actividad en tu cuenta de XOS.</td></tr>
                  <tr><td class="x-muted" style="padding:${S[8]} 0 0;${muted}">Sent by XOS, ${AUTH_EMAIL_POSTAL_ADDRESS}.</td></tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`;
}

/** The `supabase/config.toml` section of one email, as the file holds it. */
export function authEmailConfig(email: AuthEmail): string {
  const lines = [`[auth.email.${email.kind}.${email.name}]`];
  if (email.kind === "notification") lines.push("enabled = true");
  lines.push(`subject = "${email.subject}"`, `content_path = "./supabase/templates/${email.file}"`);
  return lines.join("\n");
}
