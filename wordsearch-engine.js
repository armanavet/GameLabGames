/* ============================================================================
   wordsearch-engine.js — grid building, word placement, hit testing. No DOM.

   HYBRID SOURCING. A Word Search can arrive two ways and the player cannot
   tell the difference once it is loaded:

     AUTHORED   an editor uploads a payload — a theme, a word list, and
                optionally the grid itself. This is the path that matters
                editorially: a themed puzzle with a byline.
     GENERATED  no authored puzzle exists for that date, so one is built from
                the date. The archive therefore never has a hole in it, and a
                day nobody filled still plays.

   Both go through `normalise`, which returns the same shape either way. An
   authored payload without a grid is laid out here, seeded by its id, so the
   editor only has to supply words.

   PLACEMENT IS BACKTRACKING, LONGEST FIRST. Long words have the fewest legal
   positions, so placing them while the grid is empty and short ones last is
   what makes a full board achievable. A word that cannot be placed anywhere
   is dropped rather than allowed to half-fit — a listed word that is not in
   the grid is the one bug a word search must never have.

   THE FILLER IS DRAWN FROM THE ANSWERS' OWN LETTERS. Uniform random letters
   make the answers stand out: real words are full of E, A, R, S and a grid of
   evenly-spread Q and Z reads as noise with words sitting on top of it. The
   filler is sampled from the same letter distribution as the words, so the
   answers blend into it.

   Grid is a flat Array(W*H), row-major: index = row * W + col.
   ========================================================================= */
