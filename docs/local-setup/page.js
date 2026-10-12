/* The Local Setup page: the design switch (designs.js above), the timeline,
   the platform switch, the copy buttons and the "I have this" mark.
   It requests nothing over the network and runs nothing it downloads. */
(() => {
  'use strict';

  const KEY = 'spectroscope:localSetup';
  const root = document.documentElement;

  /* design: the website's own switch, labelled with the current ground */
  if (window.SpectroDesign) {
    window.SpectroDesign.bindQuickPrefs(document.getElementById('design'), null);
  }

  /* platform: the detection of the website's download list */
  const platformButtons = Array.from(document.querySelectorAll('[data-set-platform]'));
  function setPlatform(id) {
    root.dataset.platform = id;
    platformButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.setPlatform === id)));
  }
  const ua = ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '').toLowerCase();
  setPlatform(/linux/.test(ua) && !/android/.test(ua) ? 'linux' : 'mac');
  platformButtons.forEach((b) => b.addEventListener('click', () => setPlatform(b.dataset.setPlatform)));

  /* marks: step id -> timestamp, kept in memory when storage is blocked */
  const cards = Array.from(document.querySelectorAll('.card'));
  const known = new Set(cards.map((c) => c.dataset.step));
  let marks = {};
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      Object.keys(parsed).forEach((id) => {
        if (known.has(id) && typeof parsed[id] === 'number') marks[id] = parsed[id];
      });
    }
  } catch (e) {
    marks = {};
  }
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(marks));
    } catch (e) {
      /* storage blocked: the marks last for this page view */
    }
  }

  const levelButtons = Array.from(document.querySelectorAll('.tl-level'));
  const sections = Array.from(document.querySelectorAll('.level'));
  const progress = document.getElementById('progress');

  function paint() {
    let done = 0;
    cards.forEach((card) => {
      const on = Object.prototype.hasOwnProperty.call(marks, card.dataset.step);
      card.classList.toggle('is-marked', on);
      const box = card.querySelector('input[data-mark]');
      if (box) box.checked = on;
      if (on) done += 1;
    });
    levelButtons.forEach((btn) => {
      const level = btn.dataset.level;
      const own = cards.filter((c) => c.dataset.level === level);
      const marked = own.filter((c) => Object.prototype.hasOwnProperty.call(marks, c.dataset.step)).length;
      const pct = own.length ? Math.round((marked / own.length) * 100) : 0;
      btn.querySelector('.tl-fill').setAttribute('stroke-dasharray', pct + ' 100');
      btn.querySelector('.tl-count').textContent = marked + ' of ' + own.length;
      btn.setAttribute('aria-label', 'Level ' + level + ', ' + btn.dataset.title + ', ' + marked + ' of ' + own.length + ' marked');
    });
    progress.textContent = done + ' of ' + cards.length + ' steps marked';
  }

  cards.forEach((card) => {
    const box = card.querySelector('input[data-mark]');
    if (!box) return;
    box.addEventListener('change', () => {
      if (box.checked) marks[card.dataset.step] = Date.now();
      else delete marks[card.dataset.step];
      save();
      paint();
    });
  });

  /* timeline: click or arrow keys, both directions */
  function activate(level, focus) {
    const id = String(level);
    levelButtons.forEach((b) => {
      const on = b.dataset.level === id;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      if (on && focus) b.focus();
    });
    sections.forEach((s) => { s.hidden = s.dataset.level !== id; });
  }
  function current() {
    const i = levelButtons.findIndex((b) => b.getAttribute('aria-selected') === 'true');
    return i < 0 ? 0 : i;
  }
  levelButtons.forEach((b) => b.addEventListener('click', () => {
    activate(b.dataset.level, false);
    try { history.replaceState(null, '', '#level-' + b.dataset.level); } catch (e) { /* file:// in some browsers */ }
  }));
  document.querySelector('.tl ol').addEventListener('keydown', (ev) => {
    const last = levelButtons.length - 1;
    let i = current();
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') i = Math.min(last, i + 1);
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') i = Math.max(0, i - 1);
    else if (ev.key === 'Home') i = 0;
    else if (ev.key === 'End') i = last;
    else return;
    ev.preventDefault();
    activate(levelButtons[i].dataset.level, true);
  });
  document.querySelectorAll('[data-go-level]').forEach((b) => b.addEventListener('click', () => {
    activate(b.dataset.goLevel, false);
    levelButtons[current()].focus();
  }));

  /* copy: the text of the block, byte for byte */
  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }
  document.querySelectorAll('.copy, .copy-check').forEach((btn) => {
    btn.addEventListener('click', () => {
      const code = btn.parentElement.querySelector('pre code');
      const text = code ? code.textContent : '';
      const done = (ok) => {
        btn.textContent = ok ? 'copied' : 'select it';
        btn.classList.toggle('copied', ok);
        setTimeout(() => { btn.textContent = 'copy'; btn.classList.remove('copied'); }, 1600);
      };
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(() => done(true), () => done(fallbackCopy(text)));
      } else {
        done(fallbackCopy(text));
      }
    });
  });

  /* a link to #step-4.2 or #level-4 opens that level */
  const hash = decodeURIComponent(location.hash || '');
  const step = /^#step-(\d)\.\d+$/.exec(hash);
  const lvl = /^#level-(\d)$/.exec(hash);
  if (step) {
    activate(step[1], false);
    const target = document.getElementById(hash.slice(1));
    if (target) target.scrollIntoView();
  } else if (lvl) {
    activate(lvl[1], false);
  } else {
    activate(levelButtons.length ? levelButtons[0].dataset.level : '1', false);
  }
  paint();
})();
