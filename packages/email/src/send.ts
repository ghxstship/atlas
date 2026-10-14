import { renderEmail, type RenderOptions } from "./render.ts";
import type { TemplateCode, TemplateProps } from "./templates/index.tsx";
import type { EmailTransport, SendResult } from "./transport.ts";

export interface SendRequest<C extends TemplateCode> extends RenderOptions {
  readonly transport: EmailTransport;
  readonly template: C;
  readonly props: TemplateProps[C];
  readonly from: string;
  readonly to: string;
  /** Signed reply-to address for reply by email (Section 4.6.5), when the email accepts replies. */
  readonly replyTo?: string;
  /** Notification delivery id: tags the message and keys the provider idempotency. */
  readonly deliveryId?: string;
}

/**
 * Renders and sends one email. Non-transactional email gets List-Unsubscribe headers for one-click
 * unsubscribe (RFC 8058). Returns the provider message id for app.record_notification_delivery.
 */
export async function sendEmail<C extends TemplateCode>(
  request: SendRequest<C>,
): Promise<SendResult> {
  const rendered = await renderEmail(request.template, request.props, request);
  const unsubscribe = request.sender.unsubscribeUrl;
  const headers: Record<string, string> =
    !rendered.transactional && unsubscribe !== undefined
      ? {
          "List-Unsubscribe": `<${unsubscribe}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        }
      : {};
  return request.transport.send({
    from: request.from,
    to: request.to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    headers,
    tags: [
      { name: "template", value: request.template },
      ...(request.deliveryId === undefined
        ? []
        : [{ name: "delivery_id", value: request.deliveryId }]),
    ],
    ...(request.replyTo === undefined ? {} : { replyTo: request.replyTo }),
    ...(request.deliveryId === undefined
      ? {}
      : { idempotencyKey: `delivery-${request.deliveryId}` }),
  });
}
