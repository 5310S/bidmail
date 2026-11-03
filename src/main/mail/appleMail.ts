// Mac Mail as a mail connection (macOS only). For accounts BidMail cannot sign in to itself, such as a company's
// Microsoft 365 without an app registration, BidMail drives the Mail app with AppleScript: Mail does the signing in,
// BidMail reads folders, messages (full source) and flags through it, and hands outgoing mail to Mail to send.
// Message "UIDs" are Mail's own message ids. Every value reaches the scripts as an argument, never as script text.
import { execFile } from 'node:child_process'
import addressparser from 'nodemailer/lib/addressparser'
import { Address, MailFolder, MessageSummary } from '../../shared/ipc'

const US = '\x1f' // field separator in script output
const RS = '\x1e' // record separator

export interface AppleMailAccountInfo {
  name: string
  email: string
  fullName: string
  type: string
}

/** Exchange folders that hold no mail (or only Mail's own housekeeping). */
const HIDDEN = /^(outbox|conversation history|journal|tasks|notes|calendar|contacts|sync issues|rss feeds|scheduled)$/i

const SPECIAL: [RegExp, string][] = [
  [/^inbox$/i, '\\Inbox'],
  [/^drafts?$/i, '\\Drafts'],
  [/^sent( items| messages| mail)?$/i, '\\Sent'],
  [/^archive$/i, '\\Archive'],
  [/^(deleted( items| messages)?|trash|bin)$/i, '\\Trash'],
  [/^(junk( email| e-mail| mail)?|spam)$/i, '\\Junk']
]

// Shared AppleScript helpers: joining lists, and dates as local "y m d seconds" (turned into a Date in Node,
// which handles daylight saving per date; AppleScript's own date text depends on the Mac's language).
const HELPERS = `
on joinList(l, sep)
  set AppleScript's text item delimiters to sep
  set t to l as text
  set AppleScript's text item delimiters to ""
  return t
end joinList
on dateParts(d)
  if d is missing value then return ""
  return ((year of d) as text) & " " & (((month of d) as integer) as text) & " " & ((day of d) as text) & " " & ((time of d) as text)
end dateParts
on orBlank(v)
  if v is missing value then return ""
  return v as text
end orBlank
`

// Summaries of the messages in `ms` (a reference, so each property is one bulk request to Mail).
const SUMMARIES = `
on summaries(ms)
  set US to ASCII character 31
  set RS to ASCII character 30
  tell application "Mail"
    set ids to id of ms
    if (count of ids) is 0 then return ""
    set subs to subject of ms
    set senders to sender of ms
    set tos to address of to recipients of ms
    set ccs to address of cc recipients of ms
    set recvd to date received of ms
    set seens to read status of ms
    set flags to flagged status of ms
    set answered to was replied to of ms
    set sizes to message size of ms
    set mids to message id of ms
    set atts to name of mail attachments of ms
  end tell
  set out to {}
  repeat with i from 1 to count of ids
    set end of out to my joinList({item i of ids, my orBlank(item i of subs), my orBlank(item i of senders), my joinList(item i of tos, ","), my joinList(item i of ccs, ","), my dateParts(item i of recvd), item i of seens, item i of flags, item i of answered, item i of sizes, my orBlank(item i of mids), count of (item i of atts)}, US)
  end repeat
  return my joinList(out, RS)
end summaries
`

