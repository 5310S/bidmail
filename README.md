# BidMail

Email and bid-invitation tracking for construction estimators, for Windows and macOS.

## Install

**Windows:** run `release\BidMail-Setup-1.1.0.exe`. The installer is not code-signed yet, so Windows may show
"Windows protected your PC". Click **More info > Run anyway**.

**Mac:** open `BidMail-1.1.0-mac-arm64.dmg` (Apple Silicon: M1-M4) or `BidMail-1.1.0-mac-x64.dmg` (Intel) and drag
BidMail to Applications. It is not notarized by Apple yet: the first time, **right-click BidMail > Open**, then **Open**
(on recent macOS: **System Settings > Privacy & Security > Open Anyway**). See "Building the Mac version" below.

## First-time setup

1. **Settings > Profile**: your name and company (used in templates as `{{my_name}}` / `{{my_company}}`).
2. **Settings > Email Accounts > Add Account**:
   - **Sign in with Microsoft** (Microsoft 365 / work Outlook, Outlook.com) or **Sign in with Google** (Gmail / Workspace):
     your normal login in the browser, no app password. Needs the one-time company setup below.
   - **Other email (password)**: company mail servers, Yahoo, iCloud, or Gmail/Outlook with an *app password*.
3. **Companies**: add your subs or **Import CSV** (columns like Company, Contact, Email, Phone, Trade, GL Expires,
   WC Expires, Bonding Limit, Union, Certifications, License, Prequalified).

## Daily workflow

- **Today** (sidebar): follow-ups due (invited, no answer in N days), trades short on prices, bids due this week, and
  addenda not yet sent to everyone. One click: **Called**, **Email**, **Will Bid**, **Not Bidding**. A morning
  notification summarizes it (set the time on the Today screen).
- **New Job**: bid due date/time, drawings + spec links, job folder. Start from the standard CSI trades or copy a past job.
- **Send Drawings**: one personalized email per company with the links; each is stamped **Drawings Sent** with the time.
- Per company: **Log Follow-Up** (called/emailed), **Enter Price**, and the status menu: **Will Bid** / **Not Bidding**.
  Trades with fewer than 3 prices in (or promised) show **Short**.
- **Addenda** tab: add Addendum 1, 2, 3... then **Send** it to every invited company in one go. Each company gets an
  "A2" badge: blue = sent, green = acknowledged, red outline = not sent. Mark acknowledgments from the reply email.
- **Bid Leveling** tab: base bid, inclusions/exclusions, a scope checklist per trade (Included / Excluded + plug
  amount), and bid alternates (checked ones count). The leveled total shows the true low bid.
- Quote files: **Save quote to company** on an email from a sub, or **Attach quote** on the company. Stored with the job and
  shared with the team.
- **Trade ... > Links, scope note & checklist**: a trade's own drawings/spec link (for split packages), a scope note
  for emails (`{{trade_scope}}`), and the leveling checklist.
- **Companies**: insurance expirations (warnings when expired or within 30 days), bonding, union, MBE/WBE/DBE...,
  license, prequalified, and "Bids back" (how often they actually send a price).
- **Bid Board**, **Activity** (with **Change history**: who changed what), print / save the bid status as PDF, export to Excel.

## Email

- Text size A-/A+, **Simple** view, pictures blocked until allowed, conversations (toggle **Conversations**).
- Select several: Ctrl/Cmd+click, Shift+click, Ctrl/Cmd+A or checkboxes, then read/unread, flag, archive, move, delete.
- **Snooze** (clock button): hides an email until later; it comes back unread with a notification.
- **Mail Rules** (Settings): e.g. move plan-room notices to a folder, mark read, flag mail from a GC, no notification.
  Create one from an email with **... > Create a rule**.
- **All Inboxes** (with two or more accounts), print / PDF, meeting invites (Add to Calendar, Accept/Maybe/Decline),
  offline reading of recent mail, desktop notifications.

## Team sharing (Settings > Team Sharing)

Jobs, trades, companies, statuses, quotes and templates are shared. Email accounts stay private to each person.

- **Host team data here**: this computer shares its data on the office network, encrypted (HTTPS) by default.
  Add a **login** for each teammate (Team logins). Teammates choose **Connect to a team server**, enter the address
  shown, confirm the certificate fingerprint matches, and sign in. Keep the host on with BidMail open.
