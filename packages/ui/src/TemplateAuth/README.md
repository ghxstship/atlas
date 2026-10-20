# TemplateAuth

Auth is the template for sign in, MFA, invite acceptance and passkey setup: a centered 400 px card on the brand background.

- Passwordless first: passkey, Sign in with Apple, Google, magic link. Passwords remain available, never first.
- Provider buttons (Continue with Google) use the secondary Button at full width, with the catalog label as the accessible name. A provider's mark keeps its own colors on every theme (Google's sign-in branding guidelines), so it is an image file beside the label, never a recolored icon or a color literal (ADR 0036).
