/* ============================================================================
   turnspell-engine.js — cube state, word planting, Wordle marking. No DOM.

   Turnspell is Wordle crossed with a Rubik's cube. Every sticker carries a
   letter. Several words are hidden in one cube; the player turns faces until a
   word lines up on the front face, and the only thing they are told is how
   close the letters currently sitting there are — green for the right letter
   in the right slot, amber for a letter that belongs to the word but not
   there. The word itself is never shown.

   Three things about the shape of this, all of which matter:

   ONE CUBE, MANY WORDS. Every word is planted into the same 54-letter cube,
   so choosing a different word to chase changes nothing about the cube — it
   only changes which slots are being judged. Words are planted shortest route
   first, each one filtered against the letters already committed, so they can
   share stickers.

   SLOTS ARE CORNERS, THEN CENTRE, THEN EDGES — the PATH below. Not reading
   order. A four-letter word sits on the four corners of the front face, a
   fifth letter goes in the middle, and only then do the edges fill in.

   PLANTED BACKWARDS. A word is placed by running a random route from the
   solved cube and writing the word onto whichever stickers land on the path.
   That route then spells the word when replayed from the start, so every word
   has a known solution of known length and no puzzle can be unsolvable.

   Geometry is modelled rather than tabulated: a sticker knows its cubie and
   its outward normal, so a face turn is a 90-degree integer rotation of both.
   The same vectors drive the CSS placement in the player, so the logic and
   the picture cannot disagree.
   ========================================================================= */