const SCRIPTS = {
  accounts: `
on run argv
  set US to ASCII character 31
  set RS to ASCII character 30
  set out to {}
  tell application "Mail"
    repeat with a in accounts
      if enabled of a then set end of out to my joinList({name of a, my joinList(email addresses of a, ","), (account type of a) as text, my orBlank(full name of a)}, US)
    end repeat
  end tell
  return my joinList(out, RS)
end run`,

  signatures: `
on run argv
  tell application "Mail" to set names to name of every signature
  return my joinList(names, ASCII character 30)
end run`,

  folders: `
on run argv
  tell application "Mail" to set boxes to mailboxes of account (item 1 of argv)
  return my joinList(my walk(boxes, ""), ASCII character 30)
end run
on walk(boxes, prefix)
  set out to {}
  tell application "Mail"
    repeat with mb in boxes
      set p to prefix & (name of mb)
      set end of out to my joinList({p, unread count of mb, count of messages of mb}, ASCII character 31)
      set kids to mailboxes of mb
      if (count of kids) > 0 then set out to out & my walk(kids, p & "/")
    end repeat
  end tell
  return out
end walk`,

  // Newest first: Mail lists message 1 as the most recent.
  range: `
on run argv
  set a to (item 3 of argv) as integer
  set b to (item 4 of argv) as integer
  tell application "Mail"
    set mb to mailbox (item 2 of argv) of account (item 1 of argv)
    set total to count of messages of mb
    if a > total then return (total as text) & (ASCII character 29)
    if b > total then set b to total
    set ms to a reference to (messages a thru b of mb)
  end tell
  return (total as text) & (ASCII character 29) & my summaries(ms)
end run`,

  search: `
on run argv
  set q to item 3 of argv
  tell application "Mail"
    set mb to mailbox (item 2 of argv) of account (item 1 of argv)
    set ms to a reference to (messages of mb whose subject contains q or sender contains q)
  end tell
  return my summaries(ms)
end run`,

  byIds: `
on run argv
  set out to {}
  tell application "Mail"
    set mb to mailbox (item 2 of argv) of account (item 1 of argv)
    repeat with i from 3 to count of argv
      set ms to a reference to (messages of mb whose id is ((item i of argv) as integer))
      set s to my summaries(ms)
      if s is not "" then set end of out to s
    end repeat
  end tell
  return my joinList(out, ASCII character 30)
end run`,

  source: `
on run argv
  tell application "Mail"
    set mb to mailbox (item 2 of argv) of account (item 1 of argv)
    set s to source of (first message of mb whose id is ((item 3 of argv) as integer))
  end tell
  return s
end run`,

  // argv: account, folder, "read"|"flagged", "true"|"false", ids...
  flags: `
on run argv
  set v to (item 4 of argv) is "true"
  tell application "Mail"
    set mb to mailbox (item 2 of argv) of account (item 1 of argv)
    repeat with i from 5 to count of argv
      set m to first message of mb whose id is ((item i of argv) as integer)
      if (item 3 of argv) is "read" then
        set read status of m to v
      else
        set flagged status of m to v
      end if
    end repeat
  end tell
  return "ok"
end run`,

  // argv: account, folder, destination folder ("" = delete), ids...
  move: `
on run argv
  tell application "Mail"
    set mb to mailbox (item 2 of argv) of account (item 1 of argv)
    repeat with i from 4 to count of argv
      set m to first message of mb whose id is ((item i of argv) as integer)
      if (item 3 of argv) is "" then
        delete m
      else
        move m to mailbox (item 3 of argv) of account (item 1 of argv)
      end if
    end repeat
  end tell
  return "ok"
end run`,

  findMessageId: `
on run argv
  tell application "Mail"
    set mb to mailbox (item 2 of argv) of account (item 1 of argv)
    set ids to id of (messages of mb whose message id is (item 3 of argv))
  end tell
  if (count of ids) is 0 then return ""
  return (item 1 of ids) as text
end run`,

  createFolder: `
on run argv
  tell application "Mail"
    tell account (item 1 of argv) to make new mailbox with properties {name:(item 2 of argv)}
  end tell
  return "ok"
end run`,

  // argv: sender, subject, body, to, cc, bcc (each "name US address" joined by RS), Mail signature name (or ""),
  // attachment paths...
  send: `
on run argv
  set US to ASCII character 31
  set RS to ASCII character 30
  tell application "Mail"
    set m to make new outgoing message with properties {sender:(item 1 of argv), subject:(item 2 of argv), content:(item 3 of argv), visible:false}
    try
      my addRecipients(m, item 4 of argv, "to")
      my addRecipients(m, item 5 of argv, "cc")
      my addRecipients(m, item 6 of argv, "bcc")
      if (item 7 of argv) is not "" then
        -- Mail's own signature, pictures and all; Mail turns the message into formatted mail to carry it.
        set message signature of m to signature (item 7 of argv)
        delay 1
      end if
      if (count of argv) > 7 then
        tell content of m
          repeat with i from 8 to count of argv
            make new attachment with properties {file name:(POSIX file (item i of argv)) as alias} at after last paragraph
          end repeat
        end tell
        delay 1 -- Mail drops attachments that are still being added when the message is sent
      end if
      send m
    on error errText number errNum
      -- Don't leave a half-built message behind (Mail would save it to Drafts).
      try
        close m saving no
      end try
      error errText number errNum
    end try
  end tell
  return "ok"
end run
on addRecipients(m, packed, kind)
  if packed is "" then return
  set AppleScript's text item delimiters to ASCII character 30
  set people to text items of packed
  set AppleScript's text item delimiters to ""
  repeat with p in people
    set AppleScript's text item delimiters to ASCII character 31
    set parts to text items of p
    set AppleScript's text item delimiters to ""
    tell application "Mail"
      -- Built inside the tell block so "address" means Mail's recipient property, not a plain record label.
      set props to {name:item 1 of parts, address:item 2 of parts}
      if kind is "to" then
        make new to recipient at end of to recipients of m with properties props
      else if kind is "cc" then
        make new cc recipient at end of cc recipients of m with properties props
      else
        make new bcc recipient at end of bcc recipients of m with properties props
      end if
    end tell
  end repeat
end addRecipients`
}

