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
     differently, so width/height belong to the CSS, not the markup. */
  const grid = cells => {
    let out = '';
    cells.forEach((on, i) => {
      const x = 3 + (i % 3) * 15, y = 3 + Math.floor(i / 3) * 15;
      out += '<rect x="' + x + '" y="' + y + '" width="12" height="12" rx="2" ' +
        (on ? 'fill="currentColor"' : 'fill="#fff" stroke="currentColor" stroke-width="1.2"') + '/>';
    });
    return '<svg viewBox="0 0 51 51" aria-hidden="true">' + out + '</svg>';
  };
  const B = a => a.map(Boolean);

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

  window.GAMES = {
    crossword: {
      label: 'Daily Crossword', short: 'Crossword',
      blurb: 'A fresh crossword every day.',
      archiveBlurb: 'An engaging new puzzle to conquer each day.',
      player: 'crossword.html', archive: 'archive.html', manifest: 'puzzles.json',
      api: API,
      art: grid(B([1, 0, 1, 0, 1, 0, 1, 0, 1])), live: true
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
      art: grid(B([0, 1, 0, 1, 1, 1, 0, 1, 0])), live: true
    },
    mini: {
      label: 'Mini Crossword', short: 'Mini',
      blurb: 'A small grid for a quick break.',
      archiveBlurb: 'A small grid for a quick break.',
      player: 'crossword.html', archive: 'archive.html', api: API,
      art: grid(B([1, 0, 0, 0, 0, 0, 0, 0, 1])), live: true
    },
    wordflower: {
      label: 'Wordflower', short: 'Wordflower',
      blurb: 'Build as many words as you can from seven letters.',
      art: flower
    },
    sudoku: {
      label: 'Sudoku', short: 'Sudoku',
      blurb: 'The classic number-placement puzzle.',
      art: nums(3)
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
    'sudoku-x': {
      label: 'Impossible Sudoku', short: 'Impossible',
      blurb: 'Sudoku with the training wheels removed.',
      art: nums(4)
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
