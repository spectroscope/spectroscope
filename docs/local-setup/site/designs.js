(() => {
  'use strict';

  const KEY = 'spectroscope:designPrefs';

  const DESIGNS = [
    { id: 'spectroscope', legacy: 'dark',  label: 'spectro espresso' },
    { id: 'paper',        legacy: 'light', label: 'spectro paper' },
    { id: 'still',        legacy: 'white', label: 'spectro white' },
    { id: 'graphite',     legacy: null,    label: 'spectro graphite' }
  ];

  const DEFAULTS = { design: 'spectroscope', heroVariant: 'morph', particles: 70, speed: 100 };

  function normalizeId(id) {
    for (const d of DESIGNS) {
      if (id === d.id || (d.legacy && id === d.legacy)) return d.id;
    }
    return DEFAULTS.design;
  }

  function entry(id) {
    return DESIGNS.find((d) => d.id === id) || DESIGNS[0];
  }

  function read() {
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) {  }
    const p = { ...DEFAULTS, ...stored };
    p.design = normalizeId(p.design);
    return p;
  }

  let prefs = read();

  function reflect(p) {
    document.documentElement.dataset.design = p.design;
    window.__spectroPrefs = { ...p };
  }

  reflect(prefs);

  function persist(p) {
    try { localStorage.setItem(KEY, JSON.stringify(p)); } catch (e) {  }
  }

  function apply(patch) {
    prefs = { ...prefs, ...patch };
    prefs.design = normalizeId(prefs.design);
    reflect(prefs);
    persist(prefs);
    window.dispatchEvent(new CustomEvent('spectro:prefs', { detail: { ...prefs } }));
    return prefs;
  }

  function nextDesign() {
    const i = DESIGNS.findIndex((d) => d.id === prefs.design);
    return DESIGNS[(i + 1) % DESIGNS.length].id;
  }

  function bindQuickPrefs(themeEl, partEl) {
    function paint() {
      if (themeEl) {
        themeEl.textContent = entry(prefs.design).label;
        themeEl.setAttribute('aria-label',
          'Color theme: ' + entry(prefs.design).label + '. Activate for ' + entry(nextDesign()).label + '.');
      }
      if (partEl) {
        partEl.textContent = 'particles: ' + (prefs.particles > 0 ? 'on' : 'off');
        partEl.classList.toggle('seg-on', prefs.particles > 0);
      }
    }
    if (themeEl) themeEl.addEventListener('click', () => { apply({ design: nextDesign() }); paint(); });
    if (partEl) partEl.addEventListener('click', () => {
      apply({ particles: prefs.particles > 0 ? 0 : 70 });
      paint();
    });
    paint();
    apply({});
  }

  window.SpectroDesign = {
    DESIGNS,
    STORAGE_KEY: KEY,
    get prefs() { return { ...prefs }; },
    normalizeId,
    apply,
    nextDesign,
    bindQuickPrefs
  };
})();
