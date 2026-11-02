import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Built-in sign-in registrations (src/shared/oauthBuiltIn.ts), baked in from the build environment. Always defined,
// even when empty, because the renderer has no `process` to read them from at run time.
const env = (k: string) => JSON.stringify(process.env[k] ?? '')
const signInIds = {
  'process.env.BIDMAIL_MS_CLIENT_ID': env('BIDMAIL_MS_CLIENT_ID'),
  'process.env.BIDMAIL_GOOGLE_CLIENT_ID': env('BIDMAIL_GOOGLE_CLIENT_ID')
}

export default defineConfig({
  main: {
    build: { externalizeDeps: true },
    // Google issues a "secret" even for desktop apps; it only lives in the main process, never in the screens.
    define: { ...signInIds, 'process.env.BIDMAIL_GOOGLE_CLIENT_SECRET': env('BIDMAIL_GOOGLE_CLIENT_SECRET') }
  },
  preload: {
    build: { externalizeDeps: true }
  },
  renderer: {
    plugins: [react()],
    define: signInIds
  }
})
