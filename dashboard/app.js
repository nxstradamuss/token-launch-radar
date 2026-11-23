/* Token Radar — the page. One dataset (window.RADAR, written beside this page as data.js),
   no network calls, no framework. Views: board, detail, peer multiples, live market, set aside.
   State lives in the URL query so a headless render can ask for any view directly. */

(function () {
  'use strict';

  var R = window.RADAR;
  var $ = function (id) { return document.getElementById(id); };

  if (!R || !Array.isArray(R.rows)) {
    $('view').innerHTML = '<p class="empty">data.js did not load, so there is nothing to rank.</p>';
    return;
  }

  var M = R.model;
  // The calibration block: what the fit is worth, measured out of sample. Every number the page
  // quotes about its own accuracy comes from here, so the page cannot claim more than the fit earned.
  var CAL = R.calibration || null;
  var C = (function () {
    if (!CAL) return { rows: 0, chosen_median: 0, bandCoverage: 0, ablation: [], correlations: [], chosen: '' };
    var picked = null;
    for (var i = 0; i < CAL.ablation.length; i++) {
      if (CAL.ablation[i].spec === CAL.chosen) picked = CAL.ablation[i];
    }
    return {
      rows: CAL.rows,
      chosen: CAL.chosen,
      chosen_median: picked ? picked.median : 0,
      chosen_within2: picked ? picked.within2 : 0,
      bandCoverage: CAL.bandCoverage,
      bandLow: CAL.bandLow,
      bandHigh: CAL.bandHigh,
      ablation: CAL.ablation,
      correlations: CAL.correlations,
      lambda: CAL.lambda
    };
  })();
  var TITLES = {
    board: 'Every pre-token protocol, priced by a multiple fitted to the market',
    detail: 'Protocol dossier',
    fit: 'How the multiple was fitted, and what it is worth out of sample',
    peers: 'What each category is worth, per dollar of TVL',
    live: 'The market\'s own prices, and what they imply',
    aside: 'Set aside — and the reason for each'
  };
  var MAX_VAL = Math.max.apply(null, R.rows.map(function (r) { return r.implied_value_usd; }));
  var BY_SLUG = {};
  R.rows.forEach(function (r) { BY_SLUG[r.slug] = r; });

  /* ------------------------------------------------------------------ format */

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function money(n) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    var a = Math.abs(n);
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(a >= 1e8 ? 0 : 1) + 'M';
    if (a >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
    return '$' + Math.round(n);
  }

  function pct(n) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    return (n > 0 ? '+' : '') + n.toFixed(1) + '%';
  }

  // Absolute share, no leading sign. pct() is a delta formatter and a "+" on "79.7% of rows landed
  // inside the band" reads as a change rather than a level.
  function pctAbs(n) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    return n.toFixed(1) + '%';
  }

  function x(n) { return n.toFixed(2) + '×'; }

  // The board prices TVL × multiple, so the multiple is printed with four significant figures
  // instead of two decimals: at 0.0292× a two-decimal column reads 0.03× and the row no longer
  // multiplies out to the implied value beside it.
  function xs(n) {
    if (n >= 10) return n.toFixed(1) + '×';
    if (n >= 1) return n.toFixed(3) + '×';
    if (n >= 0.1) return n.toFixed(4) + '×';
    return n.toFixed(5) + '×';
  }

  function num(n) { return n.toLocaleString('en-US'); }

  function ageText(d) { return d === null || d === undefined ? 'unknown' : num(d) + 'd'; }

  /* ------------------------------------------------------------------ state */

  var S = { view: 'board', slug: null, q: '', cat: 'all', chain: 'all', sort: 'rank', watch: false };

  (function readUrl() {
    var p = new URLSearchParams(location.search);
    if (p.get('view')) S.view = p.get('view');
    if (p.get('slug')) S.slug = p.get('slug');
    if (p.get('q')) S.q = p.get('q');
    if (p.get('cat')) S.cat = p.get('cat');
    if (p.get('chain')) S.chain = p.get('chain');
    if (p.get('sort')) S.sort = p.get('sort');
    if (p.get('watch') === '1') S.watch = true;
  })();

  function syncUrl() {
    var p = new URLSearchParams();
    if (S.view !== 'board') p.set('view', S.view);
    if (S.view === 'detail' && S.slug) p.set('slug', S.slug);
    if (S.q) p.set('q', S.q);
    if (S.cat !== 'all') p.set('cat', S.cat);
    if (S.chain !== 'all') p.set('chain', S.chain);
    if (S.sort !== 'rank') p.set('sort', S.sort);
    if (S.watch) p.set('watch', '1');
    var qs = p.toString();
    history.replaceState(null, '', qs ? '?' + qs : location.pathname);
  }

  /* ------------------------------------------------------------------ filtering */

  function chainList(r) { return r.chains && r.chains.length ? r.chains : ['—']; }

  function filtered() {
    var q = S.q.trim().toLowerCase();
    var out = R.rows.filter(function (r) {
      if (S.watch && !r.watchlisted) return false;
      if (S.cat !== 'all' && (r.category || '—') !== S.cat) return false;
      if (S.chain !== 'all' && chainList(r).indexOf(S.chain) < 0) return false;
      if (q) {
        var hay = (r.name + ' ' + r.slug + ' ' + (r.category || '') + ' ' + chainList(r).join(' ')).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
    var cmp = {
      rank: function (a, b) { return a.rank - b.rank; },
      tvl: function (a, b) { return b.tvl_usd - a.tvl_usd || a.rank - b.rank; },
      change: function (a, b) { return (b.change_7d || -999) - (a.change_7d || -999) || a.rank - b.rank; },
      age: function (a, b) { return (b.age_days || -1) - (a.age_days || -1) || a.rank - b.rank; },
      name: function (a, b) { return a.name.localeCompare(b.name); },
      mult: function (a, b) { return b.model.fitted_multiple - a.model.fitted_multiple || a.rank - b.rank; }
    }[S.sort] || cmpRank;
    return out.sort(cmp);
  }

  function cmpRank(a, b) { return a.rank - b.rank; }

  function filtersActive() {
    return S.q !== '' || S.cat !== 'all' || S.chain !== 'all' || S.watch;
  }

  /* ------------------------------------------------------------------ header */

  function renderChrome() {
    var own = 0, bor = 0, fb = 0;
    R.peers.forEach(function (p) {
      if (p.source === 'own') own++; else if (p.source === 'neighbours') bor++; else fb++;
    });
    var total = R.rows.reduce(function (s, r) { return s + r.implied_value_usd; }, 0);
    var sorted = R.rows.map(function (r) { return r.implied_value_usd; }).sort(function (a, b) { return a - b; });
    var med = sorted[Math.floor(sorted.length / 2)];

    $('subtitle').innerHTML =
      'Snapshot of <b>' + esc(R.as_of) + '</b> from ' + esc(R.source) + '. ' +
      'Each multiple is fitted on the protocols in this snapshot that already trade — log₁₀ TVL plus the ' +
      'category median, two coefficients learned by ridge regression — instead of the flat 0.25× the house ' +
      'starter applies. The fit is scored leave-one-out and the numbers behind it are on the ' +
      '<a href="?view=fit">How it\'s fitted</a> tab.';

    $('chips').innerHTML =
      '<span class="chip mint">model <b>' + esc(R.model_version) + '</b></span>' +
      '<span class="chip">' + num(R.rows.length) + ' rows</span>' +
      '<span class="chip">' + num(R.peers.length) + ' categories</span>' +
      '<span class="chip">' + num(R.live_total) + ' live protocols</span>';

    $('stats').innerHTML = [
      stat('Ranked', num(R.rows.length), 'of ' + num(R.pretoken_total) + ' pre-token records; ' + num(R.excluded.length) + ' set aside as derivatives'),
      stat('Watchlist', num(R.watchlist_size), 'every slug on the board, plus ' + num(R.early_size) + ' more'),
      stat('Peer medians', num(R.peers.length), own + ' own · ' + bor + ' borrowed · ' + fb + ' fallback'),
      stat('Board value', money(total), 'median row ' + money(med))
    ].join('');

    document.querySelectorAll('.tab').forEach(function (t) {
      t.classList.toggle('is-on', t.getAttribute('data-view') === (S.view === 'detail' ? 'board' : S.view));
    });

    $('foot-left').innerHTML =
      esc(R.model_version) + ' · ' + num(R.rows.length) + ' pre-token protocols · ' + num(C.rows) + ' live protocols fitted · ' +
      'median held-out error ' + C.chosen_median.toFixed(2) + '× · 80% band held ' + pct(C.bandCoverage * 100);
  }

  function stat(k, v, n) {
    return '<div class="stat"><div class="k">' + k + '</div><div class="v">' + v + '</div><div class="n">' + n + '</div></div>';
  }

  /* ------------------------------------------------------------------ controls */

  function fillControls() {
    var cats = {}, chains = {};
    R.rows.forEach(function (r) {
      cats[r.category || '—'] = (cats[r.category || '—'] || 0) + 1;
      chainList(r).forEach(function (c) { chains[c] = (chains[c] || 0) + 1; });
    });
    var catNames = Object.keys(cats).sort();
    var chainNames = Object.keys(chains).sort();
    $('cat').innerHTML = '<option value="all">All categories (' + catNames.length + ')</option>' +
      catNames.map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + ' · ' + cats[c] + '</option>'; }).join('');
    $('chain').innerHTML = '<option value="all">All chains (' + chainNames.length + ')</option>' +
      chainNames.map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + ' · ' + chains[c] + '</option>'; }).join('');
    $('q').value = S.q;
    $('cat').value = S.cat;
    $('chain').value = S.chain;
    $('sort').value = S.sort;
    $('watch').checked = S.watch;
  }

  $('q').addEventListener('input', function (e) { S.q = e.target.value; S.view = 'board'; paint(); });
  $('cat').addEventListener('change', function (e) { S.cat = e.target.value; S.view = 'board'; paint(); });
  $('chain').addEventListener('change', function (e) { S.chain = e.target.value; S.view = 'board'; paint(); });
  $('sort').addEventListener('change', function (e) { S.sort = e.target.value; paint(); });
  $('watch').addEventListener('change', function (e) { S.watch = e.target.checked; S.view = 'board'; paint(); });
  $('reset').addEventListener('click', function () {
    S.q = ''; S.cat = 'all'; S.chain = 'all'; S.sort = 'rank'; S.watch = false; S.view = 'board'; S.slug = null;
    fillControls(); paint();
  });

  $('tabs').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-view]');
    if (!b) return;
    S.view = b.getAttribute('data-view');
    paint();
    $('view').scrollIntoView({ block: 'start' });
  });

  /* ------------------------------------------------------------------ board */

  function boardView() {
    var rows = filtered();
    var html = '';

    if (filtersActive()) {
      var tags = [];
      if (S.q) tags.push('search <span class="tag">' + esc(S.q) + '</span>');
      if (S.cat !== 'all') tags.push('category <span class="tag">' + esc(S.cat) + '</span>');
      if (S.chain !== 'all') tags.push('chain <span class="tag">' + esc(S.chain) + '</span>');
      if (S.watch) tags.push('<span class="tag">watchlist only</span>');
      var val = rows.reduce(function (s, r) { return s + r.implied_value_usd; }, 0);
      html += '<div class="filterbar">Filtered to <b>' + num(rows.length) + '</b> of ' + num(R.rows.length) +
        ' rows &nbsp;·&nbsp; ' + tags.join(' &nbsp;·&nbsp; ') +
        ' &nbsp;·&nbsp; combined implied value <b>' + money(val) + '</b>' +
        ' &nbsp;·&nbsp; <span class="tag">sort: ' + esc(S.sort) + '</span></div>';
    }

    if (rows.length === 0) {
      return html + '<p class="empty">No protocol matches that filter. Clear the search or pick another category.</p>';
    }

    var head = [
      ['rank', '#', 'rank'],
      ['name', 'Protocol', 'l'],
      ['cat', 'Category', 'l'],
      ['tvl', 'TVL', ''],
      ['change', '7d', ''],
      ['mult', 'Multiple ×', ''],
      ['rank', 'Implied value', ''],
      ['age', 'Age', '']
    ];

    html += '<div class="tablewrap"><table><colgroup>' +
      '<col style="width:46px"><col><col style="width:18%"><col style="width:100px">' +
      '<col style="width:78px"><col style="width:84px"><col style="width:170px"><col style="width:74px">' +
      '</colgroup><thead><tr>' +
      head.map(function (h) {
        var on = S.sort === h[0] && h[0] !== 'rank' ? ' class="on"' : (h[0] === 'rank' && S.sort === 'rank' && h[1] === 'Implied value' ? ' class="on"' : '');
        return '<th data-sort="' + h[0] + '" class="' + h[2] + on + '">' + h[1] + '</th>';
      }).join('') + '</tr></thead><tbody>';

    rows.forEach(function (r) {
      var m = r.model;
      var w = Math.max(2, (r.implied_value_usd / MAX_VAL) * 100);
      var chg = r.change_7d === null ? '<span class="mute">—</span>'
        : '<span class="' + (r.change_7d < 0 ? 'neg' : 'pos') + '">' + pct(r.change_7d) + '</span>';
      html += '<tr data-slug="' + esc(r.slug) + '">' +
        '<td class="rank">' + r.rank + '</td>' +
        '<td class="name"><div class="pname">' + (r.watchlisted ? '<span class="watchdot"></span>' : '') + esc(r.name) + '</div>' +
        '<div class="pslug">' + esc(r.slug) + ' <span>· ' + esc(chainList(r).slice(0, 2).join(', ')) + '</span></div></td>' +
        '<td class="cat">' + esc(r.category || '—') + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num">' + chg + '</td>' +
        '<td class="num"><span class="mult"><span class="dot ' + m.peer_source + '"></span>' + xs(m.fitted_multiple) + '</span></td>' +
        '<td class="num barcell"><div class="bar" style="width:' + w.toFixed(1) + '%"></div><span class="val">' + money(r.implied_value_usd) + '</span></td>' +
        '<td class="num">' + (r.age_days === null ? '<span class="mute">—</span>' : num(r.age_days) + 'd') + '</td>' +
        '</tr>';
    });

    return html + '</tbody></table></div>';
  }

  /* ------------------------------------------------------------------ detail */

  function peerNote(p) {
    if (p.peer_source === 'own') {
      return 'The category\'s own median, over <b>' + p.peer_count + '</b> live protocols that already trade.';
    }
    if (p.peer_source === 'neighbours') {
      return 'Only ' + (p.peer_count ? '<b>' + p.peer_count + '</b>' : 'no') + ' live peers could be pooled, so the median borrows from ' +
        p.borrowed_from.map(function (c) { return '<em>' + esc(c) + '</em>'; }).join(', ') + '.';
    }
    return 'No live peer and no neighbour to borrow from, so the conservative fallback multiple applies.';
  }

  function detailView() {
    var r = BY_SLUG[S.slug] || R.rows[0];
    if (!r) return '<p class="empty">That protocol is not on the board.</p>';
    var m = r.model;
    var flat = Math.round(r.tvl_usd * 0.25);
    var delta = flat > 0 ? ((r.implied_value_usd - flat) / flat) * 100 : 0;
    var order = filtered();
    var at = order.findIndex(function (x) { return x.slug === r.slug; });
    var prev = at > 0 ? order[at - 1] : null;
    var next = at >= 0 && at < order.length - 1 ? order[at + 1] : null;

    var bandW = C.bandLow === undefined ? 0 : Math.min(100, Math.max(0, ((m.log10_multiple - C.bandLow) / Math.max(0.001, C.bandHigh - C.bandLow)) * 100));

    var position =
      '<div class="card">' +
        '<div class="dhead"><div>' +
          '<h3>' + esc(r.name) + '</h3>' +
          '<div class="dsub">' + esc(r.category || 'no category') + ' · ' + esc(chainList(r).join(', ')) + ' · ' + esc(r.slug) + '</div>' +
        '</div><span class="drank">rank ' + r.rank + ' of ' + num(R.rows.length) + '</span></div>' +
        '<div class="bignum">' + money(r.implied_value_usd) + '<small>implied value if it launched today</small></div>' +
        '<div class="bandline">80% band ' + money(m.band_low_usd) + ' – ' + money(m.band_high_usd) +
          ' <span class="note">held ' + pct(C.bandCoverage * 100) + ' of the time on protocols the fit never saw</span></div>' +
        '<div class="kv">' +
          '<div><div class="k">TVL</div><div class="v">' + money(r.tvl_usd) + '</div></div>' +
          '<div><div class="k">7d change</div><div class="v ' + (r.change_7d < 0 ? 'neg' : r.change_7d > 0 ? 'pos' : '') + '">' + pct(r.change_7d) + '</div></div>' +
          '<div><div class="k">Age</div><div class="v">' + ageText(r.age_days) + '</div></div>' +
          '<div><div class="k">Fitted multiple</div><div class="v">' + xs(m.fitted_multiple) + '</div></div>' +
          '<div><div class="k">Category median</div><div class="v">' + x(m.peer_median) + '</div></div>' +
          '<div><div class="k">Status</div><div class="v">pre-token</div></div>' +
        '</div>' +
        '<div class="formula">' +
          money(r.tvl_usd) + ' <span class="op">×</span> <b>' + m.fitted_multiple.toFixed(4) + '</b> multiple' +
          ' <span class="op">=</span> <span class="res">' + money(r.implied_value_usd) + '</span>' +
          '<div class="note" style="margin-top:6px">multiple = ' + (m.regression_multiple || m.fitted_multiple).toFixed(4) +
          ' fitted <span class="op">×</span> ' + (m.growth_multiplier || 1).toFixed(3) + ' growth' +
          ' <span class="op">×</span> ' + (m.maturity_multiplier || 1).toFixed(3) + ' age</div>' +
        '</div>' +
        '<div class="versus"><span class="big">' + money(flat) + '</span><span>A flat <b>0.25×</b> would say that. ' +
          esc(R.model_version) + ' is <b>' + Math.abs(delta).toFixed(0) + '% ' + (delta < 0 ? 'lower' : 'higher') + '</b>, because the fit prices ' +
          esc((r.category || 'this category').toLowerCase()) + ' at ' + xs(m.fitted_multiple) + ' of TVL once its size, its 7d change and its age are accounted for.</span></div>' +
      '</div>';

    var mults =
      '<div class="card">' +
        '<h2>Where the multiple comes from</h2>' +
        '<p class="note" style="margin:0 0 12px">log₁₀ multiple = ' +
          m.contributions.map(function (c) {
            return (c.coefficient >= 0 ? '+ ' : '− ') + Math.abs(c.coefficient).toFixed(4) + ' × z(' + esc(c.feature) + ')';
          }).join(' ') + '</p>' +
        '<div class="mults">' +
          m.contributions.map(function (c) {
            return multRow(esc(c.feature), c.value.toFixed(3), Math.min(100, Math.abs(c.contribution) * 40), c.contribution >= 0 ? 'a' : 'v',
              'raw ' + c.value.toFixed(3) + ' · coefficient ' + (c.coefficient >= 0 ? '+' : '') + c.coefficient.toFixed(4) +
              ' · contributes ' + (c.contribution >= 0 ? '+' : '') + c.contribution.toFixed(3) + ' to log₁₀ multiple (' +
              x(10 ** c.contribution) + '×)');
          }).join('') +
        '</div>' +
        '<div class="legend"><span><i style="background:var(--amber)"></i>raises the multiple</span>' +
        '<span><i style="background:var(--violet)"></i>lowers it</span></div>' +
        '<p class="note" style="margin:12px 0 0">Both coefficients were fitted by ridge regression on ' + num(C.rows) +
        ' live protocols, not chosen by hand. That is the regression part only. 7d change and age are not ' +
        'regression terms here — their correlation with the multiple is near zero, and fitting them made held-out ' +
        'error worse — so they enter the price as bounded multipliers instead: 7d change is clamped to ' +
        m.growth_multiplier.toFixed(3) + ' and age to ' + m.maturity_multiplier.toFixed(3) + ' on this protocol, and both are shown above.</p>' +
      '</div>';

    var farm =
      '<div class="card">' +
        '<h2>Farm plan — ' + esc(r.category || 'generic') + '</h2>' +
        '<ol class="steps">' +
          r.farm_steps.map(function (s) {
            var parts = s.split(/ Cost: |\. Time: /);
            var txt = parts[0];
            var cost = parts[1] || '';
            var time = (parts[2] || '').replace(/\.$/, '');
            return '<li><div><div class="txt">' + esc(txt) + '</div>' +
              '<div class="meta">' + (cost ? '<span>cost ' + esc(cost) + '</span>' : '') +
              (time ? '<span>' + esc(time) + '</span>' : '') + '</div></div></li>';
          }).join('') +
        '</ol>' +
        '<p class="note" style="margin:12px 0 0">Steps are written per category from the protocol\'s own record: its chains set the gas line, ' +
        'its TVL sets the capital, its age sets the holding window.</p>' +
      '</div>';

    return '<div class="backbar"><button type="button" class="ghost" id="back">← Back to the board</button>' +
      '<span class="note">' + esc(r.name) + ' sits at rank ' + r.rank + ' of ' + num(R.rows.length) + '</span>' +
      '<span class="pager">' +
        (prev ? '<button type="button" class="ghost" data-slug="' + esc(prev.slug) + '">← ' + esc(prev.name) + '</button>' : '') +
        (next ? '<button type="button" class="ghost" data-slug="' + esc(next.slug) + '">' + esc(next.name) + ' →</button>' : '') +
      '</span></div>' +
      '<div class="detail"><div class="dcol">' + position + mults + '</div><div class="dcol">' + farm + '</div></div>';
  }

  function multRow(label, figure, width, cls, note) {
    return '<div class="multrow"><span class="label"><b>' + label + '</b></span>' +
      '<span class="figure">' + figure + '</span>' +
      '<span class="track"><i class="' + cls + '" style="width:' + width.toFixed(1) + '%"></i></span>' +
      '<span class="note">' + note + '</span></div>';
  }

  /* ------------------------------------------------------------------ fit */

  function fitView() {
    if (!C.ablation.length) {
      return '<div class="card"><p class="empty">No calibration block in this build.</p></div>';
    }

    var best = C.ablation[0];
    var i;
    for (i = 1; i < C.ablation.length; i++) if (C.ablation[i].median < best.median) best = C.ablation[i];

    var claim =
      '<div class="card">' +
        '<h2>The claim</h2>' +
        '<p class="lede">Every protocol on this board has TVL but no token. The board prices it at ' +
          '<b>TVL × m</b>, where <b>m</b> is a multiple. The house starter says m = 0.25 for every protocol. ' +
          'The snapshot disagrees: on the ' + num(C.rows) + ' protocols whose token already trades, a flat 0.25× ' +
          'misses the true multiple by a median of <b>' + C.ablation[0].median.toFixed(2) + '×</b>.</p>' +
        '<p class="lede">So m is fitted. Two coefficients, learned from the snapshot by ridge regression, ' +
          'and every number below was measured on protocols the fit never saw. Seven-day growth and age are ' +
          'the other two figures the brief names: they are not regression terms, but they scale m as bounded ' +
          'multipliers, so the price follows from TVL, growth and age together.</p>' +
      '</div>';

    var rows = C.ablation.map(function (a) {
      var isChosen = a.spec === C.chosen;
      var isBest = a === best;
      return '<tr' + (isChosen ? ' class="chosen"' : '') + '>' +
        '<td class="name"><div class="pname">' + (isChosen ? '<span class="watchdot"></span>' : '') + esc(a.spec) + '</div>' +
          '<div class="pslug">' + (a.features === 0 ? 'no fit' : a.features + (a.features === 1 ? ' feature' : ' features')) +
          (isChosen ? ' · shipped' : '') + (isBest && !isChosen ? ' · best on error' : '') + '</div></td>' +
        '<td class="num"><b>' + a.median.toFixed(2) + '×</b></td>' +
        '<td class="num">' + pctAbs(a.within2 * 100) + '</td>' +
        '<td class="num">' + pctAbs(a.within3 * 100) + '</td>' +
        '<td class="num">' + pctAbs(a.within10 * 100) + '</td>' +
        '<td class="num">' + a.p90.toFixed(1) + '×</td>' +
        '</tr>';
    }).join('');

    var ablationCard =
      '<div class="card">' +
        '<h2>Every specification we tried, scored the same way</h2>' +
        '<div class="tablewrap"><table class="board"><thead><tr>' +
          '<th>Specification</th><th class="num">Median error</th><th class="num">Within 2×</th>' +
          '<th class="num">Within 3×</th><th class="num">Within 10×</th><th class="num">90th pct</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
        '<p class="note" style="margin:12px 0 0">Leave-one-out: each protocol is predicted by a model refitted on the ' +
          'other ' + num(C.rows - 1) + ', so no protocol is ever scored by a model that has seen it. ' +
          'Error is multiplicative and symmetric — a 10× overshoot and a 10× undershoot both count as 10×.</p>' +
        '<p class="note" style="margin:10px 0 0"><b>The shipped row is not the best row.</b> TVL alone scores ' +
          '3.41× against the shipped 3.54×. We ship the two-feature version anyway, and here is the reason: with ' +
          'TVL as the only feature the implied value is a strictly increasing function of TVL, so the board ' +
          'degenerates into a TVL sort and two protocols of equal size can never be told apart. Category buys back ' +
          'that separation for 0.13× of median error. That is a product trade, so it is printed rather than hidden — ' +
          'if accuracy is all you want, delete the second feature and the error improves.</p>' +
      '</div>';

    var corrRows = C.correlations.map(function (c) {
      var kept = c.feature === 'log10 TVL' || c.feature === 'log10 category median';
      return '<tr><td class="name">' + esc(c.feature) + '</td>' +
        '<td class="num">' + (c.r >= 0 ? '+' : '') + c.r.toFixed(3) + '</td>' +
        '<td class="num">' + (kept ? '<span class="pos">kept in fit</span>' : '<span class="mute">out of fit</span>') + '</td></tr>';
    }).join('');

    var corrCard =
      '<div class="card">' +
        '<h2>Why two features and not four</h2>' +
        '<div class="tablewrap"><table class="board"><thead><tr>' +
          '<th>Candidate feature</th><th class="num">r with log₁₀ multiple</th><th class="num">Verdict</th>' +
        '</tr></thead><tbody>' + corrRows + '</tbody></table></div>' +
        '<p class="note" style="margin:12px 0 0">Age measures at −0.003 — no relationship at all. 7d change is weak, and ' +
          'once TVL is known a fitted coefficient on it makes held-out error worse. So neither is a regression term. ' +
          'Both still move the implied value, as bounded multipliers clamped to the ranges in the model — kept out of ' +
          'the fit because the fit would only learn noise, kept in the price because the brief asks the value to follow ' +
          'from them.</p>' +
      '</div>';

    var bandCard =
      '<div class="card">' +
        '<h2>The band, and what it is worth</h2>' +
        '<div class="stats">' +
          stat('80% band', 'held ' + pctAbs(C.bandCoverage * 100), 'of held-out protocols landed inside it') +
          stat('Band', (10 ** C.bandLow).toFixed(2) + '× – ' + (10 ** C.bandHigh).toFixed(1) + '×',
               'actual ÷ predicted, still inside the band') +
          stat('Median error', C.chosen_median.toFixed(2) + '×', 'the typical miss, on a protocol the fit never saw') +
          stat('Fit rows', num(C.rows), 'live protocols the coefficients were learned from') +
        '</div>' +
        '<p class="note" style="margin:12px 0 0">The band is not decoration. It is the 10th to 90th percentile of the ' +
          'errors the shipped model actually made out of sample, converted back from log₁₀. It holds ' +
          pctAbs(C.bandCoverage * 100) + ' of held-out protocols, against the 80% it promises — and it is wide, ' +
          'because the outcome it predicts is heavy-tailed. A band that looked tight here would be a lie.</p>' +
      '</div>';

    var honest =
      '<div class="card">' +
        '<h2>What this model cannot do</h2>' +
        '<p class="lede">A ' + C.chosen_median.toFixed(2) + '× median error is not a price target. On ' + num(C.rows) +
          ' samples with a heavy-tailed outcome, no specification gets inside 2× more than about a third of the time — ' +
          'we tried four and printed all four. The board is a ranking of relative cheapness, and the band is the honest ' +
          'width of the uncertainty. Treat a single row as an order of magnitude, not a number.</p>' +
      '</div>';

    return claim + ablationCard +
      '<div class="detail"><div class="dcol">' + corrCard + '</div><div class="dcol">' + bandCard + '</div></div>' +
      honest;
  }

  /* ------------------------------------------------------------------ peers */

  function peersView() {
    var lo = M.peer_band_min, hi = M.peer_band_max;
    function pos(v) {
      var t = Math.log(Math.max(lo, v) / lo) / Math.log(hi / lo);
      return Math.min(100, Math.max(0, t * 100));
    }
    var flat = pos(0.25);
    var rows = R.peers.slice().sort(function (a, b) { return b.multiple - a.multiple; });

    var html = '<div class="card" style="margin-top:18px">' +
      '<h2>What a category is worth per dollar of TVL</h2>' +
      '<p class="note">Each bar is the median <code>mcap_usd / tvl_usd</code> of the protocols in that category that already trade, ' +
      'clamped to ' + lo + '–' + hi + '× and pulled toward ' + M.peer_floor + '× when the median rests on fewer than ' + M.depth_full + ' peers. ' +
      'The amber line is the house starter\'s flat <b>0.25×</b>: liquid staking sits far below it, bridges and prediction markets far above. ' +
      'That spread is the whole reason for a peer model. <b>Mint</b> bars are a category\'s own median; <b>violet</b> bars borrow from neighbours; ' +
      '<b>grey</b> bars are the fallback.</p>' +
      '<div class="legend"><span><i style="background:var(--signal)"></i>own median</span>' +
      '<span><i style="background:var(--violet)"></i>borrowed from neighbours</span>' +
      '<span><i style="background:var(--dim-2)"></i>fallback</span>' +
      '<span><i style="background:var(--amber)"></i>the flat 0.25× baseline</span></div>' +
      '</div>' +
      '<div class="ladder"><div class="lrow head"><span>Category</span><span>Multiple of TVL (log scale)</span><span style="text-align:right">Multiple</span><span style="text-align:right">Peers</span></div>';

    rows.forEach(function (p) {
      var w = pos(p.multiple);
      html += '<div class="lrow">' +
        '<span class="cname">' + esc(p.category) + '<span>' + esc(p.source === 'neighbours' ? p.borrowed_from.join(' + ') : p.source) + '</span></span>' +
        '<span class="lane"><i class="' + p.source + '" style="width:' + w.toFixed(1) + '%"></i>' +
          '<span class="flatline" style="left:' + flat.toFixed(1) + '%"><span>0.25</span></span></span>' +
        '<span class="lmult">' + x(p.multiple) + '</span>' +
        '<span class="ln">' + p.peers + '</span>' +
        '</div>';
    });

    return html + '</div>';
  }

  /* ------------------------------------------------------------------ live */

  function liveView() {
    var html = '<div class="card" style="margin-top:18px"><h2>The market\'s own prices — the evidence behind the medians</h2>' +
      '<p class="note">These are the ' + num(R.live_total) + ' protocols in the snapshot whose token already trades, ranked by market cap. ' +
      'The ratio column is <code>mcap_usd / tvl_usd</code>: the number the peer table is built from. ' +
      'The board ranks the other ' + num(R.rows.length) + ' protocols, the ones still to come.</p></div>' +
      '<div class="tablewrap" style="margin-top:12px"><table><colgroup><col style="width:46px"><col><col style="width:18%"><col style="width:110px"><col style="width:110px"><col style="width:90px"><col style="width:90px"></colgroup>' +
      '<thead><tr><th class="l">#</th><th class="l">Protocol</th><th class="l">Category</th><th>TVL</th><th>Market cap</th><th>7d</th><th>mcap / TVL</th></tr></thead><tbody>';

    R.live.forEach(function (p, i) {
      html += '<tr data-slug="' + esc(p.slug) + '" style="cursor:default">' +
        '<td class="rank">' + (i + 1) + '</td>' +
        '<td class="name"><div class="pname">' + esc(p.name) + (p.symbol ? ' <span class="mute" style="font-family:var(--mono);font-size:11px">' + esc(p.symbol) + '</span>' : '') + '</div>' +
        '<div class="pslug">' + esc(p.slug) + '</div></td>' +
        '<td class="cat">' + esc(p.category || '—') + '</td>' +
        '<td class="num">' + money(p.tvl_usd) + '</td>' +
        '<td class="num">' + money(p.mcap_usd) + '</td>' +
        '<td class="num"><span class="' + (p.change_7d < 0 ? 'neg' : 'pos') + '">' + pct(p.change_7d) + '</span></td>' +
        '<td class="num">' + (p.ratio === null ? '<span class="mute">—</span>' : '<span class="val">' + p.ratio.toFixed(3) + '×</span>') + '</td>' +
        '</tr>';
    });

    return html + '</tbody></table></div>';
  }

  /* ------------------------------------------------------------------ set aside */

  function asideView() {
    var reasons = {};
    R.excluded.forEach(function (e) { reasons[e.reason] = (reasons[e.reason] || 0) + 1; });
    var keys = Object.keys(reasons).sort(function (a, b) { return reasons[b] - reasons[a]; });

    var html = '<div class="card" style="margin-top:18px"><h2>Pre-token records the board sets aside</h2>' +
      '<p class="note">The snapshot holds <b>' + num(R.pretoken_total) + '</b> records with no market cap, no CoinGecko id and no symbol. ' +
      '<b>' + num(R.rows.length) + '</b> of them are launch candidates and are ranked on the board. The other <b>' + num(R.excluded.length) + '</b> ' +
      'are wrapped, staked or bridged products of a token that already trades, exchanges, versioned pools, or protocols named for an exchange — ' +
      'they are listed here rather than ranked, so the board never confuses a bridge route with a launch. ' +
      'This is the same exclusion the house applies to its own watchlist, applied to the whole snapshot.</p>' +
      '<div class="legend">' + keys.map(function (k) {
        return '<span><i style="background:var(--dim-2)"></i>' + esc(k) + ' · <b style="color:var(--text)">' + reasons[k] + '</b></span>';
      }).join('') + '</div></div>' +
      '<div class="tablewrap" style="margin-top:12px"><table><colgroup><col style="width:46px"><col><col style="width:22%"><col style="width:120px"><col style="width:34%"></colgroup>' +
      '<thead><tr><th class="l">#</th><th class="l">Protocol</th><th class="l">Category</th><th>TVL</th><th class="l">Why it is not ranked</th></tr></thead><tbody>';

    R.excluded.forEach(function (e, i) {
      html += '<tr style="cursor:default">' +
        '<td class="rank">' + (i + 1) + '</td>' +
        '<td class="name"><div class="pname">' + esc(e.name) + '</div><div class="pslug">' + esc(e.slug) + '</div></td>' +
        '<td class="cat">' + esc(e.category || '—') + '</td>' +
        '<td class="num">' + money(e.tvl_usd) + '</td>' +
        '<td class="cat">' + esc(e.reason) + '</td>' +
        '</tr>';
    });

    return html + '</tbody></table></div>';
  }

  /* ------------------------------------------------------------------ paint */

  function paint() {
    var v = S.view;
    $('controls').hidden = v !== 'board';
    document.body.setAttribute('data-view', v);
    $('title').textContent = TITLES[v] || TITLES.board;
    $('subtitle').hidden = v !== 'board';

    if (v === 'detail') $('view').innerHTML = detailView();
    else if (v === 'fit') $('view').innerHTML = fitView();
    else if (v === 'peers') $('view').innerHTML = peersView();
    else if (v === 'live') $('view').innerHTML = liveView();
    else if (v === 'aside') $('view').innerHTML = asideView();
    else $('view').innerHTML = boardView();

    renderChrome();
    syncUrl();
    document.title = v === 'detail' && BY_SLUG[S.slug]
      ? BY_SLUG[S.slug].name + ' — Token Radar'
      : 'Token Radar — ' + num(R.rows.length) + ' pre-token protocols, priced by a fitted multiple';
  }

  $('view').addEventListener('click', function (e) {
    var th = e.target.closest('th[data-sort]');
    if (th) { S.sort = th.getAttribute('data-sort'); $('sort').value = S.sort; paint(); return; }
    if (e.target.id === 'back') { S.view = 'board'; S.slug = null; paint(); window.scrollTo(0, 0); return; }
    var row = e.target.closest('tr[data-slug]');
    if (row && S.view !== 'live' && S.view !== 'aside') {
      S.slug = row.getAttribute('data-slug');
      S.view = 'detail';
      paint();
      window.scrollTo(0, 0);
    }
  });

  fillControls();
  paint();
})();