(function (root) {
  'use strict';

  /* ---------- deterministic randomness ---------- */
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

  /* ---------- the six faces ----------
     `up`/`right` are each face's own screen basis, which fixes slot order;
     `cw` turns a vector a quarter turn clockwise seen from outside the face.
     All derived in one right-handed world (Y up, Z toward the viewer). */
  const FACES = {
    U: { n: [0, 1, 0],  up: [0, 0, -1], right: [1, 0, 0],  cw: v => [-v[2], v[1], v[0]] },
    D: { n: [0, -1, 0], up: [0, 0, 1],  right: [1, 0, 0],  cw: v => [v[2], v[1], -v[0]] },
    R: { n: [1, 0, 0],  up: [0, 1, 0],  right: [0, 0, -1], cw: v => [v[0], v[2], -v[1]] },
    L: { n: [-1, 0, 0], up: [0, 1, 0],  right: [0, 0, 1],  cw: v => [v[0], -v[2], v[1]] },
    F: { n: [0, 0, 1],  up: [0, 1, 0],  right: [1, 0, 0],  cw: v => [v[1], -v[0], v[2]] },
    B: { n: [0, 0, -1], up: [0, 1, 0],  right: [-1, 0, 0], cw: v => [-v[1], v[0], v[2]] },
  };
  const FACE_IDS = ['U', 'D', 'L', 'R', 'F', 'B'];
  const MOVES = [];
  FACE_IDS.forEach(f => { MOVES.push(f); MOVES.push(f + "'"); });

  /* Corners, then the centre, then the edges. This is the order the numbers
     run in, and it is why a short word occupies the corners of the face. */
  const PATH = [0, 2, 6, 8, 4, 1, 3, 5, 7];

  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const axisOf = f => FACES[f].n.findIndex(c => c !== 0);
  const signOf = f => FACES[f].n[axisOf(f)];
  const cellOf = (f, p) => (1 - dot(p, FACES[f].up)) * 3 + (dot(p, FACES[f].right) + 1);
  const sameVec = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
  const faceOfNormal = n => FACE_IDS.find(f => sameVec(FACES[f].n, n));

  /* ---------- state ----------
     54 stickers. `id` is the sticker's identity and never changes, which is
     what lets letters be assigned to stickers during planting and what lets
     the player keep one DOM node per sticker. */
  function identity() {
    const out = [];
    FACE_IDS.forEach(f => {
      const F = FACES[f], a = axisOf(f), s = signOf(f);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        const p = [0, 0, 0];
        p[a] = s; p[(a + 1) % 3] = i; p[(a + 2) % 3] = j;
        out.push({ id: out.length, p: p, n: F.n.slice(), ch: '' });
      }
    });
    return out;
  }
  const clone = st => st.map(s => ({ id: s.id, p: s.p.slice(), n: s.n.slice(), ch: s.ch }));

  /* A turn rotates every sticker in the layer — the nine on the face and the
     twelve around its rim, which is exactly "p's component on this axis
     equals this face's sign". */
  function applyMove(state, move) {
    const f = move[0], prime = move.length > 1;
    const F = FACES[f], a = axisOf(f), s = signOf(f);
    const turn = prime ? v => F.cw(F.cw(F.cw(v))) : F.cw;
    for (const st of state) {
      if (st.p[a] !== s) continue;
      st.p = turn(st.p);
      st.n = turn(st.n);
    }
    return state;
  }
  const invert = m => (m.length > 1 ? m[0] : m + "'");
  const inverseOf = seq => seq.slice().reverse().map(invert);
  const play = (state, seq) => { seq.forEach(m => applyMove(state, m)); return state; };

  /* Which sticker is sitting in each of the front face's path slots. */
  function frontSlots(state, L) {
    const byCell = {};
    for (const st of state) if (st.n[2] === 1) byCell[cellOf('F', st.p)] = st;
    const out = [];
    for (let k = 0; k < L; k++) out.push(byCell[PATH[k]]);
    return out;
  }
  const frontWord = (state, L) => frontSlots(state, L).map(s => s ? s.ch : '').join('');

  /* ---------- Wordle marking ----------
     Greens are claimed before ambers so a repeated letter scores honestly:
     two Es in hand against one E in the word gives one mark, not two. */
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

  /* ---------- routes ---------- */
  function route(rng, n) {
    const out = [];
    let last = '';
    while (out.length < n) {
      const f = pick(FACE_IDS, rng);
      if (f === last) continue;
      last = f;
      out.push(f + (rng() < 0.5 ? '' : "'"));
    }
    return out;
  }
  const reduceSeq = seq => {
    const out = [];
    for (const m of seq) {
      if (out.length && out[out.length - 1] === invert(m)) out.pop();
      else out.push(m);
    }
    return out;
  };

  /* ---------- difficulty ----------
     Hidden words with short routes. `par` is the exact solution length for
     each word, and `echo` seeds the rest of the cube with spare copies of the
     letters the answers need — which quietly makes far more turns the right
     turn, and is the main dial that keeps this finishable. */
  const MODE = { lengths: [4, 5, 6], par: { 4: 4, 5: 5, 6: 6 }, echo: true };

  /* Plain, high-frequency words: the puzzle is spatial and deductive, so the
     vocabulary should never be the obstacle. */
  const WORDS = {
    4: ('ABLE AREA ARMY AWAY BABY BACK BALL BAND BANK BASE BEAR BEAT BELL BEST BIRD BLUE BOAT BODY BONE BOOK BORN CAKE CALL ' +
        'CALM CARD CARE CASE CASH CITY CLUB COAL COAT COLD COOK COOL COPY CORN DARK DATE DAWN DEAL DEEP DESK DISH DOOR DOWN ' +
        'DRAW DROP DUST EARN EAST EASY EDGE FACE FACT FAIR FALL FARM FAST FEAR FEED FEEL FILE FILM FIND FINE FIRE FISH FIVE ' +
        'FLAG FLAT FLOW FOOD FOOT FORM FOUR FREE FUEL FULL GAME GATE GIFT GIRL GIVE GOAL GOLD GOOD GRAY GROW HAIR HALF HALL ' +
        'HAND HARD HEAD HEAR HEAT HELP HERO HIDE HIGH HILL HOLD HOLE HOME HOPE HOUR IDEA IRON ITEM JOIN JUMP KEEP KIND KING ' +
        'KNEE KNOW LACK LAKE LAMP LAND LATE LEAD LEAF LEFT LIFE LIFT LIKE LINE LION LIST LIVE LOAD LOCK LONG LOOK LOSE LOUD ' +
        'LOVE LUCK MAIL MAIN MAKE MANY MARK MASK MEAL MEAN MEAT MEET MILD MILE MILK MIND MINE MISS MOON MORE MOST MOVE MUCH ' +
        'NAME NEAR NECK NEED NEST NEWS NEXT NICE NOTE OPEN PACK PAGE PAIN PAIR PARK PART PAST PATH PICK PINK PLAN PLAY PLUS ' +
        'POEM POOL POOR PORT POST PULL PURE PUSH RACE RAIN RATE READ REAL REST RICE RICH RIDE RING RISE RISK ROAD ROCK ROLE ' +
        'ROLL ROOF ROOM ROOT ROSE RULE RUSH SAFE SAIL SALT SAME SAND SAVE SEAT SEED SEEK SEEM SELL SEND SHIP SHOE SHOP SHOT ' +
        'SHOW SICK SIDE SIGN SILK SING SITE SIZE SKIN SLOW SNOW SOFT SOIL SOLD SONG SOON SORT SOUL SOUP SPOT STAR STAY STEP ' +
        'STOP SUCH SUIT SURE SWIM TAKE TALE TALK TALL TANK TAPE TASK TEAM TEAR TELL TEND TERM TEST TEXT THAN THAT THEM THEN ' +
        'THEY THIN THIS TIDE TIME TINY TIRE TONE TOOL TOUR TOWN TREE TRIP TRUE TUNE TURN TWIN TYPE UNIT UPON USED USER VAST ' +
        'VERY VIEW VOTE WAGE WAIT WAKE WALK WALL WANT WARM WASH WAVE WEAK WEAR WEEK WELL WEST WHAT WHEN WIDE WIFE WILD WILL ' +
        'WIND WINE WING WIRE WISE WISH WOOD WORD WORE WORK YARD YEAR ZERO ZONE').split(' '),
    5: ('ABOUT ABOVE ACTOR ADMIT ADULT AFTER AGAIN AGENT AGREE AHEAD ALARM ALBUM ALIVE ALLOW ALONE ALONG ANGEL ANGER ANGLE ' +
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
        'WOMAN WOMEN WORLD WORRY WORSE WORST WORTH WOULD WRITE WRONG WROTE YIELD YOUNG YOURS YOUTH').split(' '),
    6: ('ACCEPT ACCESS ACROSS ACTION ACTIVE ACTUAL ADVICE ADVISE AFFECT AFFORD AFRAID AGENCY AGENDA ALMOST ALWAYS AMOUNT ' +
        'ANIMAL ANNUAL ANSWER ANYONE ANYWAY APPEAL APPEAR AROUND ARRIVE ARTIST ASPECT ASSESS ASSIST ASSUME ATTACK ATTEND ' +
        'AUGUST AUTHOR AUTUMN AVENUE BANNER BARELY BARREL BASKET BATTLE BEAUTY BECAME BECOME BEFORE BEHALF BEHAVE BEHIND ' +
        'BELONG BESIDE BETTER BEYOND BISHOP BOTTLE BOTTOM BOUGHT BRANCH BREATH BRIDGE BRIGHT BROKEN BUDGET BUREAU BUTTON ' +
        'CAMERA CANCEL CANDLE CANNOT CANVAS CARBON CAREER CARPET CARROT CASTLE CASUAL CAUGHT CENTER CENTRE CHANCE CHANGE ' +
        'CHARGE CHOICE CHOOSE CHOSEN CHURCH CIRCLE CLIENT CLOSED CLOSER COFFEE COLLAR COLUMN COMBAT COMEDY COMING COMMON ' +
        'COPPER CORNER COTTON COUNTY COUPLE COURSE COUSIN CREATE CREDIT CRISIS CUSTOM DAMAGE DANGER DEALER DEBATE DECADE ' +
        'DECIDE DEFEAT DEFEND DEFINE DEGREE DELETE DEMAND DEPEND DEPUTY DESERT DESIGN DESIRE DETAIL DETECT DEVICE DIRECT ' +
        'DIVIDE DOCTOR DOLLAR DOMAIN DOUBLE DRIVEN DURING EASILY EASTER EDITOR EFFECT EFFORT EITHER ELEVEN EMPIRE EMPLOY ' +
        'ENABLE ENDING ENERGY ENGAGE ENGINE ENOUGH ENSURE ENTIRE ENTITY EQUITY ESCAPE ESTATE ETHNIC EXCEED EXCEPT EXCESS ' +
        'EXCUSE EXPAND EXPECT EXPERT EXPORT EXTEND EXTENT FABRIC FACING FACTOR FAILED FAIRLY FALLEN FAMILY FAMOUS FARMER ' +
        'FASTER FATHER FELLOW FEMALE FIGURE FILING FINGER FINISH FISCAL FLIGHT FLOWER FLYING FOLLOW FOREST FORGET FORMAL ' +
        'FORMAT FORMER FOSTER FOUGHT FOURTH FRENCH FRIDAY FRIEND FROZEN FUTURE GARDEN GATHER GENDER GENTLE GLOBAL GOLDEN ' +
        'GOVERN GROUND GROWTH GUILTY HANDLE HAPPEN HARDLY HEADED HEALTH HEIGHT HIDDEN HOLDER HONEST HORROR HUMBLE HUNGRY ' +
        'HUNTER IMPACT IMPORT INCOME INDEED INJURY INSIDE INTEND INTENT INVENT INVEST ISLAND ITSELF JOINED JUNIOR KEEPER ' +
        'KERNEL KIDNEY LADDER LATTER LAUNCH LAWYER LEADER LEAGUE LEAVES LEGACY LEGEND LENGTH LESSON LETTER LIGHTS LIKELY ' +
        'LINKED LIQUID LISTEN LITTLE LIVING LOCATE LOCKED LONGER LOOKED LOVELY LOVING LUXURY MAINLY MAKING MANAGE MANNER ' +
        'MANUAL MARBLE MARGIN MARINE MARKED MARKET MASTER MATTER MATURE MEDIUM MEMBER MEMORY MENTAL MERELY MERGER METHOD ' +
        'MIDDLE MILLER MINING MINUTE MIRROR MOBILE MODERN MODEST MODULE MOMENT MONDAY MONKEY MONTHS MOSTLY MOTHER MOTION ' +
        'MOVING MURDER MUSEUM MUTUAL MYSELF NARROW NATION NATIVE NATURE NEARBY NEARLY NEEDLE NEPHEW NERVES NEWEST NIGHTS ' +
        'NOBODY NORMAL NOTICE NOTION NUMBER OBJECT OBTAIN OFFICE OFFSET ONLINE OPPOSE OPTION ORANGE ORDERS ORIGIN OTHERS ' +
        'OUTPUT PALACE PARENT PARTLY PATENT PATROL PAYING PEOPLE PERIOD PERMIT PERSON PHRASE PICKED PIECES PLACES PLANET ' +
        'PLAYER PLEASE PLENTY POCKET POETRY POLICE POLICY PRAYER PREFER PRETTY PRINCE PRISON PROFIT PROPER PROVEN PUBLIC ' +
        'PURPLE PURSUE PUZZLE RABBIT RADIUS RAISED RANDOM RARELY RATHER RATING READER REALLY REASON RECALL RECENT RECORD ' +
        'REDUCE REFORM REGARD REGION REGRET REJECT RELATE RELIEF REMAIN REMOTE REMOVE REPAIR REPEAT REPORT RESCUE RESIST ' +
        'RESORT RESULT RETAIL RETAIN RETURN REVEAL REVIEW REWARD RIDING RISING ROBUST ROLLED RULING RUNNER SAFETY SALARY ' +
        'SAMPLE SAVING SAYING SCHEME SCHOOL SCREEN SEARCH SEASON SECOND SECRET SECTOR SECURE SEEING SELECT SELLER SENIOR ' +
        'SERIES SERVED SETTLE SEVERE SHADOW SHAPED SHARED SHIELD SHOULD SHOWED SHOWER SIGNAL SILENT SILVER SIMPLE SIMPLY ' +
        'SINGER SINGLE SISTER SLIGHT SMOOTH SOCIAL SOCKET SOFTLY SOLELY SOLVED SOURCE SPEAKS SPIRIT SPOKEN SPREAD SPRING ' +
        'SQUARE STABLE STATED STATIC STATUE STATUS STEADY STOLEN STRAIN STRAND STREAM STREET STRESS STRICT STRIKE STRING ' +
        'STRONG STRUCK STUDIO SUBMIT SUDDEN SUFFER SUMMER SUMMIT SUNDAY SUPPLY SURELY SURVEY SWITCH SYMBOL SYSTEM TAKING ' +
        'TALENT TARGET TAUGHT TEMPLE TENDER TENNIS THEORY THIRTY THOUGH THREAD THREAT THROWN TICKET TIMBER TIMELY TIMING ' +
        'TISSUE TITLED TOWARD TRAVEL TREATY TRENDS TRIBAL TRIPLE TROPHY TRYING TUNNEL TURNED TWELVE TWENTY UNABLE UNIQUE ' +
        'UNITED UNLESS UNLIKE UPDATE USEFUL VALLEY VARIED VENDOR VERSUS VESSEL VIABLE VICTIM VISION VISUAL VOLUME VOTING ' +
        'WAITED WALKED WALLET WANTED WARMTH WARNED WEALTH WEEKLY WEIGHT WHEELS WHOLLY WINDOW WINNER WINTER WISDOM WITHIN ' +
        'WONDER WOODEN WORKER WORTHY WRITER YELLOW').split(' '),
  };

  /* ---------- planting ----------
     Shortest route first, while the cube is still mostly blank, so the later
     and longer words have the most freedom. A word can only be planted if it
     agrees with every letter already committed to the stickers its route
     lands on — that filter is what lets several words share one cube. */
  function attempt(seed) {
    const rng = mulberry32(hashSeed(seed));
    const letters = new Array(54).fill(null);
    const goals = {};

    for (const L of MODE.lengths) {
      const pool = WORDS[L];
      let placed = false;
      for (let t = 0; t < 4000 && !placed; t++) {
        const seq = route(rng, MODE.par[L]);
        const st = play(identity(), seq);
        const ids = frontSlots(st, L).map(s => s.id);
        const cands = [];
        for (const w of pool) {
          let ok = true;
          for (let i = 0; i < L; i++) {
            const have = letters[ids[i]];
            if (have !== null && have !== w[i]) { ok = false; break; }
          }
          if (ok) cands.push(w);
        }
        if (!cands.length) continue;
        const w = pick(cands, rng);
        for (let i = 0; i < L; i++) letters[ids[i]] = w[i];
        goals[L] = { len: L, word: w, par: seq.length, route: seq };
        placed = true;
      }
      if (!placed) return null;
    }

    /* Spare copies of the letters the answers need mean far more turns are a
       useful turn. This is the difficulty dial the player never sees. */
    let bag = 'EEEAAARRRIIIOOOTTTNNNSSSLLLCCUUDDPPMMHHGGBBFFYYWWKVXZJQ';
    if (MODE.echo) bag = MODE.lengths.map(L => goals[L].word.repeat(3)).join('') + bag;
    for (let i = 0; i < 54; i++) if (letters[i] === null) letters[i] = pick(bag, rng);

    /* a word already standing at the start is not a puzzle */
    const start = identity();
    start.forEach(s => { s.ch = letters[s.id]; });
    for (const L of MODE.lengths) if (frontWord(start, L) === goals[L].word) return null;

    return { letters: letters, goals: goals, lengths: MODE.lengths.slice(), start: start };
  }

  /* ---------- hint ----------
     A short breadth-first search from wherever the player actually is; if the
     answer is further off than that, fall back to retracing their own moves
     and rejoining the planted route. */
  function nextMove(state, goal, history) {
    const key = st => st.map(s => s.id).join(',');
    let frontier = [[clone(state), []]];
    const seen = new Set([key(state)]);
    for (let d = 0; d < 3; d++) {
      const next = [];
      for (const [st, path] of frontier) {
        for (const m of MOVES) {
          const ns = applyMove(clone(st), m);
          const k = key(ns);
          if (seen.has(k)) continue;
          seen.add(k);
          const step = path.concat([m]);
          if (frontWord(ns, goal.len) === goal.word) return step[0];
          next.push([ns, step]);
        }
      }
      frontier = next;
    }
    const back = reduceSeq(history.slice().reverse().map(invert).concat(goal.route));
    return back[0] || '';
  }

  /* ---------- the date is the puzzle ---------- */
  const ID_RE = /^turnspell-(\d{4}-\d{2}-\d{2})$/;
  const idFor = iso => 'turnspell-' + iso;
  const parseId = id => { const m = ID_RE.exec(String(id || '')); return m ? { date: m[1] } : null; };
  function todayISO(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
           '-' + String(d.getDate()).padStart(2, '0');
  }
  function forDate(iso) {
    for (let a = 0; a < 60; a++) {
      const p = attempt('lat-turnspell:' + iso + '#' + a);
      if (p) { p.id = idFor(iso); p.date = iso; return p; }
    }
    return null;
  }

  root.TURNSPELL = {
    FACES: FACES, FACE_IDS: FACE_IDS, MOVES: MOVES, PATH: PATH, MODE: MODE,
    axisOf: axisOf, signOf: signOf, cellOf: cellOf, faceOfNormal: faceOfNormal,
    identity: identity, clone: clone, applyMove: applyMove, play: play,
    invert: invert, inverseOf: inverseOf, reduceSeq: reduceSeq,
    frontSlots: frontSlots, frontWord: frontWord, mark: mark, nextMove: nextMove,
    forDate: forDate, todayISO: todayISO, idFor: idFor, parseId: parseId,
    WORDS: WORDS,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.TURNSPELL;