type ScriptName = keyof typeof SCRIPTS

let queue: Promise<unknown> = Promise.resolve()

/** Runs one script (one at a time: Mail answers requests in order anyway). */
function run(name: ScriptName, args: string[]): Promise<string> {
  return runScript(SCRIPTS[name], args)
}

function runScript(script: string, args: string[]): Promise<string> {
  const job = queue.then(
    () =>
      new Promise<string>((resolve, reject) => {
        const child = execFile('osascript', ['-', ...args], { maxBuffer: 200 * 1024 * 1024, timeout: 120000 }, (err, stdout, stderr) => {
          if (err) return reject(new Error(appleMailMessage(String(stderr || err.message))))
          resolve(stdout.replace(/\n$/, ''))
        })
        child.stdin?.end(HELPERS + SUMMARIES + script)
      })
  )
  queue = job.catch(() => {})
  return job
}

export function appleMailMessage(raw: string): string {
  if (/-1743|not authori[sz]ed to send apple events/i.test(raw))
    return 'BidMail is not allowed to control Mail. Open System Settings > Privacy & Security > Automation, and turn on "Mail" under BidMail.'
  if (/-1728|can.t get (mailbox|account)/i.test(raw)) return 'Mail could not find that account or folder. Check that the account is still set up in Mail.'
  if (/-1719|can.t get (message|first message)/i.test(raw)) return 'Message not found in Mail. It may have been moved or deleted.'
  if (/-600|isn.t running/i.test(raw)) return 'Mail is not running. Open the Mail app and try again.'
  return 'Mail: ' + raw.replace(/^\d+:\d+: execution error: /, '').replace(/\s*\(-?\d+\)\s*$/, '').trim()
}

function parseDate(parts: string): string {
  const [y, m, d, t] = parts.split(' ').map(Number)
  if (!y) return new Date().toISOString()
  return new Date(y, m - 1, d, 0, 0, t || 0).toISOString()
}

function addresses(list: string): Address[] {
  return list
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)
    .map((address) => ({ name: '', address }))
}

export function parseSummaries(out: string): MessageSummary[] {
  if (!out) return []
  return out.split(RS).map((rec) => {
    const f = rec.split(US)
    const sender = addressparser(f[2] ?? '')[0] as { name?: string; address?: string } | undefined
    const mid = f[10] ?? ''
    return {
      uid: Number(f[0]),
      subject: f[1] || '(no subject)',
      from: sender?.address ? [{ name: sender.name ?? '', address: sender.address }] : [],
      to: addresses(f[3] ?? ''),
      cc: addresses(f[4] ?? ''),
      date: parseDate(f[5] ?? ''),
      seen: f[6] === 'true',
      flagged: f[7] === 'true',
      answered: f[8] === 'true',
      draft: false,
      hasAttachments: Number(f[11]) > 0,
      size: Number(f[9]) || 0,
      messageId: mid ? `<${mid.replace(/^<|>$/g, '')}>` : '',
      inReplyTo: ''
    }
  })
}

const bareId = (messageId: string) => messageId.trim().replace(/^<|>$/g, '')

/** Real name of each account's inbox. BidMail calls every inbox "INBOX"; Mail's folder names are case-sensitive. */
const inboxNames = new Map<string, string>()

async function box(account: string, folder: string): Promise<string> {
  if (folder.toUpperCase() !== 'INBOX') return folder
  if (!inboxNames.has(account)) await appleMail.folders(account)
  return inboxNames.get(account) ?? 'Inbox'
}

/** Packs "Name <a@b>, c@d" for the send script. */
export function packRecipients(list: string): string {
  const people = addressparser(list || '', { flatten: true }) as { name?: string; address?: string }[]
  return people
    .filter((p) => p.address)
    .map((p) => `${p.name ?? ''}${US}${p.address}`)
    .join(RS)
}

