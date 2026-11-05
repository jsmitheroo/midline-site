# Midline

The daily drive: a sideways answer game where the middle answer goes furthest.

Deployed on Cloudflare Workers: static files in `public/`, a small API in `src/worker.js`.

## Layout
- `public/index.html` — the whole game (answer bank, packs, online party client)
- `public/sw.js` — offline cache (never caches `/api`)
- `src/worker.js` — API + two Durable Objects
  - `Stats` (one global, SQLite): daily scores, answer counts, misses, players, friends, live counts
  - `Room` (one per 4-letter code): online Grid Party over WebSockets
- `wrangler.jsonc` — config; Durable Objects are created automatically on deploy

## API
| route | what |
|---|---|
| `POST /api/score` | submit today's score, returns real distribution |
| `GET /api/day?d=&pid=` | distribution for a day |
| `POST /api/ping`, `GET /api/live` | drivers today, rooms live |
| `POST /api/answer` | log accepted answers / misses |
| `GET /api/pop` | answer counts used to re-rank popularity |
| `POST /api/me`, `/api/friends/add`, `/api/friends/remove`, `GET /api/friends` | friends |
| `POST /api/room/new`, `GET /api/room/CODE/ws` | online rooms |
| `GET /api/misses?key=ADMIN_KEY` | answers people tried that weren't accepted (set `ADMIN_KEY` as a secret) |

## Local
`npx wrangler dev` then open http://localhost:8787
