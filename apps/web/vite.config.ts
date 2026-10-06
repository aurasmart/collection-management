import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { loadEnv, type Plugin } from 'vite'
import { defineConfig } from 'vitest/config'

/** Meta CSP (GitHub Pages cannot set response headers). Applied to production builds only. */
function cspPlugin(connectSrc: string[]): Plugin {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' ${connectSrc.join(' ')}`.trim(),
    `img-src 'self' data: blob: ${connectSrc.join(' ')}`.trim(),
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ')
  return {
    name: 'inject-csp',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace('<!--CSP-->', `<meta http-equiv="Content-Security-Policy" content="${csp}" />`),
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const origins = [env.VITE_API_URL, env.VITE_SUPABASE_URL]
    .filter((u): u is string => Boolean(u))
    .map((u) => new URL(u).origin)

  return {
    // '/' for a custom domain; '/<repo>/' for a project Pages site (set VITE_BASE_PATH in CI).
    base: env.VITE_BASE_PATH || '/',
    plugins: [
      react(),
      tailwindcss(),
      cspPlugin(origins),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon.svg'],
        manifest: {
          name: 'Collections',
          short_name: 'Collections',
          description: 'Collect what you are owed.',
          start_url: '.',
          scope: '.',
          display: 'standalone',
          theme_color: '#1D4ED8',
          background_color: '#F7F8FA',
          icons: [
            { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
            {
              src: 'icons/icon-maskable-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
        },
        // Precache static assets only. No runtime caching: API and payment data are never cached.
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
          runtimeCaching: [],
          cleanupOutdatedCaches: true,
        },
      }),
    ],
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    server: { port: 5173 },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      css: false,
      restoreMocks: true,
    },
  }
})