- **Always-on server** (office server or a small cloud VM with Node.js 22.13+):
  ```
  npm run server:build
  node server/dist/bidmail-server.js --port 4780 --key SETUP-KEY --db ./bidmail-team.db --https --updates ./updates
  ```
  The first person to connect creates the admin account with the setup key; the admin then adds everyone else.
  Use `--tls-cert`/`--tls-key` for a real certificate (e.g. Let's Encrypt) instead of `--https`.
- Every change is logged with the person's name (**Change history**). Admins can reset passwords and deactivate
  logins (deactivating signs that person out immediately). Wrong passwords are slowed down after 10 tries.

## Automatic updates

Teammates update automatically from the team server. To publish a new version: on the hosting computer, **Settings >
About & Updates > Share a new version with your team**, enter the version and choose the new installer. For the
standalone server, copy `latest.yml` and `BidMail-Setup-x.y.z.exe` from `release/` into its `--updates` folder.
Each app downloads it in the background and shows **Version x ready - restart**. (Mac automatic updates need an
Apple Developer ID signature; until then Mac users install new versions from the .dmg.)

## Sign in with Microsoft / Google (one-time company setup)

Microsoft and Google only allow mail sign-in from apps your organization registers. Whoever manages your company's
Microsoft 365 or Google Workspace does this once; paste the IDs into **Settings > Email Accounts > Sign-in setup**
on each computer.

**Microsoft 365** (Azure portal, about 10 minutes):
1. portal.azure.com > **Microsoft Entra ID** > **App registrations** > **New registration**. Name: BidMail. Supported
   account types: *Accounts in any organizational directory and personal Microsoft accounts* (or just your org).
2. Redirect URI: platform **Public client/native (mobile & desktop)**, URI `http://localhost`. Register.
3. **Authentication**: set *Allow public client flows* to **Yes**. Save.
4. **API permissions** > Add > *APIs my organization uses* > **Office 365 Exchange Online** > Delegated >
   `IMAP.AccessAsUser.All` and `SMTP.Send`; also Microsoft Graph `offline_access`, `openid`, `email`, `profile`.
   Click **Grant admin consent**.
5. Copy the **Application (client) ID** (and your tenant ID if you only allowed your org).
6. In the Microsoft 365 admin center make sure IMAP and *Authenticated SMTP* are enabled for the mailboxes.

**Google Workspace / Gmail** (console.cloud.google.com):
1. Create a project, enable the **Gmail API**.
2. **OAuth consent screen**: User type *Internal* (Workspace) so no Google review is needed; add scope `https://mail.google.com/`.
3. **Credentials > Create credentials > OAuth client ID > Desktop app**. Copy the client ID and client secret.

## Building the Mac version

A Mac app can only be built on a Mac. Either:

- **On any Mac:** install Node.js 24, copy this folder (without `node_modules`, `out`, `release`), then in Terminal:
  `npm ci` then `npm run dist:mac`. The `.dmg` and `.zip` files (Apple Silicon and Intel) appear in `release/`.
- **Without a Mac:** put this folder in a GitHub repository, open **Actions > Build BidMail > Run workflow**. It builds
  the Mac and Windows installers in the cloud (`.github/workflows/build.yml`); download them from the run's **Artifacts**.

To remove the Mac first-launch warning, sign and notarize with an Apple Developer ID ($99/year): set `CSC_LINK`,
`CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, and in `package.json` `build.mac`
set `"identity"`, `"hardenedRuntime": true`, `"notarize": true`.

## Development

```
npm install
npm run dev        # run with hot reload
npm test           # 35 tests: data, team server (HTTPS, logins), Microsoft/Google sign-in, IMAP/SMTP mail,
                   #   snooze, rules, conversations, calendar (local test servers; nothing goes to the internet)
npm run test:ui    # launches the real app, clicks through every screen, saves tests/screens/*.png
npm run dist       # Windows installer + latest.yml into release/
```

Code layout: `src/shared` (bid database, team server, templates, calendar, rules; used by app and server),
`src/main` (Electron main process: mail engine, sign-in, snooze, rules, updates, printing), `src/renderer` (React UI),
`server` (standalone team server).

Data lives in `%APPDATA%\BidMail` on Windows and `~/Library/Application Support/BidMail` on Mac: `bidmail.db`,
`settings.json`, `accounts.json` (passwords / sign-in tokens encrypted by Windows DPAPI or the macOS Keychain),
`rules.json`, `snoozes.json`, and `mailcache/` (offline copies of recent mail).