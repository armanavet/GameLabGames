/* ============================================================================
   jigsaw-engine.js — cutting a photo into jigsaw pieces. No DOM.

   Built to play like the jigsaw LA Times readers already know: a fixed
   number of pieces per puzzle, the photo shown whole until the reader starts,
   then broken up and thrown across the whole table. There is no frame --
   pieces join each other, anywhere, and the puzzle is done when they are all
   one piece.

   AUTHORED, like the crosswords and Word Flower: an editor chooses the photo
   and owns the decision that it may be published, so each puzzle is a
   payload naming an image and its credit:

     {
       "id":     "jigsaw-2026-10-19",
       "title":  "Griffith Observatory",
       "date":   "2026-10-19",
       "image":  "puzzles/jigsaw/griffith-observatory.jpg",  same-site path or https URL
       "credit": "Photo: Carol M. Highsmith, Library of Congress",
       "source": "https://...",          optional: where the image and its rights came from
       "pieces": 30,                     optional: how many pieces; 30 if absent
       "background": "#c8d2de",          optional: the table colour; derived from the photo if absent
       "author": "", "editor": ""        optional, as in the other games
     }

   SAME CUT FOR EVERYONE. The knobs are drawn from a generator seeded by the
   puzzle id, so two readers -- or one reader on two devices -- get identical
   pieces, and a saved game always matches the pieces it is restored onto.

   A shared edge is ONE line. Each internal edge is computed once, as a run of
   points; the piece above traces it one way and the piece below traces it
   back, so neighbours can only ever fit each other exactly.
   ========================================================================= */
