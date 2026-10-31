import { renderEmail, type RenderOptions } from "./render.ts";
import type { TemplateCode, TemplateProps } from "./templates/index.tsx";
import { assertAttachmentSize, type EmailAttachment, type EmailTransport, type SendResult } from "./transport.ts";

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
  /** Files sent with the email (the guest pass, B8); at most 10 MB together, checked before any transport runs. */
  readonly attachments?: readonly EmailAttachment[];
  /** Extra tags, such as the org id a bounce webhook resolves to app.record_email_feedback. */
  readonly tags?: readonly { readonly name: string; readonly value: string }[];
  /** Provider idempotency key when the send has no delivery id (a guest email row, B8). */
  readonly idempotencyKey?: string;
}

/**
 * Renders and sends one email. Non-transactional email gets List-Unsubscribe headers for one-click
 * unsubscribe (RFC 8058). Returns the provider message id for app.record_notification_delivery.
 */
export async function sendEmail<C extends TemplateCode>(
  request: SendRequest<C>,
): Promise<SendResult> {
  assertAttachmentSize(request.attachments);
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
      ...(request.tags ?? []),
    ],
    ...(request.replyTo === undefined ? {} : { replyTo: request.replyTo }),
    ...(request.deliveryId === undefined
      ? request.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: request.idempotencyKey }
      : { idempotencyKey: `delivery-${request.deliveryId}` }),
    ...(request.attachments === undefined || request.attachments.length === 0
      ? {}
      : { attachments: request.attachments }),
  });
}
