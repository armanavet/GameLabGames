/* ============================================================================
   sudoku-engine.js — puzzle generation, solving and rating. No DOM.

   Kept out of the player page for two reasons: it is pure logic, so it can be
   exercised in node without a browser, and "Impossible Sudoku" is already on
   the roster and will want the same generator at a harder setting.

   Puzzles are DERIVED FROM THE DATE, not authored and uploaded. A date seeds a
   deterministic PRNG, so every reader opening 2026-08-31 gets byte-identical
   givens without a single request to a backend — the same static-first
   property the rest of the platform is built on, taken to its conclusion.
   There is nothing to publish, nothing to schedule and nothing to withhold:
   a future date is simply not offered by the archive.

   Grids are a flat Array(81), row-major, 0 for empty.
   ========================================================================= */
(function (root) {
  'use strict';

  /* ---------- deterministic randomness ----------
     Math.random would make today's puzzle different for every reader. The seed
     is a hash of the date string, so the sequence is fixed and reproducible in
     any engine — no reliance on host RNG behaviour. */
  function hashSeed(str) {
    let h = 2166136261 >>> 0;                       // FNV-1a
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
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
  const shuffled = (arr, rng) => {            // Fisher-Yates, rng-driven
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  };

  /* ---------- geometry ----------
     A shape is {N, bw, bh}: N cells per row and column, boxes bw wide by bh
     tall. 9x9 has 3x3 boxes; the 6x6 Mini has 3x2. Everything downstream reads
     the shape, so neither the solver nor the generator knows the number 9. */
  const shapeCache = {};
  function shape(bw, bh) {
    const key = bw + 'x' + bh;
    if (shapeCache[key]) return shapeCache[key];
    const N = bw * bh, cells = N * N, boxesPerRow = N / bw;
    const boxOf = new Int8Array(cells), rowOf = new Int8Array(cells), colOf = new Int8Array(cells);
    for (let i = 0; i < cells; i++) {
      const r = (i / N) | 0, c = i % N;
      rowOf[i] = r; colOf[i] = c;
      boxOf[i] = Math.floor(r / bh) * boxesPerRow + Math.floor(c / bw);
    }
    /* Peers: the cells that constrain each cell. Precomputed once per shape —
       the solver touches these on every placement. */
    const peers = [];
    for (let i = 0; i < cells; i++) {
      const set = [];
      for (let j = 0; j < cells; j++) {
        if (j === i) continue;
        if (rowOf[j] === rowOf[i] || colOf[j] === colOf[i] || boxOf[j] === boxOf[i]) set.push(j);
      }
      peers.push(set);
    }
    return (shapeCache[key] = { N: N, bw: bw, bh: bh, cells: cells,
                                rowOf: rowOf, colOf: colOf, boxOf: boxOf, peers: peers,
                                full: (1 << N) - 1 });
  }

  /* ---------- bitmask solver ----------
     Masks track which digits are still legal per row/col/box; MRV (fill the
     most constrained cell first) keeps the search from wandering. `cap` stops
     the count as soon as the answer stops mattering — uniqueness testing only
     ever needs to know "one, or more than one". */
  const BIT = n => 1 << (n - 1);
  const POPCOUNT = new Int8Array(512);
  for (let m = 0; m < 512; m++) POPCOUNT[m] = (m & 1) + POPCOUNT[m >> 1];

  function makeMasks(grid, S) {
    const rows = new Int16Array(S.N), cols = new Int16Array(S.N), boxes = new Int16Array(S.N);
    for (let i = 0; i < S.cells; i++) {
      const v = grid[i];
      if (!v) continue;
      const b = BIT(v);
      if ((rows[S.rowOf[i]] & b) || (cols[S.colOf[i]] & b) || (boxes[S.boxOf[i]] & b)) return null; // contradiction
      rows[S.rowOf[i]] |= b; cols[S.colOf[i]] |= b; boxes[S.boxOf[i]] |= b;
    }
    return { rows: rows, cols: cols, boxes: boxes };
  }

  function search(grid, m, cap, found, rng, S) {
    let best = -1, bestMask = 0, bestCount = S.N + 1;
    for (let i = 0; i < S.cells; i++) {
      if (grid[i]) continue;
      const legal = S.full & ~(m.rows[S.rowOf[i]] | m.cols[S.colOf[i]] | m.boxes[S.boxOf[i]]);
      const n = POPCOUNT[legal];
      if (n === 0) return found;                 // dead end
      if (n < bestCount) { best = i; bestMask = legal; bestCount = n; if (n === 1) break; }
    }
    if (best === -1) { found.count++; if (!found.grid) found.grid = grid.slice(); return found; }

    let digits = [];
    for (let d = 1; d <= S.N; d++) if (bestMask & BIT(d)) digits.push(d);
    if (rng) digits = shuffled(digits, rng);

    const r = S.rowOf[best], c = S.colOf[best], b = S.boxOf[best];
    for (const d of digits) {
      const bit = BIT(d);
      grid[best] = d; m.rows[r] |= bit; m.cols[c] |= bit; m.boxes[b] |= bit;
      search(grid, m, cap, found, rng, S);
      grid[best] = 0; m.rows[r] &= ~bit; m.cols[c] &= ~bit; m.boxes[b] &= ~bit;
      if (found.count >= cap) return found;
    }
    return found;
  }

  /* Number of solutions, counting no further than `cap`. */
  /* A bare grid gets the obvious shape for its length. */
  function shapeFor(grid) { return grid.length === 36 ? shape(3, 2) : shape(3, 3); }

  function countSolutions(grid, cap, S) {
    S = S || shapeFor(grid);
    const m = makeMasks(grid, S);
    if (!m) return 0;
    return search(grid.slice(), m, cap || 2, { count: 0, grid: null }, null, S).count;
  }

  /* The solution, or null if there is none. */
  function solve(grid, S) {
    S = S || shapeFor(grid);
    const m = makeMasks(grid, S);
    if (!m) return null;
    const f = search(grid.slice(), m, 1, { count: 0, grid: null }, null, S);
    return f.count ? f.grid : null;
  }

  function isValidComplete(grid, S) {
    if (grid.some(v => !v)) return false;
    return !!makeMasks(grid, S || shapeFor(grid));
  }

  /* ---------- generation ---------- */
  function fullGrid(rng, S) {
    const grid = new Array(S.cells).fill(0);
    const m = makeMasks(grid, S);
    return search(grid, m, 1, { count: 0, grid: null }, rng, S).grid;
  }

  /* Remove clues while the solution stays unique. Cells are visited in a
     shuffled order and a removal that would make the puzzle ambiguous is put
     straight back, so the result is always uniquely solvable by construction
     rather than by hope. No symmetry constraint: the Figma grids are not
     symmetric, and forcing it costs clues for nothing. */
  function dig(solution, rng, targetClues, S) {
    const grid = solution.slice();
    let clues = S.cells;
    for (const i of shuffled(Array.from({ length: S.cells }, (_, k) => k), rng)) {
      if (clues <= targetClues) break;
      const keep = grid[i];
      grid[i] = 0;
      if (countSolutions(grid, 2, S) === 1) clues--;
      else grid[i] = keep;
    }
    return { grid: grid, clues: clues };
  }

  /* One pass already yields a MINIMAL puzzle — every remaining clue is load
     bearing, because a cell that could not be removed then can never be
     removed later, when there is even less to constrain it. What one pass
     cannot do is hit a low target: that depends on the removal order and on
     the solution grid it started from. So try a few, and keep the sparsest.
     Without this, Impossible landed on more clues than Expert and was the
     easier puzzle of the two. */
  function digBest(solution, rng, targetClues, S, attempts) {
    let best = null;
    for (let a = 0; a < (attempts || 1); a++) {
      const got = dig(a ? fullGrid(rng, S) : solution, rng, targetClues, S);
      if (!best || got.clues < best.clues) best = got;
      if (best.clues <= targetClues) break;
    }
    return best;
  }

  /* Clue count is a coarse proxy for difficulty, so it is not the whole story
     — but rating by technique ladder is a separate piece of work and this is
     honest about being a target rather than a guarantee. */
  const DIFFICULTY = {
    /* Mini is a 6x6 with 3x2 boxes, matching latimes.com's own Mini level —
       a smaller board, not a 9x9 with more of it given away. */
    mini:   { clues: 18, bw: 3, bh: 2, label: 'Mini' },
    easy:   { clues: 38, bw: 3, bh: 3, label: 'Easy' },
    medium: { clues: 32, bw: 3, bh: 3, label: 'Medium' },
    hard:   { clues: 27, bw: 3, bh: 3, label: 'Hard' },
    expert: { clues: 23, bw: 3, bh: 3, label: 'Expert' },
    /* Impossible Sudoku: "same mechanics, same visuals", the difference is
       purely how hard the deductions are. Until the technique ladder lands,
       fewer clues is the only lever available — which is a weaker distinction
       than the design doc describes, not the real one. */
    impossible: { clues: 21, bw: 3, bh: 3, label: 'Impossible' },
  };
  const LEVELS = ['mini', 'easy', 'medium', 'hard', 'expert'];   // the chooser
  const isLevel = d => Object.prototype.hasOwnProperty.call(DIFFICULTY, d);
  /* `clues` is a floor to aim at, not a promise: digging stops early when no
     further cell can be removed without making the puzzle ambiguous. */

  /* ---------- the date is the puzzle ---------- */
  /* Difficulty is part of the id, not a separate parameter. Each level is its
     own archive with its own saved progress, so Easy and Expert on the same
     date must not collide in storage or in a URL. */
  const ID_RE = /^sudoku-([a-z]+)-(\d{4}-\d{2}-\d{2})$/;
  const idFor = (difficulty, iso) => 'sudoku-' + difficulty + '-' + iso;
  const parseId = id => {
    const m = ID_RE.exec(String(id || ''));
    if (!m || !isLevel(m[1])) return null;
    return { difficulty: m[1], date: m[2] };
  };
  const dateFromId = id => { const p = parseId(id); return p ? p.date : ''; };
  /* Local date, not UTC: a reader in Los Angeles should get the 30th all
     through the 30th, and toISOString() would roll them over early. */
  function todayISO(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
           '-' + String(d.getDate()).padStart(2, '0');
  }

  function forDate(iso, difficulty) {
    const d = isLevel(difficulty) ? difficulty : 'medium';
    const level = DIFFICULTY[d];
    /* the level is in the seed as well as the id, so Easy and Hard on one date
       are genuinely different puzzles rather than the same grid dug harder */
    const S = shape(level.bw, level.bh);
    const rng = mulberry32(hashSeed('lat-sudoku:' + iso + ':' + d));
    let solution = fullGrid(rng, S);
    const best = digBest(solution, rng, level.clues, S, 14);
    const givens = best.grid;
    /* the kept grid may come from a later attempt, so re-derive its solution */
    solution = solve(givens, S);
    return {
      id: idFor(d, iso),
      date: iso,
      difficulty: d,
      W: S.N, H: S.N, bw: S.bw, bh: S.bh, size: S.N + 'x' + S.N, cells: S.cells,
      givens: givens,
      solution: solution,
      clues: givens.reduce((n, v) => n + (v ? 1 : 0), 0),
    };
  }

  root.SUDOKU = {
    forDate: forDate, todayISO: todayISO,
    idFor: idFor, parseId: parseId, dateFromId: dateFromId,
    LEVELS: LEVELS, isLevel: isLevel, shape: shape,
    solve: solve, countSolutions: countSolutions, isValidComplete: isValidComplete,
    DIFFICULTY: DIFFICULTY,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.SUDOKU;