(function (root) {
  'use strict';

  const DEFAULT_PIECES = 30;

  /* ---------- deterministic randomness ---------- */
  function rng(seed) {
    let h = 2166136261 >>> 0;
    const s = String(seed);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return function () {
      h = (h + 0x6D2B79F5) >>> 0;
      let t = h;
      t = Math.imul(t ^ (t >>> 15), 1 | t);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* Columns x rows for a piece count. The count is honoured exactly when it
     can be -- 30 is 6 x 5 on a landscape photo -- choosing the split whose
     pieces are nearest square; only a count with no sensible split falls
     back to the nearest one that has. */
  function grid(target, aspect) {
    let best = null;
    for (let rows = 2; rows <= 20; rows++) {
      for (let cols = 2; cols <= 30; cols++) {
        const n = cols * rows;
        const squareness = Math.abs(Math.log((aspect / cols) / (1 / rows)));
        const miss = Math.abs(n - target) / target;
        const score = (miss ? 1 + miss * 4 : 0) + squareness;
        if (!best || score < best.score) best = { cols: cols, rows: rows, score: score };
      }
    }
    return { cols: best.cols, rows: best.rows };
  }

  /* ---------- one edge ----------
     The classic knob: three cubic curves out along the edge, into the neck,
     round the head and back. Points in edge space are (u along, v across),
     both as fractions of the edge's length; `flip` chooses which side the
     knob grows on, and small per-edge jitter keeps every knob a little
     different, as in a real cut. */
  const TAB = 0.1, JITTER = 0.035, STEPS = 10;
  function edgePoints(ax, ay, bx, by, flip, rand) {
    const j = () => (rand() * 2 - 1) * JITTER;
    const a = j(), b = j(), c = j(), d = j(), e = j();
    const t = TAB;
    const P = [
      [0, 0], [0.2, a], [0.5 + b + d, -t + c], [0.5 - t + b, t + c],
      [0.5 - 2 * t + b - d, 3 * t + c], [0.5 + 2 * t + b - d, 3 * t + c], [0.5 + t + b, t + c],
      [0.5 + b + d, -t + c], [0.8, e], [1, 0],
    ];
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
    const ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
    const at = (u, v) => [ax + dx * u + nx * v * L * flip, ay + dy * u + ny * v * L * flip];
    const out = [at(0, 0)];
    for (let k = 0; k < 3; k++) {
      const p0 = P[k * 3], p1 = P[k * 3 + 1], p2 = P[k * 3 + 2], p3 = P[k * 3 + 3];
      for (let s = 1; s <= STEPS; s++) {
        const q = s / STEPS, w = 1 - q;
        const u = w * w * w * p0[0] + 3 * w * w * q * p1[0] + 3 * w * q * q * p2[0] + q * q * q * p3[0];
        const v = w * w * w * p0[1] + 3 * w * w * q * p1[1] + 3 * w * q * q * p2[1] + q * q * q * p3[1];
        out.push(at(u, v));
      }
    }
    return out;
  }

  /* ---------- the cut ----------
     W x H is the finished picture in board units. Every piece's outline is
     returned in its own space, where its cell's top-left corner sits at
     (margin, margin) -- the margin being room for knobs that reach out. */
  function cut(cols, rows, W, H, seed) {
    const rand = rng('jigsaw:' + seed + ':' + cols + 'x' + rows);
    const cw = W / cols, ch = H / rows;
    const margin = 0.36 * Math.max(cw, ch);
    const flip = () => (rand() < 0.5 ? -1 : 1);
    const Hz = [], Vt = [];
    for (let r = 1; r < rows; r++) {
      Hz[r] = [];
      for (let c = 0; c < cols; c++)
        Hz[r][c] = edgePoints(c * cw, r * ch, (c + 1) * cw, r * ch, flip(), rand);
    }
    for (let c = 1; c < cols; c++) {
      Vt[c] = [];
      for (let r = 0; r < rows; r++)
        Vt[c][r] = edgePoints(c * cw, r * ch, c * cw, (r + 1) * ch, flip(), rand);
    }
    const pieces = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x0 = c * cw, y0 = r * ch, x1 = x0 + cw, y1 = y0 + ch;
      const rev = pts => pts.slice().reverse();
      const outline = []
        .concat(r === 0 ? [[x0, y0], [x1, y0]] : Hz[r][c])
        .concat(c === cols - 1 ? [[x1, y0], [x1, y1]] : Vt[c + 1][r])
        .concat(r === rows - 1 ? [[x1, y1], [x0, y1]] : rev(Hz[r + 1][c]))
        .concat(c === 0 ? [[x0, y1], [x0, y0]] : rev(Vt[c][r]));
      const ox = x0 - margin, oy = y0 - margin;
      pieces.push({
        id: r * cols + c, r: r, c: c,
        border: r === 0 || c === 0 || r === rows - 1 || c === cols - 1,
        outline: outline.map(p => [p[0] - ox, p[1] - oy]),
      });
    }
    return { cols: cols, rows: rows, cw: cw, ch: ch, margin: margin, W: W, H: H, pieces: pieces };
  }

  /* ---------- breaking it up ----------
     Every piece goes to a random spot anywhere on the table, as in the
     original -- overlaps and all; finding pieces is part of the game. A
     piece always lands wholly on the table, never half off its edge.
     `table` is the visible table in board units, {x, y, w, h}. Returns each
     piece's top-left corner (of its cell). */
  function scatter(cutInfo, table, seed) {
    const rand = rng('scatter:' + seed);
    const { cw, ch, margin, pieces } = cutInfo;
    const pad = margin * 0.55;
    const x0 = table.x + pad, x1 = table.x + table.w - cw - pad;
    const y0 = table.y + pad, y1 = table.y + table.h - ch - pad;
    return pieces.map(() => [
      x1 > x0 ? x0 + rand() * (x1 - x0) : table.x + (table.w - cw) / 2,
      y1 > y0 ? y0 + rand() * (y1 - y0) : table.y + (table.h - ch) / 2,
    ]);
  }

  /* ---------- the table colour ----------
     The original sets each puzzle on a table tinted opposite the photo --
     blue-grey under a desert, sand under a blue sky -- so the pieces stand
     out from it. Given the photo's average colour, this returns that tint:
     the opposite hue, quiet and light. */
  function tableColour(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    let h = 0, s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h /= 6;
    }
    h = (h + 0.5) % 1;
    s = Math.min(0.24, Math.max(0.1, s * 0.6));
    const L = 0.74;
    const q = L < 0.5 ? L * (1 + s) : L + s - L * s, p = 2 * L - q;
    const hue = t => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
    const hex = v => Math.round(v * 255).toString(16).padStart(2, '0');
    return '#' + hex(hue(h + 1 / 3)) + hex(hue(h)) + hex(hue(h - 1 / 3));
  }

  /* ---------- the editorial contract ---------- */
  function validate(o) {
    const errs = [];
    if (!o || typeof o !== 'object') return ['the puzzle is not a JSON object'];
    if (!o.title || !String(o.title).trim()) errs.push('missing "title"');
    const img = String(o.image || '').trim();
    if (!img) errs.push('missing "image"');
    else if (!/^(https:\/\/|[\w./-]+$)/.test(img) || !/\.(jpe?g|png|webp)(\?.*)?$/i.test(img))
      errs.push('"image" must be a .jpg, .png or .webp, as a same-site path or an https URL');
    /* a photo nobody has credited is a photo nobody has cleared */
    if (!o.credit || !String(o.credit).trim()) errs.push('missing "credit": every photo needs one');
    if (o.pieces != null && !(Number.isInteger(o.pieces) && o.pieces >= 6 && o.pieces <= 200))
      errs.push('"pieces" must be a whole number from 6 to 200');
    if (o.background != null && !/^#[0-9a-f]{6}$/i.test(String(o.background)))
      errs.push('"background" must be a colour like #c8d2de');
    return errs;
  }

  root.JIGSAW = {
    DEFAULT_PIECES: DEFAULT_PIECES, rng: rng, grid: grid, cut: cut, scatter: scatter,
    tableColour: tableColour, validate: validate,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.JIGSAW;
