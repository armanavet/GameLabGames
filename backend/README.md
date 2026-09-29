# Demo archive backend

Upload puzzle JSON, set when it goes live, have the archive fetch it. One
Cloudflare Worker plus one KV namespace — free tier, no build step, no
dependencies.

**Why a real endpoint and not committed JSON files.** Scheduling is supposed to
*hide* a puzzle until its date. A file host serves whatever is on disk, so
tomorrow's answers would be one URL guess away. Filtering has to happen where
the request is answered. That is the only reason this exists — everything else
in the project stays static.

This copy is the source of truth. Edit it here, then paste it into the
Cloudflare dashboard (Workers & Pages → lat-puzzles → Edit code) and Deploy.

## Adding a game

Two maps near the top, both keyed by game id:

- `VALIDATORS` — what a valid payload looks like. A game that is not in the map
  **refuses uploads** with a 422 naming it, so a half-built engine cannot fill
  KV with payloads no player can read.
- `SUMMARY` — what the index row says about a puzzle. A crossword measures
  itself in white cells; a word search has no grid in its payload at all.
  Before this existed the upload handler assumed a crossword and threw a 500
  on anything else.

`midi` and `mini` share the crossword validator: same schema, smaller grid.

## KV layout

    idx:<game>      the entry list for that game
    p:<game>:<id>   one payload, as authored

The game is part of the payload key because ids are unique only within a game:
once ids are dates, two games both publishing 2026-08-18 would otherwise
overwrite each other.

## Honest limits

- **The admin token lives in a browser.** Anyone with it can write. Use a
  throwaway value. Production wants LAT SSO in front of an admin page.
- **No audit trail, no versioning, no rollback.** An upload with an existing id
  overwrites it.
- **KV is eventually consistent.** A change can take a few seconds to appear
  globally.
- **Payloads carry `max-age=300`**, so an unpublish can lag five minutes at the
  edge.

The production path stays static files on a CDN, published by writing to a
bucket. This Worker exists because scheduling needs a request-time decision.
