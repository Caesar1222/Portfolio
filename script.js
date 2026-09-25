/* Cesar Batrez-Delatorre — site scripts */
(function () {
  'use strict';

  /* ---------- Navigation ---------- */
  var nav = document.getElementById('site-nav');
  var toggle = nav.querySelector('.menu-toggle');
  var menu = document.getElementById('nav-links');

  function onScroll() { nav.classList.toggle('is-scrolled', window.scrollY > 24); }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  function setMenu(open) {
    nav.classList.toggle('menu-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  }
  toggle.addEventListener('click', function () {
    setMenu(toggle.getAttribute('aria-expanded') !== 'true');
  });
  menu.addEventListener('click', function (e) { if (e.target.closest('a')) setMenu(false); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && nav.classList.contains('menu-open')) { setMenu(false); toggle.focus(); }
  });
  var wide = window.matchMedia('(min-width: 761px)');
  if (wide.addEventListener) wide.addEventListener('change', function (e) { if (e.matches) setMenu(false); });

  /* ---------- Footer year ---------- */
  var year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());

  /* ---------- Contact form → Google Sheets ---------- */
  var scriptURL = 'https://script.google.com/macros/s/AKfycbxaI4zjPji3pNnc2pMh45GXsUxJCwpdQXfGncexSAjSJUC6W1TZoc1c4irEUvsYArp3cQ/exec';
  var form = document.forms['submit-to-google-sheet'];
  if (form) {
    var status = document.getElementById('form-status');
    var submit = form.querySelector('button[type="submit"]');
    var clearTimer = 0;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      clearTimeout(clearTimer);
      submit.disabled = true;
      submit.textContent = 'Sending…';
      status.className = 'form-status';
      status.textContent = '';
      fetch(scriptURL, { method: 'POST', body: new FormData(form) })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          form.reset();
          status.classList.add('is-success');
          status.textContent = 'Message sent. Thanks for reaching out.';
          clearTimer = setTimeout(function () { status.textContent = ''; }, 8000);
        })
        .catch(function () {
          status.classList.add('is-error');
          status.textContent = "Your message didn't send. Check your connection and try again, or email me directly.";
        })
        .then(function () {
          submit.disabled = false;
          submit.textContent = 'Send message';
        });
    });
  }

  /* ---------- Hero: live shortest routes (Dijkstra) ---------- */
  var hero = document.querySelector('.hero');
  var canvas = document.getElementById('route-canvas');
  if (!hero || !canvas || !canvas.getContext) return;
  var ctx = canvas.getContext('2d');
  var readout = document.getElementById('route-readout');
  var rerouteBtn = document.getElementById('reroute');
  var still = window.matchMedia('(prefers-reduced-motion: reduce)');

  var EDGE = '122,160,220', TREE = '91,149,245', ROUTE = '#f76900', ROUTE_RGB = '247,105,0', INK = '#0b1526';

  var W = 0, H = 0, lastW = 0, lastH = 0;
  var nodes = [], edges = [], adj = [];
  var source = -1, target = -1;
  var anim = null, hover = -1, raf = 0;

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function ease(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  function sizeCanvas() {
    var r = hero.getBoundingClientRect();
    W = r.width; H = r.height;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // Areas the network must route around: every line of text in the hero, plus the nav bar.
  function avoidRects() {
    var hr = hero.getBoundingClientRect();
    var pad = W < 600 ? 14 : 24;
    var rects = [];
    hero.querySelectorAll('[data-avoid]').forEach(function (el) {
      Array.prototype.forEach.call(el.getClientRects(), function (r) {
        if (!r.width || !r.height) return;
        rects.push({ x: r.left - hr.left - pad, y: r.top - hr.top - pad, w: r.width + pad * 2, h: r.height + pad * 2 });
      });
    });
    // A strip beside text that's too narrow for a real network becomes part of the no-go zone.
    // On phones that means every line of text spans the full width.
    var gutter = W < 600 ? W : 120, top = nav.offsetHeight, vgutter = 120;
    rects.forEach(function (r) {
      if (r.x < gutter) { r.w += r.x + 1e4; r.x = -1e4; }
      if (W - (r.x + r.w) < gutter) r.w = 3e4;
      if (r.y - top < vgutter) { r.h += r.y + 1e4; r.y = -1e4; }
      if (H - (r.y + r.h) < vgutter) r.h = 3e4;
    });
    rects.push({ x: -1e4, y: -1e4, w: 3e4, h: 1e4 + nav.offsetHeight + 16 });
    return rects;
  }

  function inside(x, y, r) { return x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h; }
  function isFree(x, y, rects, m) {
    if (x < m || y < m || x > W - m || y > H - m) return false;
    for (var i = 0; i < rects.length; i++) if (inside(x, y, rects[i])) return false;
    return true;
  }
  // Liang–Barsky: does segment ab touch rectangle r?
  function segHitsRect(a, b, r) {
    var t0 = 0, t1 = 1, dx = b.x - a.x, dy = b.y - a.y;
    var p = [-dx, dx, -dy, dy], q = [a.x - r.x, r.x + r.w - a.x, a.y - r.y, r.y + r.h - a.y];
    for (var i = 0; i < 4; i++) {
      if (p[i] === 0) { if (q[i] < 0) return false; }
      else {
        var t = q[i] / p[i];
        if (p[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
        else { if (t < t0) return false; if (t < t1) t1 = t; }
      }
    }
    return true;
  }
  function orient(o, a, b) { return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x); }
  function crosses(a, b, c, d) {
    var d1 = orient(c, d, a), d2 = orient(c, d, b), d3 = orient(a, b, c), d4 = orient(a, b, d);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  }
  function pointSegDist(p, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var t = clamp01(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  function dijkstra(s, t) {
    var n = nodes.length, d = [], pred = [], done = [], order = [], i;
    for (i = 0; i < n; i++) { d[i] = Infinity; pred[i] = -1; done[i] = false; }
    d[s] = 0;
    for (;;) {
      var u = -1, best = Infinity;
      for (i = 0; i < n; i++) if (!done[i] && d[i] < best) { best = d[i]; u = i; }
      if (u < 0) break;
      done[u] = true; order.push(u);
      if (u === t) break;
      adj[u].forEach(function (e) {
        var v = e[0], w = e[1];
        if (!done[v] && d[u] + w < d[v]) { d[v] = d[u] + w; pred[v] = u; }
      });
    }
    var path = [];
    if (t >= 0 && d[t] < Infinity) { for (var v = t; v !== -1; v = pred[v]) path.push(v); path.reverse(); }
    return { dist: d, pred: pred, order: order, path: path };
  }

  function build(intro) {
    // Fill the readout with worst-case-length text first, so the caption is measured at full height.
    readout.textContent = 'This route has 12 stops. Dijkstra\u2019s algorithm explored 44 of the 46 stops to prove it\u2019s the shortest.';
    sizeCanvas();
    lastW = W; lastH = H;
    var rects = avoidRects();
    var small = W < 600;
    var m = small ? 28 : 36, i, j, k;

    // How much room is there? Scale the stop count to it.
    var hits = 0, S = 800;
    for (i = 0; i < S; i++) if (isFree(Math.random() * W, Math.random() * H, rects, m)) hits++;
    var count = Math.max(12, Math.min(46, Math.round((W * H * hits / S) / (small ? 5200 : 15000))));

    // Best-candidate sampling gives evenly spread stops.
    var pts = [], guard = 0;
    while (pts.length < count && guard++ < count * 40) {
      var best = null, bestD = -1;
      for (k = 0; k < 16; k++) {
        var x = 0, y = 0, ok = false;
        for (var tries = 0; tries < 40 && !ok; tries++) { x = Math.random() * W; y = Math.random() * H; ok = isFree(x, y, rects, m); }
        if (!ok) continue;
        var dmin = Infinity;
        for (j = 0; j < pts.length; j++) { var dd = (pts[j].x - x) * (pts[j].x - x) + (pts[j].y - y) * (pts[j].y - y); if (dd < dmin) dmin = dd; }
        if (dmin > bestD) { bestD = dmin; best = { x: x, y: y }; }
      }
      if (best) pts.push(best);
    }
    var n = pts.length;
    if (n < 4) { nodes = []; edges = []; adj = []; anim = null; draw(performance.now()); return; }

    // Greedy planar network: shortest links first, no crossings, at most 3 links per stop.
    var nn = pts.map(function (p, a) { var d = Infinity; for (var b = 0; b < n; b++) if (b !== a) d = Math.min(d, dist(p, pts[b])); return d; });
    var med = nn.slice().sort(function (a, b) { return a - b; })[n >> 1];
    var cand = [];
    for (i = 0; i < n; i++) for (j = i + 1; j < n; j++) cand.push([i, j, dist(pts[i], pts[j])]);
    cand.sort(function (a, b) { return a[2] - b[2]; });

    var deg = pts.map(function () { return 0; });
    var E = [];
    function valid(a, b, strict) {
      var A = pts[a], B = pts[b], r;
      for (r = 0; r < rects.length; r++) if (segHitsRect(A, B, rects[r])) return false;
      if (strict) {
        for (r = 0; r < E.length; r++) if (crosses(A, B, pts[E[r][0]], pts[E[r][1]])) return false;
        for (r = 0; r < n; r++) if (r !== a && r !== b && pointSegDist(pts[r], A, B) < 10) return false;
      }
      return true;
    }
    for (i = 0; i < cand.length; i++) {
      var c = cand[i];
      if (c[2] > med * 2.3) break;
      if (deg[c[0]] >= 3 || deg[c[1]] >= 3) continue;
      if (!valid(c[0], c[1], true)) continue;
      E.push(c); deg[c[0]]++; deg[c[1]]++;
    }

    // Join any separate pieces with the shortest link that still avoids the text.
    var parent = pts.map(function (_, a) { return a; });
    function find(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }
    E.forEach(function (e) { parent[find(e[0])] = find(e[1]); });
    function pieces() { var s = {}; for (var a = 0; a < n; a++) s[find(a)] = 1; return Object.keys(s).length; }
    [true, false].forEach(function (strict) {
      var changed = true;
      while (pieces() > 1 && changed) {
        changed = false;
        for (var q = 0; q < cand.length; q++) {
          var e = cand[q];
          if (find(e[0]) === find(e[1]) || !valid(e[0], e[1], strict)) continue;
          E.push(e); parent[find(e[0])] = find(e[1]); changed = true; break;
        }
      }
    });

    // Keep the largest connected piece.
    var size = {};
    for (i = 0; i < n; i++) { var root = find(i); size[root] = (size[root] || 0) + 1; }
    var main = -1, mainSize = -1;
    Object.keys(size).forEach(function (key) { if (size[key] > mainSize) { mainSize = size[key]; main = +key; } });
    var remap = [], kept = [];
    for (i = 0; i < n; i++) { remap[i] = -1; if (find(i) === main) { remap[i] = kept.length; kept.push(pts[i]); } }
    nodes = kept;
    edges = E.filter(function (e) { return remap[e[0]] >= 0 && remap[e[1]] >= 0; })
             .map(function (e) { return [remap[e[0]], remap[e[1]], e[2]]; });
    adj = nodes.map(function () { return []; });
    edges.forEach(function (e) { adj[e[0]].push([e[1], e[2]]); adj[e[1]].push([e[0], e[2]]); });

    // Open with a mid-length trip that starts near the bottom right: long enough to show the
    // search spreading out, short enough that Dijkstra stops before exploring everything.
    source = 0;
    var sd = Infinity;
    nodes.forEach(function (p, idx) { var d = Math.hypot(W - p.x, H - p.y); if (d < sd) { sd = d; source = idx; } });
    var full = dijkstra(source, -1);
    var byDist = nodes.map(function (_, idx) { return idx; })
      .filter(function (idx) { return idx !== source && full.dist[idx] < Infinity; })
      .sort(function (a, b) { return full.dist[a] - full.dist[b]; });
    var from = Math.floor(byDist.length * 0.45), to = Math.max(from + 1, Math.ceil(byDist.length * 0.7));
    var pick = byDist[byDist.length - 1], pickD = -1;
    for (i = from; i < to && i < byDist.length; i++) {
      var e = dist(nodes[byDist[i]], nodes[source]);
      if (e > pickD) { pickD = e; pick = byDist[i]; }
    }
    hover = -1;
    startRoute(pick, intro);
  }

  function startRoute(t, intro) {
    target = t;
    var r = dijkstra(source, target);
    var calm = still.matches;
    var settleAt = nodes.map(function () { return Infinity; });
    r.order.forEach(function (v, idx) { settleAt[v] = idx; });
    var seg = [], cum = [0], total = 0, pathIndex = {};
    for (var i = 0; i < r.path.length - 1; i++) {
      var d = dist(nodes[r.path[i]], nodes[r.path[i + 1]]);
      seg.push(d); total += d; cum.push(total);
    }
    r.path.forEach(function (v, idx) { pathIndex[v] = idx; });
    anim = {
      order: r.order, pred: r.pred, path: r.path, settleAt: settleAt,
      seg: seg, cum: cum, total: total, pathIndex: pathIndex,
      fade: intro && !calm,
      lead: intro && !calm ? 600 : 0,
      explore: calm ? 0 : Math.min(intro ? 1800 : 950, r.order.length * (intro ? 60 : 32)),
      route: calm ? 0 : Math.min(intro ? 1200 : 800, 250 + r.path.length * (intro ? 70 : 55)),
      settle: calm ? 0 : 700,
      t0: performance.now()
    };
    readout.textContent = 'This route has ' + r.path.length + ' stops. Dijkstra\u2019s algorithm explored ' +
      r.order.length + ' of the ' + nodes.length + ' stops to prove it\u2019s the shortest.';
    kick();
  }

  function kick() { if (!raf) raf = requestAnimationFrame(frame); }
  function frame(now) {
    raf = 0;
    draw(now);
    if (anim && now < anim.t0 + anim.lead + anim.explore + anim.route + anim.settle + 40) kick();
  }

  function draw(now) {
    ctx.clearRect(0, 0, W, H);
    if (!nodes.length) return;
    var A = anim, i;
    var t = A ? now - A.t0 - A.lead : Infinity;
    var fade = A && A.fade ? clamp01((now - A.t0) / A.lead) : 1;
    var k = !A ? 0 : A.explore ? A.order.length * clamp01(t / A.explore) : (t >= 0 ? A.order.length : 0);
    var rp = !A ? 0 : A.route ? ease(clamp01((t - A.explore) / A.route)) : (t >= A.explore ? 1 : 0);
    var dim = !A ? 0 : A.settle ? clamp01((t - A.explore - A.route) / A.settle) : (t >= A.explore + A.route ? 1 : 0);

    // All links
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(' + EDGE + ',' + (0.26 * fade) + ')';
    ctx.beginPath();
    edges.forEach(function (e) { ctx.moveTo(nodes[e[0]].x, nodes[e[0]].y); ctx.lineTo(nodes[e[1]].x, nodes[e[1]].y); });
    ctx.stroke();

    // Shortest-path tree, growing as Dijkstra settles each stop
    if (A && k > 0) {
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(' + TREE + ',' + (0.8 - 0.5 * dim) + ')';
      ctx.beginPath();
      var limit = Math.min(A.order.length, Math.ceil(k));
      for (i = 1; i < limit; i++) {
        var v = A.order[i], u = A.pred[v];
        var p = clamp01(k - i);
        if (u < 0 || p <= 0) continue;
        ctx.moveTo(nodes[u].x, nodes[u].y);
        ctx.lineTo(nodes[u].x + (nodes[v].x - nodes[u].x) * p, nodes[u].y + (nodes[v].y - nodes[u].y) * p);
      }
      ctx.stroke();
    }

    // The route
    var reached = A ? A.total * rp : 0;
    if (A && A.path.length > 1 && rp > 0) {
      ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = ROUTE;
      ctx.beginPath();
      ctx.moveTo(nodes[A.path[0]].x, nodes[A.path[0]].y);
      for (i = 0; i < A.seg.length; i++) {
        var a = nodes[A.path[i]], b = nodes[A.path[i + 1]];
        if (A.cum[i + 1] <= reached) { ctx.lineTo(b.x, b.y); continue; }
        var f = (reached - A.cum[i]) / A.seg[i];
        ctx.lineTo(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f);
        break;
      }
      ctx.stroke();
    }

    // Stops
    for (i = 0; i < nodes.length; i++) {
      var n = nodes[i], r = 3, fill = INK, stroke = 'rgba(154,171,196,' + (0.8 * fade) + ')';
      if (A && A.settleAt[i] < Infinity && k - A.settleAt[i] >= 1) {
        fill = stroke = 'rgba(' + TREE + ',' + (1 - 0.4 * dim) + ')';
      }
      if (A && rp > 0 && A.pathIndex[i] !== undefined && A.cum[A.pathIndex[i]] <= reached + 0.01) {
        fill = stroke = ROUTE; r = 3.6;
      }
      ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = fill; ctx.fill();
      ctx.lineWidth = 1.2; ctx.strokeStyle = stroke; ctx.stroke();
    }

    if (A) {
      // Start: a ring
      var s = nodes[source];
      ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(' + ROUTE_RGB + ',' + fade + ')';
      ctx.beginPath(); ctx.arc(s.x, s.y, 8, 0, Math.PI * 2); ctx.stroke();
      // Destination: hollow while searching, filled on arrival
      var d = nodes[target], arrived = rp >= 1;
      ctx.beginPath(); ctx.arc(d.x, d.y, arrived ? 6 : 5, 0, Math.PI * 2);
      if (arrived) { ctx.fillStyle = ROUTE; ctx.fill(); }
      ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(' + ROUTE_RGB + ',' + fade + ')'; ctx.stroke();
      if (arrived) {
        ctx.beginPath(); ctx.arc(d.x, d.y, 12, 0, Math.PI * 2);
        ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(' + ROUTE_RGB + ',0.4)'; ctx.stroke();
      }
    }

    if (hover >= 0 && hover !== target) {
      var h = nodes[hover];
      ctx.beginPath(); ctx.arc(h.x, h.y, 10, 0, Math.PI * 2);
      ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(233,238,246,0.85)'; ctx.stroke();
    }
  }

  function localPoint(e) { var r = hero.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function nearest(x, y, within) {
    var best = -1, bd = within;
    nodes.forEach(function (p, i) { var d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = i; } });
    return best;
  }

  hero.addEventListener('pointermove', function (e) {
    if (e.pointerType === 'touch') return;
    var pt = localPoint(e), i = nearest(pt.x, pt.y, 22);
    if (i !== hover) { hover = i; hero.classList.toggle('is-pointing', i >= 0); kick(); }
  });
  hero.addEventListener('pointerleave', function () {
    if (hover !== -1) { hover = -1; hero.classList.remove('is-pointing'); kick(); }
  });
  hero.addEventListener('click', function (e) {
    if (e.target.closest('a, button')) return;
    var pt = localPoint(e), i = nearest(pt.x, pt.y, 30);
    if (i >= 0 && i !== target) { source = target; startRoute(i, false); }
  });

  rerouteBtn.addEventListener('click', function () {
    if (nodes.length < 2) return;
    var r = dijkstra(target, -1);
    var others = nodes.map(function (_, i) { return i; })
      .filter(function (i) { return i !== target && r.dist[i] < Infinity; })
      .sort(function (a, b) { return r.dist[b] - r.dist[a]; });
    var pool = others.slice(0, Math.max(1, Math.ceil(others.length / 2)));
    source = target;
    startRoute(pool[Math.floor(Math.random() * pool.length)], false);
  });

  var resizeTimer = 0;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      var r = hero.getBoundingClientRect();
      if (Math.abs(r.width - lastW) > 30 || Math.abs(r.height - lastH) > 140) build(false);
      else { sizeCanvas(); draw(performance.now()); }
    }, 200);
  });

  // Wait for the display font so the network routes around the real text.
  var started = false;
  function start() { if (!started) { started = true; build(true); } }
  if (document.fonts && document.fonts.load) {
    Promise.all([
      document.fonts.load('400 100px "Modern Roman Display"'),
      document.fonts.load('400 20px "Modern Sans"'),
      document.fonts.load('400 16px "Modern Roman"')
    ]).then(start, start);
    setTimeout(start, 1500);
  } else {
    start();
  }
})();
