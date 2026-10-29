// Prints or saves as PDF an HTML document (already sanitized by the renderer) using a hidden,
// script-free window so nothing in an email can run.
import { app, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

async function loadHidden(html: string): Promise<{ win: BrowserWindow; cleanup: () => void }> {
  const dir = path.join(app.getPath('temp'), 'BidMail')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `print-${randomUUID().slice(0, 8)}.html`)
  fs.writeFileSync(file, html, 'utf8')
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1100,
    webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  await win.loadFile(file)
  // Give images a moment to decode before printing.
  await new Promise((r) => setTimeout(r, 300))
  return {
    win,
    cleanup: () => {
      if (!win.isDestroyed()) win.destroy()
      fs.rmSync(file, { force: true })
    }
  }
}

/** Opens the system print dialog for the document. */
export async function printHtml(html: string): Promise<boolean> {
  const { win, cleanup } = await loadHidden(html)
  return new Promise((resolve, reject) => {
    win.webContents.print({ silent: false, printBackground: true }, (ok, reason) => {
      cleanup()
      if (ok || reason === 'cancelled') resolve(ok)
      else reject(new Error('Printing failed: ' + reason))
    })
  })
}

/** Renders the document to PDF bytes (US Letter). */
export async function htmlToPdf(html: string): Promise<Buffer> {
  const { win, cleanup } = await loadHidden(html)
  try {
    return await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'Letter',
      margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 }
    })
  } finally {
    cleanup()
  }
}