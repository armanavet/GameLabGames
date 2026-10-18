/* ============================================================================
   wordflower-engine.js — Word Flower rules, scoring and payload checks. No DOM.

   Seven letters: six petals round one centre. A word counts when it is at
   least four letters long, uses only the flower's letters (any of them any
   number of times) and always uses the centre. Every accepted answer is
   listed in the puzzle itself -- the game never asks a dictionary whether a
   word is real, so what counts is an editor's decision, made once, in the
   payload.

   AUTHORED, NOT GENERATED. Generating a flower needs a full dictionary in the
   browser (megabytes) and a judgement about which words are fair, so puzzles
   are uploaded like the crosswords: backend first, the static manifest as
   the fallback.

   THE PAYLOAD (schema 1). Only what an editor decides goes in it; anything
   that can be worked out from it -- pangrams, the maximum score, the stage
   thresholds -- is computed here, so it can never disagree with the words.

     {
       "schema": 1,
       "id":     "wordflower-2026-10-19",   optional; the worker slugs one
       "title":  "Word Flower",              optional
       "date":   "2026-10-19",               optional; the upload sets it too
       "author": "...", "editor": "...",     optional
       "center": "A",                        one letter A-Z
       "petals": ["M","O","U","N","T","I"],  six letters, clockwise from the top,
                                             as the reader first sees them
       "words":  ["AMOUNT", "MOUNTAIN", ...] every accepted answer
     }

   validate() below is the editorial contract, and backend/worker.js carries
   a copy of it so a bad puzzle is refused at upload rather than discovered
   by a reader. Change one, change the other.
   ========================================================================= */
