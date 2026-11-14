import { type ReactElement } from "react";
import { cx } from "../lib/cx.ts";
import { Icon } from "../Icon/Icon.tsx";
import { avatarClass, initials } from "../Avatar/avatar-class.ts";
import { cardClass } from "../Surface/Surface.tsx";
import { type TestimonialProps } from "./Marketing.types.ts";

/**
 * A customer's words. The disclosure line is required: it states the speaker's connection to the
 * publisher.
 */
export function Testimonial({
  quote,
  name,
  role,
  org,
  disclosure,
}: TestimonialProps): ReactElement {
  return (
    <figure className={cx(cardClass, "xos-mkt-quote")}>
      <blockquote>
        <p>{quote}</p>
      </blockquote>
      <figcaption>
        <span
          role="img"
          aria-label={name}
          title={name}
          className={cx(avatarClass, "size-(--ui-avatar) text-text-11")}
        >
          {initials(name)}
        </span>
        <span className="xos-mkt-quote-who">
          <strong>{name}</strong>
          <span>{role}</span>
          {org ? <span>{org}</span> : null}
        </span>
      </figcaption>
      <p className="xos-mkt-quote-disclosure">
        <Icon name="Info" size={12} />
        <span>{disclosure}</span>
      </p>
    </figure>
  );
}
