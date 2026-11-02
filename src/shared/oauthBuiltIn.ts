// BidMail's own Microsoft / Google app registrations, built into release builds so nobody has to paste client IDs.
// The values come from environment variables at build time (GitHub Actions sets them from the repository's
// variables, see electron.vite.config.ts). Client IDs are not secret. A company's own IDs in Settings win over these.
export const BUILT_IN_OAUTH = {
  microsoftClientId: process.env.BIDMAIL_MS_CLIENT_ID ?? '',
  googleClientId: process.env.BIDMAIL_GOOGLE_CLIENT_ID ?? ''
}
