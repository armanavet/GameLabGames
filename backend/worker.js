/* ============================================================================
   worker.js — the demo archive backend.

   A single Cloudflare Worker + one KV namespace. No build step, no framework,
   no dependencies. Runs on the free tier and is reachable from the GitHub Pages
   build, which is static and cannot host this itself.

   Why a real endpoint rather than committed JSON files: scheduling is meant to
   HIDE a puzzle until its date. A dumb file host serves whatever is on disk, so
   tomorrow's answers would be one URL guess away. Filtering has to happen where
   the request is answered.

   ── Public (no auth, CORS open) ──────────────────────────────────────────────
   GET  /api/index?game=crossword     index of PUBLISHED puzzles only
   GET  /api/puzzle/<id>?game=…       one payload; 404 until it is published

   ── Admin (X-Admin-Token, compared trimmed) ────────────────────────────────────────────────────
   GET    /api/admin/list?game=…      everything, including scheduled + drafts
   POST   /api/admin/upload           { game, publishAt?, puzzle:{…} }
   PATCH  /api/admin/<id>             { publishAt?, title?, author?, editor?, status? }
   DELETE /api/admin/<id>

   KV layout
     idx:<game>      JSON array of entry metadata
     p:<game>:<id>   the puzzle payload, as authored. The game belongs in the
                     key because ids are only unique within a game — once ids
                     are dates, two games both publishing 2026-08-18 would
                     otherwise overwrite each other's payload.
   ========================================================================= */

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function cors(env) {
  return {
    'access-control-allow-origin': env.ALLOW_ORIGIN || '*',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,x-admin-token',
    'access-control-max-age': '86400',
  };
}
const json = (env, body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status, headers: { ...JSON_HEADERS, ...cors(env), 'cache-control': 'no-store' },
  });
const err = (env, status, message) => json(env, { error: message }, status);

/* Ids are unique per game, not globally, so the game is part of the key. */
const payloadKey = (game, id) => `p:${game}:${id}`;

const slug = s => (String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'puzzle');
const nowISO = () => new Date().toISOString();

/* A puzzle is published when publishAt has passed and it is not a draft. */
function isLive(entry, at) {
  if (entry.status === 'draft') return false;
  if (!entry.publishAt) return true;
  return entry.publishAt <= at;
}

/* Same checks as puzzle-tool.py — reject a broken grid at upload time rather
   than discovering it when a reader opens it. */
function validateCrossword(o) {
  const errs = [];
  const W = o && o.W, H = o && o.H;
  if (!W || !H) return ['missing W/H'];
  if (!Array.isArray(o.grid) || o.grid.length !== H || o.grid.some(r => !Array.isArray(r) || r.length !== W))
    errs.push(`grid is not ${W}x${H}`);
  if (!Array.isArray(o.num) || o.num.length !== H) errs.push(`num is not ${W}x${H}`);
  for (const [d, key] of [['A', 'across'], ['D', 'down']]) {
    for (const s of (o[key] || [])) {
      const tag = d + s.num;
      if (!s.answer || s.answer.length !== s.len) { errs.push(`${tag} answer/len mismatch`); continue; }
      for (let i = 0; i < s.len; i++) {
        const r = d === 'A' ? s.row : s.row + i;
        const c = d === 'A' ? s.col + i : s.col;
        if (r < 0 || r >= H || c < 0 || c >= W) { errs.push(`${tag} runs off the grid`); break; }
        const g = o.grid[r][c];
        if (g === null) { errs.push(`${tag} crosses a block`); break; }
        if (String(g).toUpperCase() !== String(s.answer[i]).toUpperCase()) {
          errs.push(`${tag} letter ${i + 1} does not match the grid`); break;
        }
      }
    }
  }
  return errs;
}

/* One validator per game. A game without one refuses uploads rather than
   accepting anything, so a half-built engine cannot quietly fill KV with
   payloads that no player can read — and the refusal names the game, which is
   the reminder to write the validator alongside the engine.

   midi and mini are crosswords: same payload schema, smaller grid. They share
   the crossword validator rather than getting a stub. */