(function (root) {
  'use strict';

  const MIN_LEN = 4;
  const PANGRAM_BONUS = 5;
  /* The GDD aims for 23-60 words. The hard limits are wider so an editor can
     go a little either side; outside them a puzzle is refused. */
  const LIMITS = { minWords: 15, maxWords: 80 };

  /* The stages along the top. Newbie is reached by the first word -- the
     GDD's "first guessed word always starts the first stage" -- and the rest
     are shares of the puzzle's maximum score, so a flower with sixty words
     and one with twenty-five are equally hard to climb. Golden Poppy is
     every word found, which is also where the game ends. */
  const RANKS = [
    { name: 'Newbie',       at: 'first' },
    { name: 'Nice Start',   at: 0.15 },
    { name: 'Good',         at: 0.30 },
    { name: 'Great',        at: 0.50 },
    { name: 'Expert',       at: 0.75 },
    { name: 'Golden Poppy', at: 1 },
  ];

  /* What the reader is told when a word is refused, in the order the checks
     run: the cheapest and most useful complaint first. */
  const MESSAGES = {
    short:   'Words need at least ' + MIN_LEN + ' letters',
    center:  'The center letter is missing',
    found:   'You already found this word',
    unknown: 'Not in the word list',
  };

  const up = s => String(s == null ? '' : s).trim().toUpperCase();

  /* ---------- the editorial contract ---------- */
  function validate(raw) {
    const errs = [];
    if (!raw || typeof raw !== 'object') return ['the puzzle is not a JSON object'];
    const center = up(raw.center);
    const petals = Array.isArray(raw.petals) ? raw.petals.map(up) : null;
    if (!/^[A-Z]$/.test(center)) errs.push('"center" must be a single letter A-Z');
    if (!petals || petals.length !== 6) errs.push('"petals" must be a list of 6 letters');
    else {
      petals.forEach((p, i) => {
        if (!/^[A-Z]$/.test(p)) errs.push('petal ' + (i + 1) + ' must be a single letter A-Z');
      });
      if (new Set(petals.concat(center)).size !== 7)
        errs.push('the 7 letters (6 petals and the center) must all be different');
    }
    if (!Array.isArray(raw.words) || !raw.words.length) errs.push('missing "words"');
    /* every word check below needs a sound flower to check against */
    if (errs.length) return errs;

    const letters = new Set(petals.concat(center));
    const seen = new Set();
    let pangrams = 0;
    raw.words.forEach((w, i) => {
      const word = up(w);
      const tag = 'word ' + (i + 1) + ' (' + (word || 'blank') + ')';
      if (!/^[A-Z]+$/.test(word)) { errs.push(tag + ' must be letters A-Z only'); return; }
      if (word.length < MIN_LEN) errs.push(tag + ' is shorter than ' + MIN_LEN + ' letters');
      if (word.indexOf(center) < 0) errs.push(tag + ' does not use the center letter ' + center);
      const stray = [...new Set(word.split('').filter(c => !letters.has(c)))];
      if (stray.length) errs.push(tag + ' uses ' + stray.join(', ') + ', which is not in the flower');
      if (seen.has(word)) errs.push(tag + ' is listed twice');
      seen.add(word);
      if (!stray.length && new Set(word).size === 7) pangrams++;
    });
    if (!pangrams) errs.push('no pangram: at least one word must use all 7 letters');
    if (seen.size < LIMITS.minWords || seen.size > LIMITS.maxWords)
      errs.push('there are ' + seen.size + ' words; a flower needs ' +
                LIMITS.minWords + '-' + LIMITS.maxWords);
    return errs;
  }

  /* The payload as the player uses it: upper case, one copy of each word,
     alphabetical. Tolerant of case and stray spaces, so a hand-edited file
     that validate() accepts always loads the same way. */
  function normalize(raw) {
    const o = raw || {};
    const words = [...new Set((o.words || []).map(up).filter(Boolean))].sort();
    return {
      id: o.id || '', title: o.title || '', date: o.date || '',
      author: o.author || '', editor: o.editor || '',
      center: up(o.center), petals: (o.petals || []).map(up), words: words,
    };
  }

  /* ---------- scoring ---------- */
  const isPangram = (word, P) => {
    const s = new Set(word);
    return s.has(P.center) && P.petals.every(c => s.has(c));
  };
  /* four letters is 1 point and each letter after it one more; a pangram
     adds the bonus on top */
  const pointsFor = (word, P) => (word.length - 3) + (isPangram(word, P) ? PANGRAM_BONUS : 0);
  const maxScore = P => P.words.reduce((n, w) => n + pointsFor(w, P), 0);

  /* The score each stage starts at. Strictly rising, so no two stages can
     ever be reached by the same word, and the last is the maximum exactly. */
  function thresholds(P) {
    const max = maxScore(P);
    const t = RANKS.map(r => (r.at === 'first' ? 1 : Math.round(r.at * max)));
    for (let i = 1; i < t.length; i++) t[i] = Math.max(t[i], t[i - 1] + 1);
    t[t.length - 1] = Math.max(max, t[t.length - 2] + 1);
    return t;
  }
  /* the highest stage reached, or -1 before the first word */
  function rankIndex(score, t) {
    let k = -1;
    t.forEach((v, i) => { if (score >= v) k = i; });
    return k;
  }
  /* how far along the line from stage i to stage i+1 the score is, 0-1 */
  function legProgress(score, t, i) {
    const a = t[i], b = t[i + 1];
    if (score <= a) return 0;
    return Math.min(1, (score - a) / (b - a));
  }

  /* ---------- a guess ---------- */
  function check(P, entry, found) {
    const w = up(entry);
    if (w.length < MIN_LEN) return { ok: false, reason: 'short' };
    if (w.indexOf(P.center) < 0) return { ok: false, reason: 'center' };
    if (found && found.has(w)) return { ok: false, reason: 'found' };
    if (P.words.indexOf(w) < 0) return { ok: false, reason: 'unknown' };
    return { ok: true, word: w, points: pointsFor(w, P), pangram: isPangram(w, P) };
  }

  /* ---------- hints ----------
     A hint is a word still to find, shown as its first letter and its
     length. Each further reveal uncovers one more of its letters at a random
     position, until a single letter is left hidden -- the last one is
     always the reader's to get. */
  function pickHint(P, found, avoid, rng) {
    rng = rng || Math.random;
    let pool = P.words.filter(w => !found.has(w));
    if (pool.length > 1 && avoid) pool = pool.filter(w => w !== avoid);
    if (!pool.length) return null;
    const word = pool[Math.floor(rng() * pool.length)];
    return { word: word, shown: [0] };
  }
  const canRevealMore = h => !!h && h.word.length - h.shown.length > 1;
  function revealMore(h, rng) {
    if (!canRevealMore(h)) return h;
    rng = rng || Math.random;
    const hidden = [];
    for (let i = 0; i < h.word.length; i++) if (h.shown.indexOf(i) < 0) hidden.push(i);
    const pick = hidden[Math.floor(rng() * hidden.length)];
    return { word: h.word, shown: h.shown.concat(pick).sort((a, b) => a - b) };
  }
  const hintText = h => h.word.split('').map((c, i) => (h.shown.indexOf(i) >= 0 ? c : '_')).join(' ');

  root.WORDFLOWER = {
    MIN_LEN: MIN_LEN, PANGRAM_BONUS: PANGRAM_BONUS, LIMITS: LIMITS, RANKS: RANKS, MESSAGES: MESSAGES,
    validate: validate, normalize: normalize,
    isPangram: isPangram, pointsFor: pointsFor, maxScore: maxScore,
    thresholds: thresholds, rankIndex: rankIndex, legProgress: legProgress,
    check: check,
    pickHint: pickHint, canRevealMore: canRevealMore, revealMore: revealMore, hintText: hintText,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.WORDFLOWER;
