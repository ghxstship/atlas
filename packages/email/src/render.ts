import type { Locale } from "@xos/i18n";
import { translator } from "./messages.ts";
import { TEMPLATE_CODES } from "./templates/codes.ts";
import type { Sender } from "./templates/layout.tsx";
import type { TemplateCode, TemplateProps } from "./templates/index.tsx";

export interface RenderOptions {
  readonly locale: Locale;
  /** IANA time zone dates are shown in. */
  readonly timeZone?: string;
  readonly sender: Sender;
  readonly recipientName: string;
}

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly transactional: boolean;
}

/** True when the code names a template in this package. */
export function isTemplateCode(code: string): code is TemplateCode {
  return (TEMPLATE_CODES as readonly string[]).includes(code);
}

/**
 * Renders a template to semantic HTML and a plain-text part, with every string from the locale's
 * email catalog. Non-transactional email without an unsubscribe link is refused (CAN-SPAM, CASL).
 * React Email and the templates load on the first render rather than with this module, so a worker
 * run that sends nothing never parses them (A85).
 */
export async function renderEmail<C extends TemplateCode>(
  code: C,
  props: TemplateProps[C],
  options: RenderOptions,
): Promise<RenderedEmail> {
  const [{ render }, { templates }] = await Promise.all([
    import("@react-email/components"),
    import("./templates/index.tsx"),
  ]);
  const template = templates[code];
  if (!template.transactional && options.sender.unsubscribeUrl === undefined) {
    throw new Error(`The ${code} email is not transactional and needs an unsubscribe link`);
  }
  const t = translator(options.locale, options.timeZone ?? "UTC");
  const { subject, element } = template.compose(props, {
    locale: options.locale,
    t,
    sender: options.sender,
    recipientName: options.recipientName,
  });
  const [html, text] = await Promise.all([render(element), render(element, { plainText: true })]);
  return { subject, html, text, transactional: template.transactional };
}
