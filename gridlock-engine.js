/* ============================================================================
   gridlock-engine.js — grid state, moves, marking, generation. No DOM.

   Gridlock is Wordle on a sliding grid. Thirty-five letters sit in a grid of
   five rows by seven columns. Every column slides up and down and every row
   slides side to side, both wrapping. The reading window is the
   middle row's inner five cells — arrange a word there and submit it, and it
   is marked exactly as Wordle marks a guess.

   Two things worth stating plainly, because they are what make it a game
   rather than a chore:

   THE ROWS ARE WHAT MAKE THE COLUMNS INTERESTING. A column on its own is a
   fixed set of five letters, so a letter it does not carry can never reach
   the window. Shifting a row moves letters BETWEEN columns, so "this column
   only has some of the letters" is a starting condition you work around, not
   a wall.

   THE ANSWER IS PLANTED, THEN SCRAMBLED. The target is seated in the window
   before anything else, so the letters needed to spell it are guaranteed to
   be on the board. Everything after that is a permutation, and permutations
   do not lose letters.

   Grid is a flat Array(35), row-major: index = row * COLS + col.
   ========================================================================= */
(function (root) {
  'use strict';

  /* Five letters, so seven columns: the word plus one spare at each end to
     slide letters through. Six guesses, as Wordle gives for five letters. */
  const ROWS = 5, COLS = 7, LEN = 5;
  const WIN_ROW = 2, WIN_COL = 1;          /* the reading window */
  const ATTEMPTS = 6;
  const CELLS = ROWS * COLS;
  const at = (r, c) => r * COLS + c;

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
  const pick = (arr, rng) => arr[Math.floor(rng() * arr.length)];

  /* ---------- moves ----------
     A move is [kind, index, dir]: 'c' slides a column, 'r' slides a row, and
     dir is +1 or -1. Both are cyclic, so both are their own inverse at the
     opposite sign — which is all undo needs to know. */
  function rotateCol(g, c, dir) {
    const col = [];
    for (let r = 0; r < ROWS; r++) col.push(g[at(r, c)]);
    for (let r = 0; r < ROWS; r++) {
      const src = ((r - dir) % ROWS + ROWS) % ROWS;
      g[at(r, c)] = col[src];
    }
    return g;
  }
  function shiftRow(g, r, dir) {
    const row = [];
    for (let c = 0; c < COLS; c++) row.push(g[at(r, c)]);
    for (let c = 0; c < COLS; c++) {
      const src = ((c - dir) % COLS + COLS) % COLS;
      g[at(r, c)] = row[src];
    }
    return g;
  }
  function applyMove(g, m) {
    return m[0] === 'c' ? rotateCol(g, m[1], m[2]) : shiftRow(g, m[1], m[2]);
  }
  const invert = m => [m[0], m[1], -m[2]];
  const play = (g, seq) => { seq.forEach(m => applyMove(g, m)); return g; };
  const clone = g => g.slice();

  const windowWord = g => {
    let s = '';
    for (let i = 0; i < LEN; i++) s += g[at(WIN_ROW, WIN_COL + i)];
    return s;
  };

  /* ---------- Wordle marking ----------
     Greens claimed before ambers, so a repeated letter scores honestly. */
  function mark(current, target) {
    const n = target.length;
    const out = new Array(n).fill('absent');
    const left = {};
    for (let i = 0; i < n; i++) {
      if (current[i] === target[i]) out[i] = 'exact';
      else left[target[i]] = (left[target[i]] || 0) + 1;
    }
    for (let i = 0; i < n; i++) {
      if (out[i] === 'exact') continue;
      if (left[current[i]] > 0) { out[i] = 'moved'; left[current[i]]--; }
    }
    return out;
  }

  /* The best each letter has scored so far, for the alphabet strip. */
  function letterStatus(guesses, target) {
    const rank = { absent: 1, moved: 2, exact: 3 };
    const out = {};
    guesses.forEach(gw => {
      const m = mark(gw, target);
      for (let i = 0; i < gw.length; i++) {
        const ch = gw[i];
        if (!out[ch] || rank[m[i]] > rank[out[ch]]) out[ch] = m[i];
      }
    });
    return out;
  }

  /* ---------- words ----------
     Plain, high-frequency five-letter words: the puzzle is the mechanism and
     the deduction, so the vocabulary should never be the obstacle. The same
     list serves as targets and as the check on what may be submitted. */
  const WORDS = (
    'ABOUT ABOVE ACTOR ADMIT ADULT AFTER AGAIN AGENT AGREE AHEAD ALARM ALBUM ALIVE ALLOW ALONE ALONG ANGEL ANGER ANGLE ' +
    'APART APPLE APPLY ARENA ARGUE ARISE ASIDE ASSET AUDIO AVOID AWARD AWARE BADLY BAKER BASIC BEACH BEGAN BEGIN BEING ' +
    'BELOW BENCH BIRTH BLACK BLADE BLAME BLANK BLAST BLEND BLIND BLOCK BLOOD BOARD BONUS BOOST BOOTH BOUND BRAIN BRAND ' +
    'BRAVE BREAD BREAK BRICK BRIEF BRING BROAD BROWN BRUSH BUILD BUILT BUNCH BURST CABIN CABLE CANDY CARGO CARRY CATCH ' +
    'CAUSE CHAIN CHAIR CHALK CHARM CHART CHASE CHEAP CHECK CHEST CHIEF CHILD CHOSE CIVIL CLAIM CLASS CLEAN CLEAR CLERK ' +
    'CLICK CLIMB CLOCK CLOSE CLOTH CLOUD COACH COAST COUNT COURT COVER CRAFT CRASH CRAZY CREAM CRIME CROSS CROWD CROWN ' +
    'CURVE CYCLE DAILY DANCE DEATH DELAY DEPTH DOING DOUBT DOZEN DRAFT DRAMA DRANK DREAM DRESS DRIED DRINK DRIVE DROVE ' +
    'DYING EAGER EARLY EARTH EIGHT ELITE EMPTY ENEMY ENJOY ENTER ENTRY EQUAL ERROR EVENT EVERY EXACT EXIST EXTRA FAITH ' +
    'FALSE FAULT FENCE FEVER FIELD FIFTH FIFTY FIGHT FINAL FIRST FLAME FLASH FLEET FLOAT FLOOR FLOUR FLUID FOCUS FORCE ' +
    'FORTH FORTY FORUM FOUND FRAME FRANK FRESH FRONT FRUIT FULLY FUNNY GIANT GIVEN GLASS GLOBE GLORY GRACE GRADE GRAIN ' +
    'GRAND GRANT GRASS GRAVE GREAT GREEN GREET GROSS GROUP GROWN GUARD GUESS GUEST GUIDE HABIT HAPPY HARSH HEART HEAVY ' +
    'HENCE HORSE HOTEL HOUSE HUMAN HUMOR IDEAL IMAGE IMPLY INDEX INNER INPUT ISSUE IVORY JOINT JUDGE KNIFE KNOCK KNOWN ' +
    'LABEL LARGE LASER LATER LAUGH LAYER LEARN LEASE LEAST LEAVE LEGAL LEMON LEVEL LIGHT LIMIT LOCAL LOGIC LOOSE LOWER ' +
    'LOYAL LUCKY LUNCH LYING MAGIC MAJOR MAKER MARCH MATCH MAYBE MAYOR MEANT MEDAL MEDIA MERCY MERIT METAL METER MIGHT ' +
    'MINOR MINUS MIXED MODEL MONEY MONTH MORAL MOTOR MOUNT MOUSE MOUTH MOVIE MUSIC NAKED NERVE NEVER NEWLY NIGHT NOBLE ' +
    'NOISE NORTH NOVEL NURSE OCCUR OCEAN OFFER OFTEN ORDER OTHER OUGHT OUTER OWNER PAINT PANEL PAPER PARTY PEACE PEARL ' +
    'PHASE PHONE PHOTO PIANO PIECE PILOT PITCH PLACE PLAIN PLANE PLANT PLATE POINT POUND POWER PRESS PRICE PRIDE PRIME ' +
    'PRINT PRIOR PRIZE PROOF PROUD PROVE QUEEN QUICK QUIET QUITE RADIO RAISE RANGE RAPID RATIO REACH READY REALM REBEL ' +
    'REFER RELAX REPLY RIGHT RIVAL RIVER ROBIN ROMAN ROUGH ROUND ROUTE ROYAL RURAL SALAD SCALE SCENE SCOPE SCORE SENSE ' +
    'SERVE SEVEN SHADE SHAKE SHALL SHAPE SHARE SHARP SHEEP SHEET SHELF SHELL SHIFT SHINE SHIRT SHOCK SHOOT SHORE SHORT ' +
    'SHOWN SIGHT SILLY SINCE SIXTH SIXTY SKILL SLEEP SLIDE SMALL SMART SMILE SMOKE SNAKE SOLAR SOLID SOLVE SORRY SOUND ' +
    'SOUTH SPACE SPARE SPEAK SPEED SPELL SPEND SPENT SPINE SPLIT SPOKE SPORT STAFF STAGE STAKE STAND START STATE STEAM ' +
    'STEEL STEEP STEER STICK STILL STOCK STONE STOOD STORE STORM STORY STRIP STUCK STUDY STUFF STYLE SUGAR SUITE SUPER ' +
    'SWEET TABLE TASTE TEACH TEETH TERMS THANK THEFT THEIR THEME THERE THESE THICK THING THINK THIRD THOSE THREE THREW ' +
    'THROW TIGER TIGHT TIMER TIRED TITLE TODAY TOKEN TOTAL TOUCH TOUGH TOWEL TOWER TRACK TRADE TRAIL TRAIN TREAT TREND ' +
    'TRIAL TRIBE TRICK TRIED TRUCK TRULY TRUST TRUTH TWICE TWIST UNCLE UNDER UNION UNITE UNITY UNTIL UPPER UPSET URBAN ' +
    'USAGE USUAL VALID VALUE VIDEO VIRUS VISIT VITAL VOICE WASTE WATCH WATER WHEEL WHERE WHICH WHILE WHITE WHOLE WHOSE ' +
    'WOMAN WOMEN WORLD WORRY WORSE WORST WORTH WOULD WRITE WRONG WROTE YIELD YOUNG YOURS YOUTH'
  ).split(' ');
  /* ---------- what counts as a word ----------
     Answers come from WORDS above; what you may SUBMIT comes from the far
     wider dictionary in words-5.js. Built on first use so load order does not
     matter, and it falls back to the answer list if that file never arrived —
     a stricter game is survivable, a broken one is not. */
  let GUESS_SET = null;
  function guessSet() {
    if (GUESS_SET) return GUESS_SET;
    GUESS_SET = Object.create(null);
    const packed = root.WORDS5;
    if (typeof packed === 'string' && packed.length >= LEN) {
      for (let i = 0; i + LEN <= packed.length; i += LEN) GUESS_SET[packed.substr(i, LEN)] = 1;
    }
    /* answers must always be submittable, whatever the dictionary says */
    WORDS.forEach(w => { GUESS_SET[w] = 1; });
    return GUESS_SET;
  }
  const isWord = w => !!guessSet()[String(w || '').toUpperCase()];

  /* Frequency-weighted filler, plus spare copies of the answer's own letters.
     The echo is the quiet difficulty dial: it means many more arrangements
     are reachable, so composing a guess is work rather than a dead end. */
  const BAG = 'EEEEAAAARRRIIIOOOTTTNNNSSSLLLCCUUDDPPMMHHGGBBFFYYWWKVXZJQ';

  /* ---------- scramble ----------
     No move immediately undone, and no two slides of the same line in a row —
     otherwise the stated depth is a lie about how mixed the board is. */
  function scramble(rng, n) {
    const out = [];
    let lastKey = '';
    while (out.length < n) {
      const kind = rng() < 0.5 ? 'c' : 'r';
      const idx = Math.floor(rng() * (kind === 'c' ? COLS : ROWS));
      const dir = rng() < 0.5 ? 1 : -1;
      const key = kind + idx;
      if (key === lastKey) continue;
      lastKey = key;
      out.push([kind, idx, dir]);
    }
    return out;
  }

  const DEPTH = 10;

  function attempt(seed) {
    const rng = mulberry32(hashSeed(seed));
    const target = pick(WORDS, rng);

    const g = new Array(CELLS).fill('');
    for (let i = 0; i < LEN; i++) g[at(WIN_ROW, WIN_COL + i)] = target[i];
    const bag = target.repeat(2) + BAG;
    for (let i = 0; i < CELLS; i++) if (!g[i]) g[i] = pick(bag, rng);

    const seq = scramble(rng, DEPTH);
    const start = play(clone(g), seq);
    /* a board that already reads the answer is not a puzzle */
    if (windowWord(start) === target) return null;
    return { target: target, start: start, solution: seq.slice().reverse().map(invert) };
  }

  /* ---------- the date is the puzzle ---------- */
  const ID_RE = /^gridlock-(\d{4}-\d{2}-\d{2})$/;
  const idFor = iso => 'gridlock-' + iso;
  const parseId = id => { const m = ID_RE.exec(String(id || '')); return m ? { date: m[1] } : null; };
  function todayISO(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
           '-' + String(d.getDate()).padStart(2, '0');
  }
  function forDate(iso) {
    for (let a = 0; a < 40; a++) {
      const p = attempt('lat-gridlock:' + iso + '#' + a);
      if (p) { p.id = idFor(iso); p.date = iso; return p; }
    }
    return null;
  }

  root.GRIDLOCK = {
    ROWS: ROWS, COLS: COLS, LEN: LEN, WIN_ROW: WIN_ROW, WIN_COL: WIN_COL,
    ATTEMPTS: ATTEMPTS, CELLS: CELLS, at: at,
    rotateCol: rotateCol, shiftRow: shiftRow, applyMove: applyMove,
    invert: invert, play: play, clone: clone,
    windowWord: windowWord, mark: mark, letterStatus: letterStatus,
    isWord: isWord, WORDS: WORDS,
    forDate: forDate, todayISO: todayISO, idFor: idFor, parseId: parseId,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.GRIDLOCK;
