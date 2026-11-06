/** Why a guest would get no email of a kind (app.guest_emails.skip_reason); null when they would. */
export type GuestEmailSkip = "No Email" | "Not Live" | "No Pass" | null;

/** A guest the Email guests dialog can email, with why each kind would skip them. */
export interface EmailableGuest {
  readonly id: string;
  readonly name: string;
  /** Why the guest gets no Invitation or Message, and why no Pass. */
  readonly skip: { readonly any: GuestEmailSkip; readonly pass: GuestEmailSkip };
}