/* A Word Search payload is a word list, not a grid: the player's engine lays
   the letters out, seeded by the puzzle id, so every reader gets the same
   board. Only the things an editor can get wrong are checked here. */
function validateWordSearch(o) {
  const W = (o && o.W) || 15, H = (o && o.H) || 15, errs = [];
  if (!Array.isArray(o.words) || !o.words.length) return ['missing "words"'];
  if (W < 5 || H < 5 || W > 30 || H > 30) errs.push('W/H must be between 5 and 30');
  const seen = {};
  o.words.forEach((raw, i) => {
    const text = String((raw && raw.text) || raw || '').trim();
    const letters = text.toUpperCase().replace(/[^A-Z]/g, '');
    const tag = 'word ' + (i + 1) + ' (' + (text || 'blank') + ')';
    if (!text) { errs.push(tag + ' is empty'); return; }
    if (letters.length < 3) errs.push(tag + ' has fewer than 3 letters');
    /* a word longer than the grid can never be placed, so it would be listed
       and unfindable — the one fault a word search must not ship */
    if (letters.length > Math.max(W, H)) errs.push(tag + ' is longer than the grid');
    if (seen[letters]) errs.push(tag + ' duplicates ' + seen[letters]);
    else seen[letters] = text;
  });
  if (o.grid && (!Array.isArray(o.grid) || o.grid.length !== W * H))
    errs.push('grid is not ' + W + 'x' + H);
  if (o.grid && (!Array.isArray(o.placed) || !o.placed.length))
    errs.push('grid supplied without placements');
  return errs;
}

const VALIDATORS = {
  crossword: validateCrossword,
  midi: validateCrossword,
  mini: validateCrossword,
  wordsearch: validateWordSearch,
};

const whiteCells = o => o.grid.reduce((n, row) => n + row.filter(c => c !== null).length, 0);

/* What an index row says about a puzzle is per game too. A crossword measures
   itself in white cells and reads its size off W/H; a word search has no grid
   in the payload at all, and asking whiteCells for one threw — which surfaced
   as a 500 rather than anything an editor could act on. Kept beside the
   validators so adding a game touches one place, not two. */
const crosswordSummary = o => ({ size: `${o.W}x${o.H}`, cells: whiteCells(o) });
const SUMMARY = {
  crossword: crosswordSummary,
  midi: crosswordSummary,
  mini: crosswordSummary,
  wordsearch: o => {
    const W = o.W || 15, H = o.H || 15;
    return { size: `${W}x${H}`, cells: W * H, words: (o.words || []).length };
  },
};