(function (root) {
  'use strict';

  /* ---------- deterministic randomness (as the other engines) ---------- */
  function hashSeed(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), 1 | t);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const shuffled = (arr, rng) => {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  };

  /* ---------- geometry ----------
     Eight directions, because How To Play promises all eight: "words can run
     horizontally, vertically or diagonally and may go forward or backward". */
  const DIRS = [
    { dr: 0, dc: 1, name: 'E' }, { dr: 0, dc: -1, name: 'W' },
    { dr: 1, dc: 0, name: 'S' }, { dr: -1, dc: 0, name: 'N' },
    { dr: 1, dc: 1, name: 'SE' }, { dr: -1, dc: -1, name: 'NW' },
    { dr: 1, dc: -1, name: 'SW' }, { dr: -1, dc: 1, name: 'NE' },
  ];
  const W_DEFAULT = 15, H_DEFAULT = 15;

  /* A listed word keeps the text the reader sees and the letters that go in
     the grid — "Spear Phishing" is one entry and eleven cells. */
  function wordOf(raw) {
    const text = String(raw == null ? '' : (raw.text || raw)).trim();
    const letters = text.toUpperCase().replace(/[^A-Z]/g, '');
    return { text: text, letters: letters, len: letters.length };
  }

  /* ---------- placement ---------- */
  function fits(grid, W, H, letters, r, c, d) {
    const endR = r + d.dr * (letters.length - 1), endC = c + d.dc * (letters.length - 1);
    if (endR < 0 || endR >= H || endC < 0 || endC >= W) return false;
    let shared = 0;
    for (let i = 0; i < letters.length; i++) {
      const g = grid[(r + d.dr * i) * W + (c + d.dc * i)];
      if (g && g !== letters[i]) return false;
      if (g === letters[i]) shared++;
    }
    /* A word laid entirely on top of another is not hidden, it is a duplicate
       — only partial crossings are allowed. */
    return shared < letters.length;
  }

  function write(grid, W, letters, r, c, d) {
    for (let i = 0; i < letters.length; i++) grid[(r + d.dr * i) * W + (c + d.dc * i)] = letters[i];
  }
  function erase(grid, W, letters, r, c, d, before) {
    for (let i = 0; i < letters.length; i++) grid[(r + d.dr * i) * W + (c + d.dc * i)] = before[i];
  }

  /* Crossings are what make a grid feel woven rather than stacked, so a
     position that shares a letter with what is already down is preferred. */
  function placeAll(words, W, H, rng) {
    const grid = new Array(W * H).fill('');
    const order = words.slice().sort((a, b) => b.len - a.len || a.letters.localeCompare(b.letters));
    const placed = [];
    const slots = [];
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) slots.push([r, c]);

    const tryWord = (w) => {
      const cands = [];
      for (const [r, c] of shuffled(slots, rng)) {
        for (const d of shuffled(DIRS, rng)) {
          if (!fits(grid, W, H, w.letters, r, c, d)) continue;
          let shared = 0;
          for (let i = 0; i < w.len; i++) {
            if (grid[(r + d.dr * i) * W + (c + d.dc * i)] === w.letters[i]) shared++;
          }
          cands.push({ r: r, c: c, d: d, shared: shared });
          if (cands.length > 220) break;
        }
        if (cands.length > 220) break;
      }
      if (!cands.length) return false;
      cands.sort((a, b) => b.shared - a.shared);
      /* take one of the best few rather than always the very best, so the
         same word list does not always weave identically */
      const pick = cands[Math.floor(rng() * Math.min(4, cands.length))];
      const before = [];
      for (let i = 0; i < w.len; i++) before.push(grid[(pick.r + pick.d.dr * i) * W + (pick.c + pick.d.dc * i)]);
      write(grid, W, w.letters, pick.r, pick.c, pick.d);
      placed.push({ text: w.text, letters: w.letters, len: w.len,
                    row: pick.r, col: pick.c, dir: pick.d.name,
                    dr: pick.d.dr, dc: pick.d.dc, _before: before });
      return true;
    };

    const dropped = [];
    for (const w of order) {
      if (!w.len || w.len < 3 || w.len > Math.max(W, H)) { dropped.push(w.text); continue; }
      if (!tryWord(w)) dropped.push(w.text);
    }
    placed.forEach(p => { delete p._before; });
    return { grid: grid, placed: placed, dropped: dropped };
  }

  /* ---------- filler ---------- */
  function fillBlanks(grid, placed, rng) {
    let pool = placed.map(p => p.letters).join('');
    if (pool.length < 20) pool += 'ETAOINSHRDLUCMFWYPVBGKJQXZ';
    for (let i = 0; i < grid.length; i++) {
      if (!grid[i]) grid[i] = pool[Math.floor(rng() * pool.length)];
    }
    return grid;
  }

  /* ---------- themes for the generated fallback ----------
     Small and hand-kept: a generated puzzle is the safety net for a date
     nobody authored, so the themes only have to be decent, not encyclopaedic.
     The social-engineering set is the one the design was drawn with. */
  const THEMES = [
    { theme: 'Social engineering', words: ['Baiting', 'Catfishing', 'Deception', 'Impersonation',
      'Manipulation', 'Pretexting', 'Ransomware', 'Scareware', 'Spear Phishing', 'Spoofing',
      'Tailgating', 'Trojan Horse', 'Vishing'] },
    { theme: 'In the kitchen', words: ['Colander', 'Skillet', 'Whisk', 'Spatula', 'Saucepan',
      'Grater', 'Ladle', 'Kettle', 'Peeler', 'Mixer', 'Tongs', 'Sieve', 'Mortar'] },
    { theme: 'Weather', words: ['Blizzard', 'Drizzle', 'Monsoon', 'Overcast', 'Thunder',
      'Humidity', 'Sunshine', 'Tornado', 'Cyclone', 'Hailstone', 'Rainbow', 'Breeze', 'Frost'] },
    { theme: 'Instruments', words: ['Clarinet', 'Trombone', 'Cello', 'Timpani', 'Harpsichord',
      'Bassoon', 'Ukulele', 'Marimba', 'Trumpet', 'Violin', 'Oboe', 'Banjo', 'Piccolo'] },
    { theme: 'California', words: ['Yosemite', 'Redwood', 'Sequoia', 'Pasadena', 'Monterey',
      'Sacramento', 'Malibu', 'Sonoma', 'Mojave', 'Fresno', 'Oakland', 'Ventura', 'Tahoe'] },
    { theme: 'At the movies', words: ['Director', 'Screenplay', 'Matinee', 'Popcorn', 'Sequel',
      'Trailer', 'Casting', 'Montage', 'Closeup', 'Premiere', 'Studio', 'Credits', 'Cameo'] },
    { theme: 'Birds', words: ['Kestrel', 'Pelican', 'Starling', 'Flamingo', 'Cormorant',
      'Sandpiper', 'Warbler', 'Osprey', 'Heron', 'Finch', 'Grebe', 'Swallow', 'Condor'] },
    { theme: 'Cycling', words: ['Peloton', 'Handlebar', 'Derailleur', 'Cassette', 'Pannier',
      'Chainring', 'Spokes', 'Saddle', 'Helmet', 'Brakes', 'Tandem', 'Pedal', 'Gearing'] },
    { theme: 'Geology', words: ['Sediment', 'Basalt', 'Granite', 'Obsidian', 'Limestone',
      'Tectonic', 'Erosion', 'Fossil', 'Quartz', 'Magma', 'Strata', 'Caldera', 'Gypsum'] },
    { theme: 'Libraries', words: ['Catalogue', 'Archive', 'Reference', 'Periodical', 'Bindery',
      'Shelving', 'Lending', 'Reading', 'Atlas', 'Folio', 'Stacks', 'Index', 'Volume'] },
  ];

  /* ---------- the two sources ---------- */
  const ID_PREFIX = 'wordsearch-';
  const idFor = iso => ID_PREFIX + iso;
  const DATE_RE = /(\d{4}-\d{2}-\d{2})/;
  const dateFromId = id => { const m = DATE_RE.exec(String(id || '')); return m ? m[1] : ''; };
  const parseId = id => { const d = dateFromId(id); return d ? { date: d } : null; };
  function todayISO(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
           '-' + String(d.getDate()).padStart(2, '0');
  }

  /* Build a puzzle from words, laying out the grid if one was not supplied. */
  function build(opts) {
    const W = opts.W || W_DEFAULT, H = opts.H || H_DEFAULT;
    const words = (opts.words || []).map(wordOf).filter(w => w.len >= 3);
    const rng = mulberry32(hashSeed(opts.seed || 'lat-wordsearch'));

    /* An authored payload may ship its own grid AND its own placements. Trust
       them, but verify every word is really there — a listed word missing from
       the grid is unfindable, and silently shipping that is worse than
       re-laying the puzzle ourselves. */
    if (opts.grid && opts.grid.length === W * H && opts.placed && opts.placed.length) {
      const grid = opts.grid.map(ch => String(ch || '').toUpperCase());
      const ok = opts.placed.every(p => {
        const L = (p.letters || p.text || '').toUpperCase().replace(/[^A-Z]/g, '');
        const d = DIRS.find(x => x.name === p.dir) || { dr: p.dr, dc: p.dc };
        for (let i = 0; i < L.length; i++) {
          const r = p.row + d.dr * i, c = p.col + d.dc * i;
          if (r < 0 || r >= H || c < 0 || c >= W) return false;
          if (grid[r * W + c] !== L[i]) return false;
        }
        return true;
      });
      if (ok) {
        return { W: W, H: H, grid: grid, theme: opts.theme || '',
                 placed: opts.placed.map(p => normPlaced(p)), dropped: [] };
      }
    }

    const laid = placeAll(words, W, H, rng);
    fillBlanks(laid.grid, laid.placed, rng);
    return { W: W, H: H, grid: laid.grid, theme: opts.theme || '',
             placed: laid.placed, dropped: laid.dropped };
  }

  function normPlaced(p) {
    const L = (p.letters || p.text || '').toUpperCase().replace(/[^A-Z]/g, '');
    const d = DIRS.find(x => x.name === p.dir) || { dr: p.dr || 0, dc: p.dc || 0, name: p.dir || 'E' };
    return { text: p.text || L, letters: L, len: L.length,
             row: p.row, col: p.col, dir: d.name, dr: d.dr, dc: d.dc };
  }

  /* The generated fallback: theme chosen by the date, so a given day is the
     same puzzle for everybody and no request is needed to know it. */
  function forDate(iso) {
    const seed = 'lat-wordsearch:' + iso;
    /* Rotate the theme by day number rather than hashing the date: a hash
       collides, and two consecutive days on the same theme reads as a bug to
       anyone opening the archive. The hash still drives the layout, so the
       same theme a fortnight later is a different grid. */
    const day = Math.floor(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000);
    const pick = THEMES[((day % THEMES.length) + THEMES.length) % THEMES.length];
    const p = build({ seed: seed, theme: pick.theme, words: pick.words });
    p.id = idFor(iso); p.date = iso; p.source = 'generated';
    p.title = 'Word Search';
    return p;
  }

  /* An authored payload, normalised into exactly what forDate returns. */
  function fromPayload(o, meta) {
    o = o || {};
    const iso = (meta && meta.date) || o.date || '';
    const id = (meta && meta.id) || o.id || idFor(iso);
    const p = build({ seed: 'lat-wordsearch:authored:' + id, theme: o.theme || o.caption || '',
                      words: o.words || [], W: o.W, H: o.H, grid: o.grid, placed: o.placed });
    p.id = id; p.date = iso; p.source = 'authored';
    p.title = o.title || (meta && meta.title) || 'Word Search';
    p.author = o.author || (meta && meta.author) || '';
    p.editor = o.editor || (meta && meta.editor) || '';
    return p;
  }

  /* ---------- hit testing ----------
     A drag gives two cells. It only counts if they are the two ends of one
     listed word — in either direction, because words may run backward. */
  function lineCells(r0, c0, r1, c1) {
    const dr = Math.sign(r1 - r0), dc = Math.sign(c1 - c0);
    const dR = Math.abs(r1 - r0), dC = Math.abs(c1 - c0);
    /* straight or exactly diagonal only */
    if (dR && dC && dR !== dC) return null;
    const n = Math.max(dR, dC) + 1;
    const out = [];
    for (let i = 0; i < n; i++) out.push([r0 + dr * i, c0 + dc * i]);
    return out;
  }

  function wordAt(puz, r0, c0, r1, c1) {
    const cells = lineCells(r0, c0, r1, c1);
    if (!cells || cells.length < 3) return null;
    const last = cells[cells.length - 1];
    for (const p of puz.placed) {
      const endR = p.row + p.dr * (p.len - 1), endC = p.col + p.dc * (p.len - 1);
      const fwd = p.row === r0 && p.col === c0 && endR === last[0] && endC === last[1];
      const rev = p.row === last[0] && p.col === last[1] && endR === r0 && endC === c0;
      if ((fwd || rev) && p.len === cells.length) return p;
    }
    return null;
  }

  const cellsOf = p => {
    const out = [];
    for (let i = 0; i < p.len; i++) out.push([p.row + p.dr * i, p.col + p.dc * i]);
    return out;
  };

  root.WORDSEARCH = {
    DIRS: DIRS, THEMES: THEMES,
    build: build, forDate: forDate, fromPayload: fromPayload,
    wordAt: wordAt, lineCells: lineCells, cellsOf: cellsOf,
    idFor: idFor, parseId: parseId, dateFromId: dateFromId, todayISO: todayISO,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.WORDSEARCH;
