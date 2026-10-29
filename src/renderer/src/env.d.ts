/// <reference types="vite/client" />

interface Window {
  bidmail: {
    invoke: (channel: string, ...args: unknown[]) => Promise<any>
    on: (channel: string, cb: (payload: any) => void) => () => void
    pathForFile: (file: File) => string
    platform: string
  }
}