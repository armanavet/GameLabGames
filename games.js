/* ============================================================================
   games.js — the single source of truth for which games exist.

   Read by the hub (index.html), the embed wrapper (play.html) and the archive
   (archive.html). Adding a game is one entry here plus its player page; none of
   those three files need editing.

     player    the game itself
     archive   its puzzle list (omit if the game has no archive)
     manifest  the index that archive reads when there is no api
     api       optional backend base URL. When set, the index and payloads come
               from it instead of the static files, which is what lets a puzzle
               stay hidden until its publish time. Falls back to `manifest` if
               the backend is unreachable, so the demo never dies with it.
     live      false renders a "Coming soon" card and refuses to route
     hidden    keep it off the hub (tools rather than games)
   ========================================================================= */
(function () {
  'use strict';

  /* Artwork carries a viewBox only — the hub and the archive size it
     differently, so width/height belong to the CSS, not the markup.

     The crossword mark (CrosswordLogoHome): a 3x3 of rounded squares, filled
     ones black, empty ones white with a black rule. The ink is explicit rather
     than currentColor — on a tinted card, currentColor made filled and empty
     squares both white and the pattern disappeared entirely. */
  const INK = '#000';          // CrosswordLogoHome is pure black
  const ROW_INK = '#373737';   // the row marks use the design's --ink
  const grid = cells => {
    let out = '';
    cells.forEach((on, i) => {
      const x = 4 + (i % 3) * 68, y = 4 + Math.floor(i / 3) * 68;
      out += '<rect x="' + x + '" y="' + y + '" width="56" height="56" rx="10" ' +
        (on ? 'fill="' + INK + '"'
            : 'fill="#fff" stroke="' + INK + '" stroke-width="3.4"') + '/>';
    });
    return '<svg viewBox="0 0 200 200" aria-hidden="true">' + out + '</svg>';
  };
  const B = a => a.map(Boolean);

  /* Archive row marks, traced from dailyCrosswordArchive.png and
     SudokuArchive.png. Both are a 3x3 of rounded cells filling the 35px box
     archive.html already frames — the cells run edge to edge, which is what
     made the first attempt look small and floating.

     Crossword: corners and centre inked, the four edge cells left white.
     Sudoku: the same five cells carry digits on the board's own given-grey,
     so the mark reads as a miniature of the puzzle it opens. */
  const ROW_CELL = 10.4, ROW_AT = [1.2, 12.2, 23.2], ROW_MID = [6.4, 17.4, 28.4];
  const QUINCUNX = [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]];

  const rowCell = (c, r, fill) =>
    '<rect x="' + ROW_AT[c] + '" y="' + ROW_AT[r] + '" width="' + ROW_CELL +
    '" height="' + ROW_CELL + '" rx="2.2" fill="' + fill + '"/>';

  const xwordRow =
    '<svg viewBox="0 0 35 35" aria-hidden="true">' +
    QUINCUNX.map(([c, r]) => rowCell(c, r, ROW_INK)).join('') + '</svg>';

  const sudokuRow = (() => {
    const digits = { '0,0': '1', '2,0': '5', '1,1': '3', '0,2': '2', '2,2': '7' };
    let out = '';
    /* #cacaca, sampled from the asset. The board's given-grey (#efefef) is
       far too light at 35px — the cells vanished against the white row. */
    QUINCUNX.forEach(([c, r]) => { out += rowCell(c, r, '#cacaca'); });
    out += '<g fill="#000" font-family="Montserrat,Arial,sans-serif" ' +
           'font-size="7.2" font-weight="700" text-anchor="middle">';
    QUINCUNX.forEach(([c, r]) => {
      out += '<text x="' + ROW_MID[c] + '" y="' + (ROW_MID[r] + 2.6) + '">' +
             digits[c + ',' + r] + '</text>';
    });
    return '<svg viewBox="0 0 35 35" aria-hidden="true">' + out + '</g></svg>';
  })();

  const nums = n => {
    let out = '<g fill="none" stroke="currentColor" stroke-width="1.8">' +
              '<rect x="4" y="4" width="44" height="44" rx="3"/>';
    for (let i = 1; i < n; i++) {
      const p = 4 + (44 / n) * i;
      out += '<path d="M' + p + ' 4v44M4 ' + p + 'h44"/>';
    }
    return '<svg viewBox="0 0 52 52" aria-hidden="true">' + out + '</g></svg>';
  };

  const flower =
    '<svg viewBox="0 0 52 52" aria-hidden="true">' +
    '<g fill="#fff" stroke="currentColor" stroke-width="2">' +
    '<circle cx="26" cy="11" r="8"/><circle cx="26" cy="41" r="8"/>' +
    '<circle cx="11" cy="26" r="8"/><circle cx="41" cy="26" r="8"/>' +
    '<circle cx="15.5" cy="15.5" r="8"/><circle cx="36.5" cy="36.5" r="8"/>' +
    '<circle cx="36.5" cy="15.5" r="8"/><circle cx="15.5" cy="36.5" r="8"/>' +
    '</g><circle cx="26" cy="26" r="9" fill="currentColor"/></svg>';

  const piece =
    '<svg viewBox="0 0 52 52" aria-hidden="true">' +
    '<path d="M6 6h16a5 5 0 1 1 8 0h16v16a5 5 0 1 0 0 8v16H30a5 5 0 1 0-8 0H6V30a5 5 0 1 1 0-8z" ' +
    'fill="#fff" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/></svg>';

  const search =
    '<svg viewBox="0 0 52 52" aria-hidden="true">' +
    '<g fill="none" stroke="currentColor" stroke-width="2">' +
    '<rect x="4" y="4" width="44" height="44" rx="4"/>' +
    '<path d="M4 18h44M4 32h44M18 4v44M32 4v44"/></g>' +
    '<path d="M9 43L43 9" stroke="currentColor" stroke-width="4" stroke-linecap="round" opacity=".85"/></svg>';

  /* One backend serves every game; keep the URL in one place so enabling a
     game cannot half-point it somewhere else. See backend/README.md. */
  const API = 'https://lat-puzzles.armanavetisyan1997.workers.dev';

  /* Card colours for the hub. Kept together so the set can be read at a
     glance and two games cannot quietly end up the same. Daily Crossword has
     no tint — it keeps the shared --band peach the design uses everywhere.
     Every tint takes white artwork, so they are dark enough for it. */
  const TINT = {
    /* Two families, each a shade apart rather than a different hue: the
       crosswords stay on the design's peach, the sudokus on its azure, so the
       hub reads as two groups instead of five unrelated cards. */
    crossword:  '#ffd4a3',   // --band, the design's own
    midi:       '#ffc38a',
    mini:       '#ffe7cd',
    sudoku:     '#00a8f0',   // azure, from the Sudoku frames
    'sudoku-x': '#0b76b8',   // the same azure, deeper
  };

  window.GAMES = {
    crossword: {
      label: 'Daily Crossword', short: 'Crossword',
      blurb: 'A fresh crossword every day.',
      archiveBlurb: 'An engaging new puzzle to conquer each day.',
      player: 'crossword.html', archive: 'archive.html', manifest: 'puzzles.json',
      api: API,
      art: grid(B([1, 0, 1, 0, 1, 0, 1, 0, 1])), archiveArt: xwordRow, live: true
    },
    /* Midi and Mini are the crossword engine at other sizes — same player,
       same payload schema, their own index. They have no `manifest` because
       there is no static back catalogue for them yet: with the backend down
       they say so rather than showing the Daily's puzzles. */
    midi: {
      label: 'Midi Crossword', short: 'Midi',
      blurb: 'A middleweight grid for a shorter sitting.',
      archiveBlurb: 'A middleweight grid for a shorter sitting.',
      player: 'crossword.html', archive: 'archive.html', api: API,
      tint: TINT.midi,
      art: grid(B([0, 1, 0, 1, 1, 1, 0, 1, 0])), archiveArt: xwordRow, live: true
    },
    mini: {
      label: 'Mini Crossword', short: 'Mini',
      blurb: 'A small grid for a quick break.',
      archiveBlurb: 'A small grid for a quick break.',
      player: 'crossword.html', archive: 'archive.html', api: API,
      tint: TINT.mini,
      art: grid(B([1, 0, 0, 0, 0, 0, 0, 0, 1])), archiveArt: xwordRow, live: true
    },
    wordflower: {
      label: 'Wordflower', short: 'Wordflower',
      blurb: 'Build as many words as you can from seven letters.',
      art: flower
    },
    /* Sudoku is GENERATED, not authored: the date seeds the puzzle, so there
       is no manifest, no api and nothing to upload. `generated.days` is how
       far back the archive offers — a future date is never listed and the
       player refuses to build one, which is decision D5 for free. */
    sudoku: {
      label: 'Sudoku', short: 'Sudoku',
      blurb: 'The classic number-placement puzzle.',
      archiveBlurb: 'A fresh number-placement puzzle every day.',
      player: 'sudoku.html', archive: 'archive.html', start: 'sudoku-start.html',
      generated: { days: 30, size: '9x9', cells: 81, byDifficulty: true },
      tint: TINT.sudoku, tintInk: '#fff',
      art: nums(3), archiveArt: sudokuRow, live: true
    },
    jigsaw: {
      label: 'Jigsaw', short: 'Jigsaw',
      blurb: 'Reassemble a photograph, one piece at a time.',
      art: piece
    },
    wordsearch: {
      label: 'Word Search', short: 'Word Search',
      blurb: 'Find themed words hidden in the letters.',
      art: search
    },
    /* Impossible Sudoku is the same player at a fixed level: no difficulty
       screen, straight to its own archive. `generated.level` pins it, and
       idPrefix keeps ids in the engine's sudoku-<level>-<date> shape. */
    'sudoku-x': {
      label: 'Impossible Sudoku', short: 'Impossible',
      blurb: 'Sudoku with the training wheels removed.',
      archiveBlurb: 'Sudoku with the training wheels removed.',
      player: 'sudoku.html', archive: 'archive.html',
      generated: { days: 30, size: '9x9', cells: 81, idPrefix: 'sudoku', level: 'impossible' },
      tint: TINT['sudoku-x'], tintInk: '#fff',
      art: nums(4), archiveArt: sudokuRow, live: true
    },
    editor: {
      label: 'Puzzle editor', short: 'Editor',
      player: 'editor.html', live: true, hidden: true
    }
  };

  /* Resolve a ?game= value to a real entry. Falls back rather than throwing,
     and returns the id too so callers never pass an unknown one downstream. */
  /* A browser-local override so the admin page can point the whole build at a
     backend without editing this file. */
  window.apiBase = function (g) {
    try {
      const o = localStorage.getItem('lat:games:apiBase');
      if (o) return o.replace(/\/+$/, '');
    } catch (_) {}
    return (g && g.api ? g.api : '').replace(/\/+$/, '');
  };

  window.resolveGame = function (id) {
    const g = window.GAMES[id];
    if (g && g.live) return { id: id, game: g };
    return { id: 'crossword', game: window.GAMES.crossword };
  };
})();
