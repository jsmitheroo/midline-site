# Midline

The daily drive: a sideways answer game where the middle answer goes furthest.

Static site, no build step. Deployed on Cloudflare Workers (static assets) via `wrangler.jsonc`.

- `index.html` — the whole game
- `favicon.ico`, `favicon-32.png`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png` — icons
- `manifest.webmanifest` — add-to-home-screen support
- `og.png` — link preview image
- `.assetsignore` — keeps config files off the public site
