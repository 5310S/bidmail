import { contextBridge, ipcRenderer, webUtils } from 'electron'

const ALLOWED_EVENTS = ['bid:changed', 'bid:status', 'mail:new', 'mail:open', 'mail:accountStatus', 'bulk:progress', 'menu:compose', 'update:status', 'nav:go']

contextBridge.exposeInMainWorld('bidmail', {
  invoke: async (channel: string, ...args: unknown[]) => {
    const r = await ipcRenderer.invoke(channel, ...args)
    if (r && r.ok === false) throw new Error(r.error)
    return r?.result
  },
  on: (channel: string, cb: (payload: unknown) => void) => {
    if (!ALLOWED_EVENTS.includes(channel)) throw new Error('Event not allowed: ' + channel)
    const fn = (_e: unknown, payload: unknown) => cb(payload)
    ipcRenderer.on(channel, fn)
    return () => ipcRenderer.removeListener(channel, fn)
  },
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  platform: process.platform
})