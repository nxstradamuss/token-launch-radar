// Layout probe: runs after app.js, reports geometry in the title so --dump-dom can read it.
(function () {
  function box(sel) {
    var el = document.querySelector(sel);
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { t: Math.round(r.top), b: Math.round(r.bottom), h: Math.round(r.height), w: Math.round(r.width), l: Math.round(r.left) };
  }
  function part(sel) {
    var el = document.querySelector(sel);
    if (!el) return 'x';
    var r = el.getBoundingClientRect();
    return Math.round(r.height) + 'x' + Math.round(r.width);
  }
  var sels = ['.dhead', '.bignum', '.kv', '.formula', '.versus', '.steps', '.mults', '.note', '.card h2', '.backbar', '.filterbar', '.ladder'];
  var parts = {};
  sels.forEach(function (s) { parts[s] = part(s); });
  var out = {
    view: document.body.getAttribute('data-view'),
    innerW: innerWidth, innerH: innerHeight,
    scrollW: document.documentElement.scrollWidth,
    scrollH: document.documentElement.scrollHeight,
    overflowX: document.documentElement.scrollWidth > innerWidth + 1,
    hero: box('.hero'), stats: box('.stats'), controls: box('.controls'),
    table: box('.tablewrap'), firstRow: box('tbody tr'),
    detail: box('.detail'), farm: box('.dcol:last-child .card'),
    lastStep: box('.steps li:last-child'), foot: box('.foot'),
    parts: parts,
    steps: document.querySelectorAll('.steps li').length,
    rows: document.querySelectorAll('tbody tr').length,
    errors: window.__errors || []
  };
  document.title = JSON.stringify(out);
})();