export const appleMail = {
  available: () => process.platform === 'darwin',

  async accounts(): Promise<AppleMailAccountInfo[]> {
    const out = await run('accounts', [])
    if (!out) return []
    return out.split(RS).map((rec) => {
      const [name, emails, type, fullName] = rec.split(US)
      return { name, email: ((emails ?? '').split(',')[0] ?? '').toLowerCase(), fullName: fullName ?? '', type: type ?? '' }
    })
  },

  async folders(account: string): Promise<MailFolder[]> {
    const out = await run('folders', [account])
    const folders: MailFolder[] = out
      .split(RS)
      .filter(Boolean)
      .map((rec) => {
        const [real, unseen, total] = rec.split(US)
        const name = real.split('/').pop() ?? real
        const inbox = /^inbox$/i.test(real)
        if (inbox) inboxNames.set(account, real)
        const path = inbox ? 'INBOX' : real
        return {
          path,
          name: inbox ? 'Inbox' : name,
          specialUse: path.includes('/') ? '' : (SPECIAL.find(([re]) => re.test(name))?.[1] ?? ''),
          delimiter: '/',
          unseen: SPECIAL.find(([re]) => re.test(name))?.[1] === '\\Drafts' ? 0 : Number(unseen) || 0, // Mail counts every draft as unread
          total: Number(total) || 0,
          depth: path.split('/').length - 1
        }
      })
    return folders.filter((f) => !(f.depth === 0 && HIDDEN.test(f.name)))
  },

  /** Newest first; `offset` and `limit` count from the newest message. */
  async list(account: string, folder: string, offset: number, limit: number): Promise<{ total: number; messages: MessageSummary[] }> {
    const out = await run('range', [account, await box(account, folder), String(offset + 1), String(offset + limit)])
    const [total, rest] = out.split('\x1d')
    return { total: Number(total) || 0, messages: parseSummaries(rest ?? '') }
  },

  async search(account: string, folder: string, query: string): Promise<MessageSummary[]> {
    return parseSummaries(await run('search', [account, await box(account, folder), query]))
  },

  /**
   * Messages whose subject contains any of `subjects`, or whose people contain any of `people`: the sender for
   * received mail, any header (To, Cc) for sent mail. Mail answers these from its own index, so they are quick.
   * The terms reach the script as arguments; only the shape of the condition is written into it.
   */
  async find(account: string, folder: string, subjects: string[], people: string[], sent: boolean): Promise<MessageSummary[]> {
    const terms = [...subjects, ...people]
    if (!terms.length) return []
    const conds = terms.map((_, i) => `${i < subjects.length ? 'subject' : sent ? 'all headers' : 'sender'} contains (item ${i + 3} of argv)`)
    const script = `
on run argv
  tell application "Mail"
    set mb to mailbox (item 2 of argv) of account (item 1 of argv)
    set ms to a reference to (messages of mb whose ${conds.join(' or ')})
  end tell
  return my summaries(ms)
end run`
    return parseSummaries(await runScript(script, [account, await box(account, folder), ...terms]))
  },

  async summaries(account: string, folder: string, ids: number[]): Promise<MessageSummary[]> {
    if (!ids.length) return []
    return parseSummaries(await run('byIds', [account, await box(account, folder), ...ids.map(String)]))
  },

  async source(account: string, folder: string, id: number): Promise<Buffer> {
    return Buffer.from(await run('source', [account, await box(account, folder), String(id)]), 'utf8')
  },

  async setFlag(account: string, folder: string, ids: number[], flag: 'read' | 'flagged', value: boolean) {
    if (ids.length) await run('flags', [account, await box(account, folder), flag, String(value), ...ids.map(String)])
  },

  /** Moves messages; an empty destination deletes them (Mail puts them in the account's Trash). */
  async move(account: string, folder: string, ids: number[], dest: string) {
    if (ids.length) await run('move', [account, await box(account, folder), dest && (await box(account, dest)), ...ids.map(String)])
  },

  async findByMessageId(account: string, folder: string, messageId: string): Promise<number | null> {
    const out = await run('findMessageId', [account, await box(account, folder), bareId(messageId)])
    return out ? Number(out) : null
  },

  async createFolder(account: string, name: string) {
    await run('createFolder', [account, name])
  },

  /** The names of the signatures set up in Mail (Mail > Settings > Signatures). */
  async signatures(): Promise<string[]> {
    const out = await run('signatures', [])
    return out ? out.split(RS) : []
  },

  async send(o: { from: string; subject: string; text: string; to: string; cc: string; bcc: string; signature: string; files: string[] }) {
    await run('send', [o.from, o.subject, o.text, packRecipients(o.to), packRecipients(o.cc), packRecipients(o.bcc), o.signature, ...o.files])
  }
}
