/* ============================================================================
   core.js — shared behaviour for every game in the platform.
   Owns: puzzle loading, versioned storage, timer, toolbar + menu chrome,
   modal/dialog management with focus trapping, share, toast, live region,
   and the analytics contract with the host page.
   A game supplies its own board, and calls XW.* for everything else.
   No build step, no dependencies. Namespaced on window.XW.
   ========================================================================= */
window.XW = (function () {
  'use strict';

  /* ---------- utils ---------- */
  const $ = (sel, root) => (root || document).querySelector(sel);
  const el = (tag, cls, txt) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  };
  const icon = (id, w, h) =>
    '<svg width="' + w + '" height="' + (h || w) + '" aria-hidden="true">' +
    '<use href="icons.svg#' + id + '"/></svg>';

  function b64dec(s) {
    const bin = atob(s);
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);   // replaces deprecated escape()
  }

  const pad2 = n => String(n).padStart(2, '0');
  const fmtTime = s => pad2(Math.floor(s / 60)) + ':' + pad2(s % 60);

  /* ---------- puzzle loading ---------- */
  async function loadPuzzle(opts) {
    opts = opts || {};
    const params = new URLSearchParams(location.search);
    const pid = (params.get('p') || params.get('puzzle') || '').toLowerCase();
    if (location.hash.indexOf('#data=') === 0) {
      try { return { id: 'preview', data: JSON.parse(b64dec(location.hash.slice(6))) }; } catch (e) {}
    }
    const man = await (await fetch(opts.manifest || 'puzzles.json', { cache: 'no-store' })).json();
    // schema 2 (ARCHIVE-PLAN.md) — readable index pointing at one file per puzzle
    if (Array.isArray(man.index) && man.index.length) {
      const live = man.index.filter(r => r.status !== 'draft');
      const rec = live.find(r => r.id === pid) || live.find(r => r.id === man.default) || live[0];
      const raw = await (await fetch(rec.payloadUrl || rec.file, { cache: 'no-store' })).json();
      // payload is the puzzle object as authored; {data:"<base64>"} still accepted
      const data = (raw && typeof raw.data === 'string') ? JSON.parse(b64dec(raw.data)) : raw;
      // the index is the hand-editable source of truth for metadata
      ['caption', 'date', 'author', 'editor'].forEach(k => { if (rec[k]) data[k] = rec[k]; });
      if (!data.title && rec.title) data.title = rec.title;
      return { id: rec.id, data, meta: rec };
    }
    // schema 1 — inline base64 map
    const key = (pid && man.puzzles[pid]) ? pid : (man.default || Object.keys(man.puzzles)[0]);
    const entry = man.puzzles[key];
    return { id: key, data: (typeof entry === 'string') ? JSON.parse(b64dec(entry)) : entry };
  }

  /* ---------- storage ----------
     Versioned and id-based. Legacy flat {"r,c":"A"} blobs are still readable so
     upgrading does not orphan anyone's in-progress solve. */
  const STORE_V = 'v1';
  const storage = {
    key: id => 'lat:games:' + STORE_V + ':' + id,
    load(id) {
      try {
        const raw = localStorage.getItem(storage.key(id));
        if (raw) { const o = JSON.parse(raw); if (o && o.v) return o; }
        const legacy = localStorage.getItem('xw:' + id);
        if (legacy) return { v: 0, letters: JSON.parse(legacy), elapsed: 0, revealed: [], completed: false };
      } catch (e) {}
      return null;
    },
    save(id, state) {
      try {
        localStorage.setItem(storage.key(id),
          JSON.stringify(Object.assign({ v: 1, updatedAt: Date.now() }, state)));
      } catch (e) {}
    },
    clear(id) {
      try { localStorage.removeItem(storage.key(id)); localStorage.removeItem('xw:' + id); } catch (e) {}
    }
  };

  /* ---------- analytics: fire-and-forget to the host page ----------
     Event names are the TECH-PLAN §4.4 contract; set XW.hostOrigin before use. */
  let hostOrigin = '*';
  function emit(event, detail) {
    try {
      parent.postMessage(Object.assign(
        { source: 'lat-games', v: 1, event: event, ts: Date.now() }, detail || {}), hostOrigin);
    } catch (e) {}
  }

  /* ---------- timer ----------
     Accumulates real elapsed time from Date.now() deltas. setInterval alone is
     throttled to ~1/min in background tabs, which silently under-counts and
     corrupts any time-based scoring. */
  const timer = {
    secs: 0, stopped: false, _last: 0, _tick: null, onTick: null,
    start(from) {
      timer.secs = from || 0; timer.stopped = false; timer._last = Date.now();
      if (timer._tick) clearInterval(timer._tick);
      timer._tick = setInterval(timer._advance, 1000);
      timer._advance();
    },
    _advance() {
      const now = Date.now();
      if (!timer.stopped) {
        const d = Math.round((now - timer._last) / 1000);
        if (d > 0) { timer.secs += d; if (timer.onTick) timer.onTick(timer.secs); }
      }
      timer._last = now;
    },
    stop() { timer._advance(); timer.stopped = true; },
    reset() { timer.secs = 0; timer._last = Date.now(); if (timer.onTick) timer.onTick(0); }
  };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) timer._advance(); });

  /* ---------- feedback ---------- */
  let toastT;
  function toast(msg) {
    const t = $('#toast'); if (!t) return;
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1800);
  }
  function announce(msg) { const l = $('#srLive'); if (l) l.textContent = msg; }

  /* ---------- overlays: focus trap + restore ---------- */
  const FOCUSABLE = 'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])';
  let lastFocus = null;
  function openOverlay(id) {
    closeMenus();
    const ov = typeof id === 'string' ? document.getElementById(id) : id;
    if (!ov) return;
    lastFocus = document.activeElement;
    ov.classList.add('open');
    const f = ov.querySelectorAll(FOCUSABLE);
    if (f.length) f[0].focus();
  }
  function closeOverlay(ov) {
    if (!ov) return;
    ov.classList.remove('open');
    if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
    lastFocus = null;
    if (XW.onOverlayClose) XW.onOverlayClose();
  }
  function anyOverlayOpen() { return !!$('.overlay.open'); }
  function initOverlays() {
    document.querySelectorAll('.overlay').forEach(ov => {
      ov.addEventListener('click', e => {
        if (e.target === ov || (e.target.closest && e.target.closest('[data-close]'))) closeOverlay(ov);
      });
    });
    document.addEventListener('keydown', e => {
      const ov = $('.overlay.open');
      if (e.key === 'Escape') { if (ov) closeOverlay(ov); else closeMenus(); return; }
      if (e.key !== 'Tab' || !ov) return;
      const f = [...ov.querySelectorAll(FOCUSABLE)].filter(n => n.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  }

  /* ---------- generic confirm/notice dialog (177:8475 / 177:8768) ---------- */
  let dlgAction = null;
  function dialog(title, body, onOk, opts) {
    opts = opts || {};
    $('#dlgTitle').textContent = title;
    $('#dlgBody').textContent = body;
    dlgAction = onOk || null;
    const ok = $('#dlgOk'), cancel = $('#dlgClose');
    cancel.textContent = opts.cancel || 'Close';
    ok.textContent = opts.ok || 'Ok';
    ok.style.display = onOk ? 'flex' : 'none';
    openOverlay('dialogOverlay');
  }

  /* ---------- menus ---------- */
  let menus = {};
  function closeMenus() {
    ['assistMenu', 'mainMenu', 'shareMenu', 'menuScrim'].forEach(id => {
      const n = document.getElementById(id); if (n) n.classList.remove('open', 'sharing');
    });
    ['assistBtn', 'assistMobBtn', 'menuBtn'].forEach(id => {
      const n = document.getElementById(id); if (n) n.setAttribute('aria-expanded', 'false');
    });
  }
  function toggleMenu(panelId, btnIds) {
    const panel = document.getElementById(panelId);
    const wasOpen = panel.classList.contains('open');
    closeMenus();
    if (!wasOpen) {
      panel.classList.add('open');
      btnIds.forEach(b => { const n = document.getElementById(b); if (n) n.setAttribute('aria-expanded', 'true'); });
      if (panelId === 'mainMenu') {
        const scrim = $('#menuScrim'), bar = $('.topbar');
        if (scrim && bar) { scrim.style.top = bar.offsetHeight + 'px'; scrim.classList.add('open'); }
      }
      const f = panel.querySelector('button'); if (f) f.focus();
    }
  }

  /* ---------- share ----------
     Embedded, location.href is the asset host (…/crossword.html?p=x), not the
     page the reader is on. Sharing that hands people a chrome-less player. The
     host passes its own URL down as ?canonical=… on the iframe src; we fall
     back to our own URL when running standalone. */
  let puzzleId = '';
  function shareUrl() {
    const base = new URLSearchParams(location.search).get('canonical') || location.href;
    if (!puzzleId) return base;
    try {                                   // merge the puzzle in, don't duplicate it
      const u = new URL(base, location.href);
      u.searchParams.set('p', puzzleId);
      return u.toString();
    } catch (_) { return base; }
  }
  /* "Play this Crossword at <url>" — a bare link loses what it points at */
  function shareText(label) {
    return 'Play this ' + (label || 'puzzle') + ' at ' + shareUrl();
  }

  function shareTargets(url, title) {
    const u = encodeURIComponent(url), t = encodeURIComponent(title);
    return {
      facebook: 'https://www.facebook.com/sharer/sharer.php?u=' + u,
      x: 'https://twitter.com/intent/tweet?url=' + u + '&text=' + t,
      whatsapp: 'https://wa.me/?text=' + t + '%20' + u
    };
  }
  function share(kind, url, title) {
    if (kind === 'copy') {
      const txt = title && title.indexOf('http') >= 0 ? title : url;   // prefer the full sentence
      if (navigator.clipboard) navigator.clipboard.writeText(txt).then(() => toast('Link copied')).catch(() => toast(txt));
      else toast(txt);
      return;
    }
    const t = shareTargets(url, title)[kind];
    if (t) window.open(t, '_blank', 'noopener,noreferrer');
  }

  /* ---------- toolbar (177:6683 desktop / 223:23516 mobile) ----------
     Declarative, because games differ: sudoku wants a pencil toggle and no
     Assist, wordflower shows a score chip instead of a timer, jigsaw wants a
     preview button. Slots take builtin names or a spec object, so a game can
     add a control core.js has never heard of without touching core.js.

       XW.mountToolbar(app, {
         left:  ['timer', 'print'],
         right: ['clueList', 'settings', 'assist', 'menu']
       });

       // sudoku: no assist, custom pencil toggle, difficulty chip
       XW.mountToolbar(app, {
         left:  ['timer', {id:'difficulty', kind:'pill', text:'Medium', label:'Difficulty'}],
         right: [{id:'pencilBtn', icon:'i-pencil', size:20, label:'Pencil marks', toggle:true},
                 'settings', 'menu'],
         menuItems: [['more','More puzzles'],['howto','How to play'],['restart','New game'],['share','Share']]
       });

     Custom spec: {id, kind:'circle'|'pill', icon, size, text, label,
                   toggle, only:'mobile'|'desktop'}
     Chip text is updated later with XW.setChip(id, text).             */

  const BUILTIN = {
    timer: () => {
      const t = el('button', 'pill'); t.id = 'timerPill'; t.type = 'button';
      t.setAttribute('aria-label', 'Elapsed time, click to hide or show');
      t.innerHTML = icon('i-clock', 16) + '<span id="timer">00:00</span>';
      return t;
    },
    print:    () => mkBtn({ id: 'printBtn',    icon: 'i-printer',     size: 18, label: 'Print' }),
    settings: () => mkBtn({ id: 'settingsBtn', icon: 'i-settings',    size: 19, label: 'Settings' }),
    clueList: () => mkBtn({ id: 'clueListBtn', icon: 'i-task-square', size: 24, label: 'Clue list',
                            toggle: true, only: 'mobile' }),
    assistIcon: () => mkBtn({ id: 'assistMobBtn', icon: 'i-lamp-on', size: 24, label: 'Assist',
                              popup: true, only: 'mobile' }),
    menu:   spec => mkMenu(spec),
    assist: spec => mkAssist(spec)
  };

  function mkBtn(o) {
    const b = el('button', 'circle' + (o.only === 'mobile' ? ' mobonly' : o.only === 'desktop' ? ' deskonly' : ''));
    b.id = o.id; b.type = 'button';
    b.title = o.label; b.setAttribute('aria-label', o.label);
    if (o.toggle) b.setAttribute('aria-pressed', 'false');
    if (o.popup) { b.setAttribute('aria-haspopup', 'true'); b.setAttribute('aria-expanded', 'false'); }
    b.innerHTML = icon(o.icon, o.size || 19);
    return b;
  }
  function mkChip(o) {
    const c = el('button', 'pill' + (o.only === 'mobile' ? ' mobonly' : o.only === 'desktop' ? ' deskonly' : ''));
    c.id = o.id; c.type = 'button';
    c.setAttribute('aria-label', o.label || o.id);
    c.innerHTML = (o.icon ? icon(o.icon, o.size || 16) : '') +
                  '<span data-chip="' + o.id + '">' + (o.text != null ? o.text : '') + '</span>';
    return c;
  }
  function mkMenu(spec) {
    const mw = el('div', 'menuwrap');
    const m = mkBtn({ id: 'menuBtn', icon: 'i-menu', size: 19, label: 'Menu', popup: true });
    m.classList.add('hamb'); mw.appendChild(m);

    const menu = el('div', 'mmenu'); menu.id = 'mainMenu';
    menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'Puzzle menu');
    (spec.menuItems || [['more', 'More puzzles'], ['howto', 'How to play'], ['save', 'Save'],
      ['restart', 'Start again'], ['share', 'Share'], ['support', 'Support']]).forEach(([act, label]) => {
      const b = el('button', act === 'share' ? 'hasChev' : ''); b.type = 'button';
      b.dataset.mact = act; b.setAttribute('role', 'menuitem'); b.textContent = label;
      if (act === 'share') {
        b.setAttribute('aria-haspopup', 'true'); b.setAttribute('aria-expanded', 'false');
        const ch = el('span', 'chev'); ch.innerHTML = icon('i-chevron-right', 4, 8); b.appendChild(ch);
      }
      menu.appendChild(b);
    });
    mw.appendChild(menu);

    const sm = el('div', 'sharemenu'); sm.id = 'shareMenu';
    sm.setAttribute('role', 'menu'); sm.setAttribute('aria-label', 'Share');
    [['copy', 'i-copy', 24, 24, 'Copy link'], ['facebook', 'i-facebook', 13, 24, 'Share on Facebook'],
     ['x', 'i-x', 25.64, 24, 'Share on X'], ['whatsapp', 'i-whatsapp', 20.67, 20, 'Share on WhatsApp']]
      .forEach(([k, ic, w, h, label]) => {
        const b = el('button'); b.type = 'button'; b.dataset.share = k;
        b.title = label; b.setAttribute('aria-label', label); b.setAttribute('role', 'menuitem');
        b.innerHTML = icon(ic, w, h); sm.appendChild(b);
      });
    mw.appendChild(sm);
    return mw;
  }
  function mkAssist(spec) {
    const aw = el('div', 'assistwrap');
    const ab = el('button', 'pill'); ab.id = 'assistBtn'; ab.type = 'button';
    ab.setAttribute('aria-haspopup', 'true'); ab.setAttribute('aria-expanded', 'false');
    ab.innerHTML = 'Assist<span class="caret">' + icon('i-caret', 10, 6) + '</span>';
    const am = el('div', 'menu'); am.id = 'assistMenu';
    am.setAttribute('role', 'menu'); am.setAttribute('aria-label', 'Assist');
    (spec.assistItems || [['reveal-letter', 'Reveal letter'], ['reveal-word', 'Reveal word'],
      ['reveal-grid', 'Reveal grid'], ['check-letter', 'Check letter'],
      ['check-word', 'Check word'], ['check-grid', 'Check grid']]).forEach(([act, label]) => {
      const b = el('button', '', label); b.type = 'button';
      b.dataset.act = act; b.setAttribute('role', 'menuitem'); am.appendChild(b);
    });
    aw.appendChild(ab); aw.appendChild(am);
    return aw;
  }

  function buildItem(item, spec) {
    if (typeof item === 'string') {
      const f = BUILTIN[item];
      if (!f) { console.warn('[XW] unknown toolbar item:', item); return null; }
      return f(spec);
    }
    return item.kind === 'pill' ? mkChip(item) : mkBtn(item);
  }

  function mountToolbar(host, spec) {
    spec = spec || {};
    // legacy flag form still works: {clueList:true, assist:false, print:false}
    if (!spec.left && !spec.right) {
      spec = Object.assign({}, spec, {
        left: ['timer'].concat(spec.print === false ? [] : ['print']),
        right: (spec.clueList ? ['clueList'] : [])
          .concat(['settings'])
          .concat(spec.assist === false ? [] : ['assistIcon'])
          .concat(['menu'])
          .concat(spec.assist === false ? [] : ['assist'])
      });
    }
    const bar = el('div', 'topbar');
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', spec.label || 'Puzzle controls');
    const left = el('div', 'tb-side'), right = el('div', 'tb-side right');
    (spec.left || []).forEach(i => { const n = buildItem(i, spec); if (n) left.appendChild(n); });
    (spec.right || []).forEach(i => { const n = buildItem(i, spec); if (n) right.appendChild(n); });
    bar.appendChild(left); bar.appendChild(right);
    host.appendChild(bar);
    return bar;
  }

  /* update a chip's text, e.g. XW.setChip('score', '117') */
  function setChip(id, text) {
    const n = document.querySelector('[data-chip="' + id + '"]');
    if (n) n.textContent = text;
  }

  /* wires the chrome mountToolbar produced; game supplies the action handlers */
  function wireChrome(handlers) {
    const h = handlers || {};
    const assistBtn = $('#assistBtn'), assistMob = $('#assistMobBtn'),
          menuBtn = $('#menuBtn'), mainMenu = $('#mainMenu'),
          shareMenu = $('#shareMenu'), assistMenu = $('#assistMenu');

    const openAssist = e => { e.stopPropagation(); toggleMenu('assistMenu', ['assistBtn', 'assistMobBtn']); };
    if (assistBtn) assistBtn.addEventListener('click', openAssist);
    if (assistMob) assistMob.addEventListener('click', openAssist);
    if (menuBtn) menuBtn.addEventListener('click', e => { e.stopPropagation(); toggleMenu('mainMenu', ['menuBtn']); });
    document.addEventListener('click', closeMenus);
    if (mainMenu) mainMenu.addEventListener('click', e => e.stopPropagation());
    const scrim = $('#menuScrim'); if (scrim) scrim.addEventListener('click', closeMenus);

    if (assistMenu) assistMenu.addEventListener('click', e => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      closeMenus(); if (h.assist) h.assist(b.dataset.act);
    });

    if (shareMenu) shareMenu.addEventListener('click', e => {
      e.stopPropagation();
      const b = e.target.closest('[data-share]'); if (!b) return;
      share(b.dataset.share, shareUrl(), shareText((h.title && h.title()) || document.title));
      emit('share_clicked', { target: b.dataset.share });
      closeMenus();
    });

    if (mainMenu) mainMenu.addEventListener('click', e => {
      const b = e.target.closest('button[data-mact]'); if (!b) return;
      const act = b.dataset.mact;
      if (act === 'share') {
        const open = shareMenu.classList.contains('open');
        shareMenu.classList.toggle('open', !open);
        mainMenu.classList.toggle('sharing', !open);
        b.setAttribute('aria-expanded', String(!open));
        return;
      }
      shareMenu.classList.remove('open'); mainMenu.classList.remove('sharing');
      closeMenus();
      if (h.menu) h.menu(act);
    });

    const tp = $('#timerPill');
    if (tp && h.toggleTimer) tp.addEventListener('click', h.toggleTimer);
    initOverlays();
  }

  /* set by each game at boot, so core.js never hardcodes one */
  let gameId = 'crossword';

  const framed = (() => { try { return window.top !== window.self; } catch (_) { return true; } })();

  /* Navigation, when embedded, is the host's decision — only latimes.com knows
     its own URL scheme, and reaching for window.top.location would either jump
     the reader off the site onto the asset host or throw cross-origin. So we
     state the intent and let the host route. Standalone (our play.html harness
     opened directly) we route ourselves. play.html implements the listener, so
     it doubles as the reference for what the host needs to do. */
  function navigate(intent) {
    intent = Object.assign({ gameId: gameId }, intent);
    if (framed) { emit('navigate', intent); return; }
    const q = new URLSearchParams({ game: intent.gameId });
    if (intent.puzzleId) q.set('p', intent.puzzleId);
    location.href = 'play.html?' + q.toString();
  }
  function goArchive() { navigate({ view: 'archive' }); }
  function goPuzzle(id) { navigate({ view: 'puzzle', puzzleId: id }); }

  const XW = {
    $, el, icon, b64dec, fmtTime,
    loadPuzzle, storage, timer,
    emit, get hostOrigin() { return hostOrigin; }, set hostOrigin(v) { hostOrigin = v; },
    get gameId() { return gameId; }, set gameId(v) { gameId = v; },
    get puzzleId() { return puzzleId; }, set puzzleId(v) { puzzleId = v; },
    toast, announce,
    openOverlay, closeOverlay, anyOverlayOpen, initOverlays, dialog,
    closeMenus, toggleMenu, share, shareUrl, shareText, navigate, goArchive, goPuzzle, get framed() { return framed; },
    mountToolbar, setChip, wireChrome,
    registerToolbarItem(name, factory) { BUILTIN[name] = factory; },
    get dlgAction() { return dlgAction; }
  };
  return XW;
})();
