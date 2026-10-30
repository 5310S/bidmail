// Builds small .xlsx files for tests (a zip of the minimum XML Excel needs), plus a vendor list shaped like the
// estimator's: a title row, the header on row 3, combined categories, MBE/WBE/Union types.
import { deflateRawSync } from 'node:zlib'

function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, 'utf8')
    const data = deflateRawSync(raw)
    const n = Buffer.from(name, 'utf8')
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8)
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(n.length, 26)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10)
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42)
    locals.push(lh, n, data)
    central.push(ch, n)
    offset += 30 + n.length + data.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10)
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const col = (i: number) => (i >= 26 ? String.fromCharCode(64 + Math.floor(i / 26)) : '') + String.fromCharCode(65 + (i % 26))

/** An .xlsx with one sheet; text goes in shared strings (as Excel writes it), numbers as numbers. */
export function makeXlsx(rows: (string | number)[][], sheetName = 'Sheet1'): Buffer {
  const strings: string[] = []
  const sheetRows = rows
    .map((r, i) => {
      const cells = r
        .map((v, j) => {
          const ref = `${col(j)}${i + 1}`
          if (v === '') return ''
          if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`
          strings.push(v)
          return `<c r="${ref}" t="s"><v>${strings.length - 1}</v></c>`
        })
        .join('')
      return `<row r="${i + 1}">${cells}</row>`
    })
    .join('')
  return zip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'xl/workbook.xml': `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml': `<sst>${strings.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`,
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${sheetRows}</sheetData></worksheet>`
  })
}

export const VENDOR_ROWS: (string | number)[][] = [
  ['Riverside MOB', '', 'MWBE'],
  [],
  ['Category', 'Company Name', 'Full Name', 'Business Phone', 'Email', 'Type', 'Apprentice', 'Date Sent', 'Quoting', 'Date Rec.'],
  ['Concrete', 'Island Concrete', '', 6319811234, 'estimating@islandconcrete.com', 'MBE/DBE', '', 46259],
  ['Concrete/Excavation', 'Anchormen', 'Dennis', '(631) 242-1102', ' dennis@anchormenllc.com', 'Union', 'Yes', 46259],
  ['Contrete/Masonry', 'Cornerstone Restoration ', 'Matt Riaz', 8456341353, 'cornerstonecontracting@aol.com', '', '', 46259],
  ['Epoxy/Polished Concrete', 'Tri-State Concrete Polishing', 'Jennifer Illiano', 6464668660, 'jennifer@tristatecp.net'],
  ['Doors', 'Arch Mills', 'Josh Coulter', 9739842724, 'jc@archmills.com', 'WBE'],
  ['Electrical', 'ABC Electric', 'Mike Jones', '512-555-0142', 'mike@abc-electric.com'],
  ['Electrical', 'Bright Line Electric', 'Tom Bright', '', 'tom@brightline.com'],
  ['Drywall', 'Ortiz Drywall', 'Ray Ortiz', '512-555-0177', 'ray@ortizdrywall.com'],
  ['Painting', 'No Contact Painting', '', '', ''],
  []
]