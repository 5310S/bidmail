// Reads the cells of an Excel workbook (.xlsx) without extra dependencies: an .xlsx is a zip of XML files.
import { inflateRawSync } from 'node:zlib'

export interface XlsxSheet {
  name: string
  rows: string[][]
}

function unzip(buf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>()
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error("This isn't an Excel workbook (.xlsx)")
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break
    const method = buf.readUInt16LE(p + 10)
    const size = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const data = buf.subarray(start, start + size)
    if (method === 0) files.set(name, data)
    else if (method === 8) files.set(name, inflateRawSync(data))
    p += 46 + nameLen + extraLen + commentLen
  }
  return files
}

const decode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')

const texts = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1])).join('')
const colIndex = (ref: string) => {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A'
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

/** Every sheet's cells as text, row by row (empty cells are ''). */
export function readXlsx(buf: Buffer): XlsxSheet[] {
  const files = unzip(buf)
  const get = (p: string) => files.get(p)?.toString('utf8') ?? ''
  const shared = [...get('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]))
  const rels = new Map([...get('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)].map((m) => [
    /Id="([^"]+)"/.exec(m[0])?.[1] ?? '',
    (/Target="([^"]+)"/.exec(m[0])?.[1] ?? '').replace(/^\/?xl\//, '')
  ]))
  const sheets: XlsxSheet[] = []
  for (const m of get('xl/workbook.xml').matchAll(/<sheet\b[^>]*>/g)) {
    const name = decode(/name="([^"]*)"/.exec(m[0])?.[1] ?? 'Sheet')
    const rid = /r:id="([^"]+)"/.exec(m[0])?.[1] ?? ''
    const xml = get('xl/' + (rels.get(rid) ?? ''))
    if (!xml) continue
    const rows: string[][] = []
    for (const r of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const rowNum = Number(/\br="(\d+)"/.exec(r[1])?.[1] ?? rows.length + 1)
      const cells: string[] = []
      for (const c of (r[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = /\br="([A-Z]+)\d*"/.exec(c[1])?.[1] ?? ''
        const type = /\bt="([^"]+)"/.exec(c[1])?.[1] ?? ''
        const body = c[2] ?? ''
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]
        let val = ''
        if (type === 's') val = shared[Number(v)] ?? ''
        else if (type === 'inlineStr') val = texts(body)
        else if (v !== undefined) val = decode(v)
        cells[ref ? colIndex(ref) : cells.length] = val
      }
      rows[rowNum - 1] = Array.from(cells, (x) => x ?? '')
    }
    sheets.push({ name, rows: Array.from(rows, (x) => x ?? []) })
  }
  return sheets
}