const readIndex = async (env, game) => JSON.parse((await env.PUZZLES.get(`idx:${game}`)) || '[]');
const writeIndex = (env, game, list) => {
  list.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  return env.PUZZLES.put(`idx:${game}`, JSON.stringify(list));
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');
    const game = url.searchParams.get('game') || 'crossword';
    const at = nowISO();

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });

    /* Two very different faults otherwise wear the same 401: no secret bound on
       the server, and a wrong token from the client. Say which one it is, or
       every misconfiguration looks like a typo. Both sides are trimmed because
       a newline pasted into the dashboard secret field is invisible. */
    const adminError = () => {
      const secret = String(env.ADMIN_TOKEN || '').trim();
      if (!secret) return [500, 'no ADMIN_TOKEN bound on the Worker — add it under Settings → Variables and Secrets'];
      const token = String(request.headers.get('x-admin-token') || '').trim();
      if (!token) return [401, 'missing X-Admin-Token header'];
      if (token !== secret) return [401, 'X-Admin-Token does not match ADMIN_TOKEN'];
      return null;
    };

    try {
      /* ---------- public ---------- */
      if (path === '/api/index' && request.method === 'GET') {
        const live = (await readIndex(env, game)).filter(e => isLive(e, at));
        // shaped exactly like the static puzzles.json so the client needs no special case
        return json(env, {
          schema: 2,
          source: 'api',
          default: live.length ? live[live.length - 1].id : '',
          /* the game has to ride along: /api/puzzle resolves the id against one
             game's index, and without it every non-crossword payload 404s */
          index: live.map(e => ({
            ...e,
            payloadUrl: `${url.origin}/api/puzzle/${encodeURIComponent(e.id)}?game=${encodeURIComponent(game)}`,
          })),
        });
      }

      if (path.startsWith('/api/puzzle/') && request.method === 'GET') {
        const id = decodeURIComponent(path.slice('/api/puzzle/'.length));
        const entry = (await readIndex(env, game)).find(e => e.id === id);
        // 404 rather than 403: an unpublished puzzle should not confirm it exists
        if (!entry || !isLive(entry, at)) return err(env, 404, 'not found');
        const body = await env.PUZZLES.get(payloadKey(game, id));
        if (!body) return err(env, 404, 'not found');
        return new Response(body, {
          headers: { ...JSON_HEADERS, ...cors(env), 'cache-control': 'public, max-age=300' },
        });
      }

      /* ---------- admin ---------- */
      if (path.startsWith('/api/admin')) {
        const authFail = adminError();
        if (authFail) return err(env, authFail[0], authFail[1]);

        if (path === '/api/admin/list' && request.method === 'GET') {
          const list = await readIndex(env, game);
          return json(env, { now: at, index: list.map(e => ({ ...e, live: isLive(e, at) })) });
        }

        if (path === '/api/admin/upload' && request.method === 'POST') {
          const body = await request.json();
          const puzzle = body.puzzle;
          if (!puzzle) return err(env, 400, 'missing "puzzle"');

          const g = body.game || game;
          const check = VALIDATORS[g];
          if (!check) return err(env, 422, `no validator for "${g}" yet — uploads for it are refused until one exists`);
          const problems = check(puzzle);
          if (problems.length) return json(env, { error: 'invalid puzzle', problems }, 422);

          const id = slug(body.id || puzzle.id || puzzle.title || `${g}-${(body.publishAt || at).slice(0, 10)}`);
          await env.PUZZLES.put(payloadKey(g, id), JSON.stringify(puzzle));

          const list = await readIndex(env, g);
          const entry = {
            id,
            title: puzzle.title || id,
            date: (body.publishAt || puzzle.date || at).slice(0, 10),
            publishAt: body.publishAt || at,
            ...((SUMMARY[g] || (() => ({})))(puzzle)),
            author: body.author || puzzle.author || '',
            editor: body.editor || puzzle.editor || '',
            status: body.status || 'published',
          };
          const i = list.findIndex(e => e.id === id);
          if (i >= 0) list[i] = { ...list[i], ...entry }; else list.push(entry);
          await writeIndex(env, g, list);
          return json(env, { ok: true, replaced: i >= 0, entry: { ...entry, live: isLive(entry, at) } });
        }

        const idMatch = path.match(/^\/api\/admin\/([^/]+)$/);
        if (idMatch && idMatch[1] !== 'list' && idMatch[1] !== 'upload') {
          const id = decodeURIComponent(idMatch[1]);
          const list = await readIndex(env, game);
          const i = list.findIndex(e => e.id === id);
          if (i < 0) return err(env, 404, 'not found');

          if (request.method === 'PATCH') {
            const patch = await request.json();
            for (const k of ['publishAt', 'title', 'author', 'editor', 'status']) {
              if (patch[k] !== undefined) list[i][k] = patch[k];
            }
            if (patch.publishAt) list[i].date = String(patch.publishAt).slice(0, 10);
            await writeIndex(env, game, list);
            return json(env, { ok: true, entry: { ...list[i], live: isLive(list[i], at) } });
          }
          if (request.method === 'DELETE') {
            list.splice(i, 1);
            await writeIndex(env, game, list);
            await env.PUZZLES.delete(payloadKey(game, id));
            return json(env, { ok: true, deleted: id });
          }
        }
      }

      /* ---------- health ---------- */
      if (path === '/api/health') {
        const list = await readIndex(env, game);
        return json(env, {
          ok: true, now: at, game,
          total: list.length,
          live: list.filter(e => isLive(e, at)).length,
          scheduled: list.filter(e => !isLive(e, at)).length,
        });
      }

      return err(env, 404, 'no such route');
    } catch (e) {
      return err(env, 500, String(e && e.message || e));
    }
  },
};
