/* Generic architecture viewer. Knows nothing about any particular project: it renders whatever
   architecture.json (embedded in index.html) describes. No dependencies. */
(function () {
  'use strict';

  var dataEl = document.getElementById('arch-data');
  var DATA;
  try { DATA = JSON.parse(dataEl.textContent); } catch (e) { return; } // static fallback stays visible
  var arch = DATA.arch, snippets = DATA.snippets || {};
  var nodes = arch.nodes, edges = arch.edges, flows = arch.flows;
  var NS = 'http://www.w3.org/2000/svg';
  var reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- tiny DOM helpers (textContent only: repo content is untrusted) ----------
  function $(id) { return document.getElementById(id); }
  function h(tag, props, kids) {
    var e = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (k === 'class') e.className = props[k];
      else if (k === 'text') e.textContent = props[k];
      else if (k === 'style') e.setAttribute('style', props[k]);
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), props[k]);
      else e.setAttribute(k, props[k]);
    });
    (kids || []).forEach(function (c) { if (c) e.appendChild(c); });
    return e;
  }
  function s(tag, attrs, text) {
    var e = document.createElementNS(NS, tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text != null) e.textContent = text;
    return e;
  }
  function rich(parent, text) { // `code` spans -> <code>, everything else plain text
    parent.replaceChildren();
    String(text || '').split('`').forEach(function (part, i) {
      if (!part) return;
      parent.appendChild(i % 2 ? h('code', { text: part }) : document.createTextNode(part));
    });
  }
  function store(k, v) { try { if (v === undefined) return localStorage.getItem('gv:' + k); localStorage.setItem('gv:' + k, v); } catch (e) { /* storage unavailable */ } return null; }
  function trunc(t, n) { t = String(t == null ? '' : t); return t.length > n ? t.slice(0, n - 1) + '…' : t; }

  // ---------- kinds -> colours ----------
  var HUES = { entry: 152, ui: 265, api: 24, service: 200, data: 340, util: 175, config: 45, module: 215, test: 95 };
  function kindColor(kind) {
    if (kind === 'external') return 'hsl(220 10% 52%)';
    var hue = HUES[kind];
    if (hue == null) { hue = 0; for (var i = 0; i < kind.length; i++) hue = (hue * 31 + kind.charCodeAt(i)) % 360; }
    return 'hsl(' + hue + ' var(--ks) var(--kl))';
  }

  // ---------- layout (layered, left to right; manual `position` wins) ----------
  var LANE_HEAD = 30, KIND_ORDER = ['entry', 'ui', 'api', 'service', 'data', 'util', 'config', 'module', 'external', 'test'];
  var laneRects = [], groupMode = 'none';
  // Swimlanes can be folded: a collapsed lane shows one chip instead of its components, and every component in it shares that
  // chip's position, so edges to and from the lane simply meet at the chip.
  var collapsed = {}, laneChips = {};
  function laneKeyOf(nd) { return groupMode === 'kind' ? (nd.kind || 'module') : (nd.group || 'Other'); }
  function isHidden(id) { return groupMode !== 'none' && !!byId[id] && !!collapsed[laneKeyOf(byId[id])]; }
  function laneMembers(key) { return nodes.filter(function (nd) { return laneKeyOf(nd) === key; }); }
  var W = 196, H = 60, GX = 58, GY = 22, PAD = 30;
  function computeLayout(mode) {
    var idx = {}, n = nodes.length;
    nodes.forEach(function (nd, i) { idx[nd.id] = i; });
    var out = nodes.map(function () { return []; }), inn = nodes.map(function () { return []; });
    var es = [];
    edges.forEach(function (e) {
      if (idx[e.from] == null || idx[e.to] == null || e.from === e.to) return;
      es.push([idx[e.from], idx[e.to]]);
      out[idx[e.from]].push(idx[e.to]); inn[idx[e.to]].push(idx[e.from]);
    });
    var state = nodes.map(function () { return 0; }), back = {};
    function dfs(u) {
      state[u] = 1;
      out[u].forEach(function (v) { if (state[v] === 1) back[u + '>' + v] = 1; else if (state[v] === 0) dfs(v); });
      state[u] = 2;
    }
    nodes.forEach(function (_, i) { if (!inn[i].length && !state[i]) dfs(i); });
    nodes.forEach(function (_, i) { if (!state[i]) dfs(i); });
    var dag = es.filter(function (p) { return !back[p[0] + '>' + p[1]]; });
    var layer = nodes.map(function () { return 0; });
    for (var pass = 0; pass < n; pass++) {
      var changed = false;
      dag.forEach(function (p) { if (layer[p[1]] < layer[p[0]] + 1) { layer[p[1]] = layer[p[0]] + 1; changed = true; } });
      if (!changed) break;
    }
    var cols = [];
    nodes.forEach(function (_, i) { (cols[layer[i]] = cols[layer[i]] || []).push(i); });
    cols = cols.filter(Boolean);
    var row = {};
    cols.forEach(function (c) { c.forEach(function (i, r) { row[i] = r; }); });
    function bary(i, nbrs) {
      var v = nbrs[i].filter(function (j) { return layer[j] !== layer[i]; });
      if (!v.length) return row[i];
      return v.reduce(function (a, j) { return a + row[j]; }, 0) / v.length;
    }
    for (var it = 0; it < 4; it++) {
      for (var l = 1; l < cols.length; l++) { cols[l].sort(function (a, b) { return bary(a, inn) - bary(b, inn); }); cols[l].forEach(function (i, r) { row[i] = r; }); }
      for (l = cols.length - 2; l >= 0; l--) { cols[l].sort(function (a, b) { return bary(a, out) - bary(b, out); }); cols[l].forEach(function (i, r) { row[i] = r; }); }
    }
    var maxRows = Math.max.apply(null, cols.map(function (c) { return c.length; }).concat([1]));
    var totalH = maxRows * (H + GY) - GY;
    var boxes = {}, li = 0;
    var layerIndex = {};
    cols.forEach(function (c, ci) { c.forEach(function (i) { layerIndex[i] = ci; }); });
    laneRects = [];
    if (mode && mode !== 'none') { // swimlanes: one horizontal band per group, columns still follow dependency depth
      var laneOf = function (nd) { return mode === 'kind' ? (nd.kind || 'module') : (nd.group || 'Other'); };
      var order = [];
      nodes.forEach(function (nd) { var k = laneOf(nd); if (order.indexOf(k) < 0) order.push(k); });
      if (mode === 'kind') order.sort(function (a, b) { var ia = KIND_ORDER.indexOf(a), ib = KIND_ORDER.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b); });
      var top = PAD, laneW = cols.length * (W + GX) - GX;
      order.forEach(function (key) {
        if (collapsed[key]) {
          var members = nodes.filter(function (nd) { return laneOf(nd) === key; });
          members.forEach(function (nd) { boxes[nd.id] = { x: PAD, y: top + LANE_HEAD, w: W, h: H }; });
          var chipH = LANE_HEAD + H + 16;
          laneRects.push({ key: key, x: PAD - 16, y: top - 6, w: laneW + 32, h: chipH + 6, collapsed: true, count: members.length });
          top += chipH + 26;
          return;
        }
        var perCol = {}, rowsMax = 1;
        nodes.forEach(function (nd, i) { if (laneOf(nd) === key) (perCol[layerIndex[i]] = perCol[layerIndex[i]] || []).push(i); });
        Object.keys(perCol).forEach(function (ci) {
          perCol[ci].sort(function (a, b) { return row[a] - row[b]; });
          rowsMax = Math.max(rowsMax, perCol[ci].length);
          perCol[ci].forEach(function (i, r) {
            var nd = nodes[i], x = PAD + Number(ci) * (W + GX), y = top + LANE_HEAD + r * (H + GY);
            if (nd.position && isFinite(nd.position.x) && isFinite(nd.position.y)) { x = nd.position.x; y = nd.position.y; }
            boxes[nd.id] = { x: x, y: y, w: W, h: H };
          });
        });
        var laneH = LANE_HEAD + rowsMax * (H + GY) - GY + 16;
        laneRects.push({ key: key, x: PAD - 16, y: top - 6, w: laneW + 32, h: laneH + 6, count: null });
        top += laneH + 26;
      });
      return boxes;
    }
    cols.forEach(function (c, ci) {
      var colH = c.length * (H + GY) - GY;
      c.forEach(function (i, r) {
        var nd = nodes[i];
        var x = PAD + ci * (W + GX), y = PAD + (totalH - colH) / 2 + r * (H + GY);
        if (nd.position && isFinite(nd.position.x) && isFinite(nd.position.y)) { x = nd.position.x; y = nd.position.y; }
        boxes[nd.id] = { x: x, y: y, w: W, h: H };
      });
      li++;
    });
    return boxes;
  }

  function edgeGeom(a, b) {
    var x1, y1, x2, y2, d;
    if (b.x >= a.x + a.w + 20) {
      x1 = a.x + a.w; y1 = a.y + a.h / 2; x2 = b.x; y2 = b.y + b.h / 2;
      var dx = Math.max(40, (x2 - x1) / 2);
      d = 'M' + x1 + ',' + y1 + ' C' + (x1 + dx) + ',' + y1 + ' ' + (x2 - dx) + ',' + y2 + ' ' + x2 + ',' + y2;
    } else if (a.x >= b.x + b.w + 20) {
      x1 = a.x; y1 = a.y + a.h / 2; x2 = b.x + b.w; y2 = b.y + b.h / 2;
      var bx = Math.max(40, (x1 - x2) / 2);
      d = 'M' + x1 + ',' + y1 + ' C' + (x1 - bx) + ',' + y1 + ' ' + (x2 + bx) + ',' + y2 + ' ' + x2 + ',' + y2;
    } else {
      var down = b.y > a.y;
      x1 = a.x + a.w / 2; x2 = b.x + b.w / 2;
      y1 = down ? a.y + a.h : a.y; y2 = down ? b.y : b.y + b.h;
      var bulge = 70;
      d = 'M' + x1 + ',' + y1 + ' C' + (x1 + bulge) + ',' + (y1 + (down ? 40 : -40)) + ' ' + (x2 + bulge) + ',' + (y2 + (down ? -40 : 40)) + ' ' + x2 + ',' + y2;
      return { d: d, mx: Math.max(x1, x2) + bulge * 0.75, my: (y1 + y2) / 2 };
    }
    return { d: d, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 };
  }

  // ---------- render ----------
  var svg = $('diagram'), canvas = $('canvas');
  var boxes = {}, nodeEls = {}, edgeEls = {}, byId = {}, edgeById = {};
  nodes.forEach(function (n) { byId[n.id] = n; });
  edges.forEach(function (e) { edgeById[e.id] = e; });
  var view = { x: 0, y: 0, w: 1000, h: 600 }, userMoved = false, fitScale = 0;

  function render() {
    boxes = computeLayout(groupMode);
    svg.replaceChildren();
    var defs = s('defs');
    [['arrow', 'arrow-head'], ['arrow-a', 'arrow-head a'], ['arrow-v', 'arrow-head v']].forEach(function (m) {
      var mk = s('marker', { id: m[0], viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 11, markerHeight: 11, markerUnits: 'userSpaceOnUse', orient: 'auto' });
      mk.appendChild(s('path', { d: 'M0,0 L10,5 L0,10 z', class: m[1] }));
      defs.appendChild(mk);
    });
    svg.appendChild(defs);
    var gL = s('g', { class: 'lanes' });
    laneChips = {};
    laneRects.forEach(function (lr) {
      var name = String(lr.key);
      var g = s('g', { style: '--kc:' + kindColor(lr.key), class: 'lane-group' + (lr.collapsed ? ' collapsed' : '') });
      g.appendChild(s('rect', { class: 'lane', x: lr.x, y: lr.y, width: lr.w, height: lr.h, rx: 14 }));
      var head = s('g', { class: 'lane-head', tabindex: 0, role: 'button', 'aria-expanded': lr.collapsed ? 'false' : 'true', 'aria-label': (lr.collapsed ? 'Expand group ' : 'Collapse group ') + name });
      head.appendChild(s('rect', { class: 'lane-hit', x: lr.x + 6, y: lr.y + 4, width: Math.min(lr.w - 12, 24 + trunc(name, 40).length * 8.4 + (lr.collapsed ? 70 : 0)), height: 26, rx: 8 }));
      head.appendChild(s('text', { class: 'lane-caret', x: lr.x + 16, y: lr.y + 22 }, lr.collapsed ? '\u25B8' : '\u25BE'));
      head.appendChild(s('text', { class: 'lane-label', x: lr.x + 32, y: lr.y + 22 }, trunc(name.toUpperCase(), 40) + (lr.collapsed ? '  \u00B7  ' + lr.count : '')));
      head.title = (lr.collapsed ? 'Expand ' : 'Collapse ') + name;
      var toggle = function (ev) { ev.stopPropagation(); toggleLane(lr.key, head); };
      head.addEventListener('click', toggle);
      head.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(ev); } });
      g.appendChild(head);
      gL.appendChild(g);
    });
    svg.appendChild(gL);
    var gE = s('g', { class: 'edges' }), gN = s('g', { class: 'nodes' });
    edges.forEach(function (e) {
      var a = boxes[e.from], b = boxes[e.to];
      if (!a || !b) return;
      var geo = edgeGeom(a, b);
      var g = s('g', { class: (e.kind === 'http' ? 'edge k-http' : 'edge') + diffClass(e) + (isHidden(e.from) && isHidden(e.to) && laneKeyOf(byId[e.from]) === laneKeyOf(byId[e.to]) ? ' lane-hidden' : ''), 'data-id': e.id });
      g.appendChild(s('title', {}, e.label ? (byId[e.from].label + ' → ' + byId[e.to].label + ': ' + e.label) : ''));
      g.appendChild(s('path', { d: geo.d, class: 'hit' }));
      g.appendChild(s('path', { d: geo.d, class: 'line' }));
      if (e.label) g.appendChild(s('text', { x: geo.mx, y: geo.my - 5, 'text-anchor': 'middle' }, trunc(e.label, 34)));
      gE.appendChild(g); edgeEls[e.id] = g;
    });
    nodes.forEach(function (n) {
      var b = boxes[n.id];
      var g = s('g', { class: 'node' + diffClass(n) + (isHidden(n.id) ? ' lane-hidden' : ''), transform: 'translate(' + b.x + ',' + b.y + ')', tabindex: isHidden(n.id) ? -1 : 0, role: 'button', 'aria-label': n.label + ', ' + n.kind + '. ' + (n.summary || ''), 'data-id': n.id, style: '--kc:' + kindColor(n.kind) });
      g.appendChild(s('title', {}, n.summary || n.label));
      g.appendChild(s('rect', { class: 'box', width: b.w, height: b.h, rx: 10 }));
      g.appendChild(s('rect', { class: 'bar', x: 0, y: 12, width: 5, height: b.h - 24, rx: 2.5 }));
      g.appendChild(s('text', { class: 'lbl', x: 18, y: 26 }, trunc(n.label, 23)));
      var sub = (DIFF_MARK[n.diff] ? DIFF_MARK[n.diff] + ' ' : '') + n.kind + (n.tech && n.tech.length ? ' · ' + n.tech[0] : '');
      g.appendChild(s('text', { class: 'sub', x: 18, y: 44 }, trunc(sub, 30)));
      g.addEventListener('click', function (ev) { ev.stopPropagation(); selectNode(n.id, false); });
      g.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.stopPropagation(); selectNode(n.id, false); return; }
        var to = neighbourFor(n.id, ev.key);
        if (to === undefined) return;            // not a navigation key: let the global shortcuts run
        ev.preventDefault(); ev.stopPropagation();
        if (to && nodeEls[to]) { reveal([to]); nodeEls[to].focus(); }
      });
      gN.appendChild(g); nodeEls[n.id] = g;
    });
    laneRects.filter(function (lr) { return lr.collapsed; }).forEach(function (lr) {
      var b = boxes[laneMembers(lr.key)[0].id], name = String(lr.key);
      var chip = s('g', { class: 'node lane-chip', transform: 'translate(' + b.x + ',' + b.y + ')', tabindex: 0, role: 'button', 'aria-label': 'Group ' + name + ', ' + lr.count + ' components, collapsed. Press Enter to expand.', style: '--kc:' + kindColor(lr.key) });
      chip.appendChild(s('rect', { class: 'stack', x: 10, y: 10, width: b.w, height: b.h, rx: 10 }));
      chip.appendChild(s('rect', { class: 'stack', x: 5, y: 5, width: b.w, height: b.h, rx: 10 }));
      chip.appendChild(s('rect', { class: 'box', width: b.w, height: b.h, rx: 10 }));
      chip.appendChild(s('rect', { class: 'bar', x: 0, y: 12, width: 5, height: b.h - 24, rx: 2.5 }));
      chip.appendChild(s('text', { class: 'lbl', x: 18, y: 26 }, trunc(name, 23)));
      chip.appendChild(s('text', { class: 'sub', x: 18, y: 44 }, lr.count + ' components \u00B7 click to expand'));
      var open = function (ev) { ev.stopPropagation(); toggleLane(lr.key); };
      chip.addEventListener('click', open);
      chip.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(ev); } });
      gN.appendChild(chip); laneChips[lr.key] = { el: chip, ids: laneMembers(lr.key).map(function (m) { return m.id; }) };
    });
    svg.appendChild(gE); svg.appendChild(gN);
    svg.setAttribute('aria-label', 'Architecture diagram: ' + nodes.length + ' components and ' + edges.length + ' connections');

    var seen = {};
    var legend = $('legend'); legend.replaceChildren();
    nodes.forEach(function (n) {
      if (seen[n.kind]) return; seen[n.kind] = 1;
      var i = h('i'); i.setAttribute('style', '--kc:' + kindColor(n.kind));
      legend.appendChild(h('span', {}, [i, document.createTextNode(n.kind)]));
    });
    ['added', 'removed', 'changed'].forEach(function (d) {
      if (!nodes.some(function (n) { return n.diff === d; }) && !edges.some(function (e) { return e.diff === d; })) return;
      var k = h('i', { class: 'diff-key d-' + d });
      legend.appendChild(h('span', {}, [k, document.createTextNode(d)]));
    });
    if (edges.some(function (e) { return e.kind === 'http'; })) {
      var hl = h('i', { class: 'http-key' });
      legend.appendChild(h('span', {}, [hl, document.createTextNode('HTTP request')]));
    }
  }

  // ---------- camera ----------
  function applyView() { svg.setAttribute('viewBox', [view.x, view.y, view.w, view.h].join(' ')); }
  function bbox(ids) {
    var x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    ids.forEach(function (id) { var b = boxes[id]; if (!b) return; x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y); x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h); });
    return isFinite(x1) ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } : null;
  }
  function fit() {
    var bb = bbox(Object.keys(boxes)); if (!bb) return;
    var cw = canvas.clientWidth || 800, ch = canvas.clientHeight || 500, m = 30;
    var sc = Math.min(cw / (bb.w + 2 * m), ch / (bb.h + 2 * m), 1.25);
    fitScale = Math.min(cw / (bb.w + 2 * m), ch / (bb.h + 2 * m));
    tweenTo(bb.x + bb.w / 2 - cw / sc / 2, bb.y + bb.h / 2 - ch / sc / 2, cw / sc, ch / sc, true);
    userMoved = false;
  }
  // Smoothly move the camera (instant when the user prefers reduced motion or on first paint).
  var tweenId = 0;
  function tweenTo(x, y, w, h, instant) {
    var id = ++tweenId, from = { x: view.x, y: view.y, w: view.w, h: view.h }, t0 = null;
    if (instant || reducedMotion || !window.requestAnimationFrame || document.visibilityState === 'hidden') { view.x = x; view.y = y; view.w = w; view.h = h; applyView(); return; }
    (function step(ts) {
      if (id !== tweenId) return;
      if (t0 == null) t0 = ts;
      var p = Math.min(1, (ts - t0) / 380), k = 1 - Math.pow(1 - p, 3);
      view.x = from.x + (x - from.x) * k; view.y = from.y + (y - from.y) * k;
      view.w = from.w + (w - from.w) * k; view.h = from.h + (h - from.h) * k;
      applyView();
      if (p < 1) requestAnimationFrame(step);
    })(performance.now());
  }
  // Zoom to the active step's nodes at a readable scale (never smaller than the fit-all scale).
  // Arrow keys on a focused component: Right / Left follow a connection out / in, Up / Down move within the column.
  // Returns a node id, null when there is nowhere to go, or undefined when the key is not a navigation key.
  function neighbourFor(id, key) {
    var dirs = { ArrowRight: 'out', ArrowLeft: 'in', ArrowDown: 1, ArrowUp: -1 };
    if (!(key in dirs)) return undefined;
    var d = dirs[key], here = boxes[id];
    if (d === 'out' || d === 'in') {
      var hits = [];
      edges.forEach(function (e) {
        var other = d === 'out' ? (e.from === id ? e.to : null) : (e.to === id ? e.from : null);
        if (other && boxes[other] && !isHidden(other) && hits.indexOf(other) < 0) hits.push(other);
      });
      hits.sort(function (a, b) { return Math.abs(boxes[a].y - here.y) - Math.abs(boxes[b].y - here.y); });
      return hits[0] || null;
    }
    var col = nodes.filter(function (m) { return boxes[m.id] && !isHidden(m.id) && Math.abs(boxes[m.id].x - here.x) < 4; }).sort(function (a, b) { return boxes[a.id].y - boxes[b.id].y; });
    var i = col.findIndex(function (m) { return m.id === id; }), next = col[i + d];
    return next ? next.id : null;
  }

  function focusIds(ids) {
    var bb = bbox(ids); if (!bb) return;
    var cw = canvas.clientWidth || 800, ch = canvas.clientHeight || 500, m = 60;
    var sc = Math.max(fitScale || 0.2, Math.min(cw / (bb.w + 2 * m), ch / (bb.h + 2 * m), 1));
    var w = cw / sc, h = ch / sc;
    tweenTo(bb.x + bb.w / 2 - w / 2, bb.y + bb.h / 2 - h / 2, w, h);
  }
  function zoom(f, cx, cy) {
    var r = svg.getBoundingClientRect();
    var px = cx == null ? 0.5 : (cx - r.left) / r.width, py = cy == null ? 0.5 : (cy - r.top) / r.height;
    var nw = Math.min(Math.max(view.w / f, 200), 20000), nh = nw * (view.h / view.w);
    view.x += (view.w - nw) * px; view.y += (view.h - nh) * py; view.w = nw; view.h = nh;
    tweenId++; userMoved = true; applyView();
  }
  function reveal(ids) {
    var bb = bbox(ids); if (!bb) return;
    var inside = bb.x >= view.x && bb.y >= view.y && bb.x + bb.w <= view.x + view.w && bb.y + bb.h <= view.y + view.h;
    if (inside) return;
    if (bb.w > view.w || bb.h > view.h) { fit(); return; }
    view.x = bb.x + bb.w / 2 - view.w / 2; view.y = bb.y + bb.h / 2 - view.h / 2; applyView();
  }
  (function pan() {
    var drag = null;
    svg.addEventListener('pointerdown', function (e) {
      if (e.target.closest && e.target.closest('.node')) return;
      drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
      svg.setPointerCapture(e.pointerId); svg.classList.add('panning');
    });
    svg.addEventListener('pointermove', function (e) {
      if (!drag) return;
      tweenId++;
      var r = svg.getBoundingClientRect(), dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      view.x = drag.vx - dx * (view.w / r.width); view.y = drag.vy - dy * (view.h / r.height);
      userMoved = true; applyView();
    });
    function end() { if (drag && !drag.moved) clearSelection(); drag = null; svg.classList.remove('panning'); }
    svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end);
    svg.addEventListener('wheel', function (e) { e.preventDefault(); zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY); }, { passive: false });
  })();
  $('zoom-in').addEventListener('click', function () { zoom(1.3); });
  $('zoom-out').addEventListener('click', function () { zoom(1 / 1.3); });
  $('zoom-fit').addEventListener('click', fit);
  if (window.ResizeObserver) new ResizeObserver(function () { if (!userMoved) { if (S.follow && S.step >= 0) cameraForStep(); else fit(); } }).observe(canvas);

  // ---------- state ----------
  var S = { flow: flows[0] || null, step: -1, playing: false, ended: false, speed: 1, narr: false, sel: null, follow: false };

  function stepSets(upTo) {
    var an = {}, ae = {}, vn = {}, ve = {};
    if (!S.flow) return { an: an, ae: ae, vn: vn, ve: ve };
    S.flow.steps.forEach(function (st, i) {
      if (i > upTo) return;
      var target = i === upTo ? [an, ae] : [vn, ve];
      (st.nodes || []).forEach(function (id) { target[0][id] = 1; });
      (st.edges || []).forEach(function (id) {
        target[1][id] = 1;
        var e = edgeById[id]; if (e) { target[0][e.from] = 1; target[0][e.to] = 1; }
      });
    });
    return { an: an, ae: ae, vn: vn, ve: ve };
  }

  function applyState() {
    var sets = stepSets(S.step), started = S.step >= 0;
    var selEdges = {};
    if (S.sel && !started) edges.forEach(function (e) { if (e.from === S.sel || e.to === S.sel) selEdges[e.id] = 1; });
    Object.keys(nodeEls).forEach(function (id) {
      var c = nodeEls[id].classList;
      c.toggle('active', !!sets.an[id]);
      c.toggle('visited', started && !sets.an[id] && !!sets.vn[id]);
      c.toggle('dim', started && !sets.an[id] && !sets.vn[id]);
      c.toggle('selected', S.sel === id);
      if (sets.an[id]) nodeEls[id].setAttribute('aria-current', 'step'); else nodeEls[id].removeAttribute('aria-current');
      nodeEls[id].setAttribute('aria-pressed', S.sel === id ? 'true' : 'false');
    });
    Object.keys(laneChips).forEach(function (key) {
      var ids = laneChips[key].ids, c = laneChips[key].el.classList;
      var act = ids.some(function (id) { return sets.an[id]; }), vis = started && !act && ids.some(function (id) { return sets.vn[id]; });
      c.toggle('active', act); c.toggle('visited', vis); c.toggle('dim', started && !act && !vis);
      c.toggle('selected', ids.indexOf(S.sel) >= 0);
      if (act) laneChips[key].el.setAttribute('aria-current', 'step'); else laneChips[key].el.removeAttribute('aria-current');
    });
    Object.keys(edgeEls).forEach(function (id) {
      var c = edgeEls[id].classList, line = edgeEls[id].querySelector('.line');
      var act = !!sets.ae[id], vis = started && !act && !!sets.ve[id];
      c.toggle('active', act);
      c.toggle('visited', vis);
      c.toggle('dim', started && !act && !vis);
      c.toggle('selected', !!selEdges[id]);
      line.setAttribute('marker-end', 'url(#' + (act ? 'arrow-a' : vis ? 'arrow-v' : 'arrow') + ')');
    });
    renderProgress();
    renderNarration();
  }
  function cameraForStep() {
    if (S.step < 0) { if (S.follow) fit(); return; }
    var ids = Object.keys(stepSets(S.step).an);
    if (S.follow) focusIds(ids); else reveal(ids);
  }

  // ---------- screen-reader announcements ----------
  // One polite live region for everything that changes without focus moving (a new step, a selection, search results).
  var announced = '';
  function announce(text, key) {
    var el = $('sr-status'); if (!el) return;
    if (key !== undefined) { if (key === announced) return; announced = key; }
    el.textContent = '';
    // a change of text is what triggers the announcement; setting it on the next tick lets repeats be read again
    setTimeout(function () { el.textContent = text; }, 30);
  }

  // ---------- narration panel & progress ----------
  function renderNarration() {
    var chips = $('step-chips'); chips.replaceChildren();
    if (!S.flow) return;
    if (S.step < 0) {
      if (!S.sel) announce('Overview of ' + arch.project.name, (S.flow.id || '') + '#overview'); // a selection announces itself
      $('step-title').textContent = arch.project.name;
      var intro = (arch.project.description || '') + ' ' + (S.flow.description || '');
      rich($('step-text'), intro.trim() + (S.flow.steps.length ? ' Press Play to walk through “' + S.flow.title + '”, or click any component.' : ''));
      return;
    }
    var st = S.flow.steps[S.step];
    $('step-title').textContent = st.title;
    rich($('step-text'), st.narration);
    announce('Step ' + (S.step + 1) + ' of ' + S.flow.steps.length + ': ' + st.title + '. ' + st.narration, S.flow.id + '#' + S.step);
    var seen = {};
    (st.nodes || []).concat((st.edges || []).flatMap(function (id) { var e = edgeById[id]; return e ? [e.from, e.to] : []; })).forEach(function (id) {
      if (seen[id] || !byId[id]) return; seen[id] = 1;
      chips.appendChild(h('button', { class: 'chip', text: byId[id].label, type: 'button', onclick: function () { selectNode(id, true); } }));
    });
    (st.sources || []).slice(0, 2).forEach(function (src) {
      chips.appendChild(h('button', { class: 'chip', type: 'button', title: 'Show source', text: '</> ' + srcLabel(src), onclick: function () { pausePlayback(); showDetail({ title: src.path, sources: [src], kind: null }); } }));
    });
  }
  function renderProgress() {
    var n = S.flow ? S.flow.steps.length : 0;
    $('progress-bar').style.width = n ? ((S.step + 1) / n * 100) + '%' : '0';
    var pg = $('progress'); pg.setAttribute('aria-valuemax', n); pg.setAttribute('aria-valuenow', S.step + 1);
    pg.setAttribute('aria-valuetext', S.step < 0 ? 'Overview' : 'Step ' + (S.step + 1) + ' of ' + n);
    $('step-count').textContent = S.step < 0 ? 'Overview' : 'Step ' + (S.step + 1) + ' / ' + n;
    $('btn-prev').disabled = S.step < 0;
    $('btn-next').disabled = !S.flow || S.step >= n - 1;
    var pb = $('btn-play');
    pb.textContent = S.playing ? '⏸︎ Pause' : (S.ended ? '↺ Replay' : '▶︎ Play');
    pb.setAttribute('aria-label', S.playing ? 'Pause' : 'Play');
  }
  function buildDots() {
    var d = $('progress-dots'); d.replaceChildren();
    if (!S.flow) return;
    S.flow.steps.forEach(function (st, i) {
      d.appendChild(h('button', { type: 'button', 'aria-label': 'Go to step ' + (i + 1) + ': ' + st.title, title: (i + 1) + '. ' + st.title, onclick: function () { pausePlayback(); goto(i); } }));
    });
  }

  // ---------- comparison marks (architecture diff) ----------
  var DIFF_MARK = { added: '+', removed: '−', changed: '~' };
  var DIFF_LABEL = { added: 'Added', removed: 'Removed', changed: 'Changed' };
  function diffClass(x) { return x.diff && x.diff !== 'same' ? ' d-' + x.diff : ''; }

  // ---------- detail panel ----------
  function srcLabel(src) { return src.path + (src.lines ? ':' + src.lines[0] + (src.lines[1] !== src.lines[0] ? '-' + src.lines[1] : '') : ''); }
  function srcKey(src) { return src.path + '#' + (src.lines ? src.lines.join('-') : ''); }
  function srcUrl(src) {
    var p = arch.project || {};
    if (typeof p.repoUrl !== 'string' || p.repoUrl.indexOf('https://github.com/') !== 0) return null;
    var ref = src.commit || p.commit || (p.branch && p.branch !== 'HEAD' ? p.branch : 'HEAD');
    var sn = src.commit ? null : snippets[srcKey(src)];
    var path = src.path.replace(/\/$/, '').split('/').map(encodeURIComponent).join('/');
    return p.repoUrl.replace(/\/$/, '') + '/' + (sn && sn.type === 'dir' ? 'tree' : 'blob') + '/' + encodeURIComponent(ref) + '/' + path + (src.lines ? '#L' + src.lines[0] + '-L' + src.lines[1] : '');
  }
  function sourceBlock(src, open) {
    var sn = src.commit ? null : snippets[srcKey(src)], url = srcUrl(src);
    var pre = sn ? h('pre', { hidden: open ? null : '' }) : null;
    if (pre) { pre.textContent = sn.text; if (!open) pre.hidden = true; else pre.removeAttribute('hidden'); }
    var action;
    if (url) action = h('a', { class: 'btn small', href: url, target: '_blank', rel: 'noopener noreferrer', text: 'Open Source' });
    else action = h('button', { class: 'btn small', type: 'button', title: 'No GitHub remote known: shows the embedded code instead', text: sn ? 'Open Source' : 'No preview', onclick: function () { if (pre) pre.hidden = !pre.hidden; } });
    if (!sn) action.disabled = !url;
    var kids = [h('div', { class: 'src-row' }, [h('code', { text: srcLabel(src) }), action])];
    if (src.note) kids.push(h('p', { class: 'note', text: src.note }));
    if (pre) kids.push(pre);
    return h('div', { class: 'src' }, kids);
  }
  function showDetail(d) {
    $('detail-empty').hidden = true;
    var body = $('detail-body'); body.hidden = false; body.replaceChildren();
    var head = h('h3', { text: d.title });
    if (d.kind) { var pill = h('span', { class: 'pill', text: d.kind }); pill.setAttribute('style', '--kc:' + kindColor(d.kind)); body.appendChild(h('div', {}, [pill, head])); }
    else body.appendChild(head);
    if (d.diff && d.diff !== 'same') body.appendChild(h('p', { class: 'kv diff-note d-' + d.diff }, [h('b', { text: DIFF_LABEL[d.diff] + (d.diffNote ? ': ' : '.') }), document.createTextNode(d.diffNote || '')]));
    if (d.summary) { var p = h('p'); rich(p, d.summary); p.style.margin = '8px 0 0'; body.appendChild(p); }
    if (d.tech && d.tech.length) body.appendChild(h('p', { class: 'kv' }, [h('b', { text: 'Tech: ' }), document.createTextNode(d.tech.join(', '))]));
    (d.lists || []).forEach(function (l) {
      if (!l.ids.length) return;
      var ul = h('ul', { class: 'links' });
      l.ids.forEach(function (id) { ul.appendChild(h('li', {}, [h('button', { class: 'chip', type: 'button', text: byId[id].label, onclick: function () { selectNode(id, true); } })])); });
      body.appendChild(h('p', { class: 'kv' }, [h('b', { text: l.title })]));
      body.appendChild(ul);
    });
    if (d.origin) body.appendChild(h('p', { class: 'kv', text: 'Source of this entry: ' + d.origin }));
    (d.sources || []).forEach(function (src, i) { body.appendChild(sourceBlock(src, i === 0)); });
  }
  function selectNode(id, pan) {
    var n = byId[id]; if (!n) return;
    expandFor(id);
    pausePlayback();
    S.sel = id;
    var uses = [], usedBy = [];
    edges.forEach(function (e) { if (e.from === id && byId[e.to]) uses.push(e.to); if (e.to === id && byId[e.from]) usedBy.push(e.from); });
    announce(n.label + ', ' + n.kind + '. ' + (uses.length ? 'Depends on ' + uses.length + '. ' : '') + (usedBy.length ? 'Used by ' + usedBy.length + '. ' : '') + 'Details are shown below.', 'sel:' + id);
    showDetail({ title: n.label, kind: n.kind, summary: n.summary, tech: n.tech, sources: n.sources, origin: n.origin, diff: n.diff, diffNote: n.diffNote, lists: [{ title: 'Depends on / calls', ids: uses }, { title: 'Used by', ids: usedBy }] });
    applyState();
    if (pan) reveal([id]);
    var det = $('detail'); if (window.innerWidth <= 900 && det.scrollIntoView) det.scrollIntoView({ block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' });
  }
  function clearSelection() {
    if (!S.sel) return; S.sel = null;
    $('detail-empty').hidden = false; $('detail-body').hidden = true; applyState();
  }

  // ---------- speech ----------
  var synth = window.speechSynthesis, speechOK = !!synth && typeof window.SpeechSynthesisUtterance === 'function';
  var speakId = 0, timer = null, watchdog = null;
  function chosenVoice() {
    if (!speechOK) return null;
    var uri = $('voice').value;
    return synth.getVoices().filter(function (v) { return v.voiceURI === uri; })[0] || null;
  }
  function stopSpeech() {
    speakId++; clearTimeout(watchdog);
    if (speechOK) { try { synth.cancel(); } catch (e) { /* ignore */ } }
  }
  function speak(text, done) {
    var id = ++speakId;
    try { synth.cancel(); if (synth.paused) synth.resume(); } catch (e) { /* ignore */ }
    var parts = String(text).replace(/`/g, '').match(/[^.!?]+[.!?]*\s*/g) || [String(text)];
    var i = 0, voice = chosenVoice();
    (function nextChunk() {
      if (id !== speakId) return;
      if (i >= parts.length) return done();
      var t = parts[i++].trim(); if (!t) return nextChunk();
      var u = new SpeechSynthesisUtterance(t);
      u.rate = S.speed; if (voice) { u.voice = voice; u.lang = voice.lang; }
      u.onend = nextChunk;
      u.onerror = function (ev) { if (id !== speakId || ev.error === 'canceled' || ev.error === 'interrupted') return; speakId++; done(); };
      synth.speak(u);
    })();
    // If the browser never starts speaking (no voices installed), fall back to a silent timed read.
    clearTimeout(watchdog);
    watchdog = setTimeout(function () {
      if (id === speakId && !synth.speaking && !synth.pending && !synth.paused) { speakId++; done(true); }
    }, 1800);
  }

  // ---------- playback engine ----------
  function dwell(st) {
    var words = String(st.narration || '').split(/\s+/).length;
    return Math.max(3500, words * 340) / S.speed;
  }
  function schedule() {
    clearTimeout(timer); stopSpeech();
    if (!S.playing || !S.flow) return;
    var st = S.flow.steps[S.step]; if (!st) return;
    var after = function () { timer = setTimeout(advance, 450 / S.speed); };
    if (S.narr && speechOK) speak(st.narration, function (failed) { if (failed) timer = setTimeout(advance, dwell(st)); else after(); });
    else timer = setTimeout(advance, dwell(st));
  }
  function advance() {
    if (!S.flow) return;
    if (S.step < S.flow.steps.length - 1) goto(S.step + 1);
    else { S.playing = false; S.ended = true; clearTimeout(timer); stopSpeech(); renderProgress(); }
  }
  function goto(i) {
    if (!S.flow) return;
    S.step = Math.max(-1, Math.min(S.flow.steps.length - 1, i));
    S.ended = false;
    applyState(); cameraForStep(); reportState();
    if (S.playing) schedule(); else { clearTimeout(timer); stopSpeech(); }
  }
  function play() {
    if (!S.flow || !S.flow.steps.length) return;
    S.playing = true;
    if (S.ended || S.step < 0) { goto(S.ended ? 0 : 0); return; }
    if (speechOK && synth.paused) { synth.resume(); renderProgress(); return; }
    renderProgress(); schedule();
  }
  function pausePlayback() {
    if (!S.playing) return;
    S.playing = false; clearTimeout(timer);
    if (speechOK && synth.speaking) { try { synth.pause(); } catch (e) { stopSpeech(); } }
    renderProgress();
  }
  function stopAll() { S.playing = false; clearTimeout(timer); stopSpeech(); renderProgress(); }
  function restart() { S.playing = true; S.ended = false; goto(0); }

  $('btn-play').addEventListener('click', function () { S.playing ? pausePlayback() : play(); });
  $('btn-next').addEventListener('click', function () { pausePlayback(); goto(S.step + 1); });
  $('btn-prev').addEventListener('click', function () { pausePlayback(); goto(S.step - 1); });
  $('btn-restart').addEventListener('click', restart);
  $('speed').addEventListener('change', function (e) { S.speed = Number(e.target.value) || 1; store('speed', e.target.value); if (S.playing) schedule(); });
  $('progress').addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('button') || !S.flow) return;
    var r = this.getBoundingClientRect(); pausePlayback();
    goto(Math.round(((e.clientX - r.left) / r.width) * S.flow.steps.length) - 1);
  });
  document.addEventListener('keydown', function (e) {
    var t = e.target, tag = t && t.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === ' ' && tag !== 'BUTTON' && tag !== 'A') { e.preventDefault(); S.playing ? pausePlayback() : play(); }
    else if (e.key === 'ArrowRight') { pausePlayback(); goto(S.step + 1); }
    else if (e.key === 'ArrowLeft') { pausePlayback(); goto(S.step - 1); }
    else if (e.key === 'r' || e.key === 'R') restart();
    else if (e.key === '/') { e.preventDefault(); $('search').focus(); $('search').select(); }
    else if (e.key === 'Escape') clearSelection();
  });

  // ---------- narration controls ----------
  function fillVoices() {
    var sel = $('voice'); if (!speechOK) return;
    var voices = synth.getVoices(), saved = store('voice');
    sel.replaceChildren();
    if (!voices.length) { sel.appendChild(h('option', { value: '', text: 'System default' })); return; }
    var lang = (navigator.language || 'en').toLowerCase().split('-')[0];
    var sorted = voices.slice().sort(function (a, b) {
      var am = a.lang.toLowerCase().indexOf(lang) === 0 ? 0 : 1, bm = b.lang.toLowerCase().indexOf(lang) === 0 ? 0 : 1;
      return am - bm || a.name.localeCompare(b.name);
    });
    sorted.forEach(function (v) { sel.appendChild(h('option', { value: v.voiceURI, text: v.name + ' (' + v.lang + ')' })); });
    var pick = sorted.filter(function (v) { return v.voiceURI === saved; })[0] || sorted.filter(function (v) { return v.default && v.lang.toLowerCase().indexOf(lang) === 0; })[0] || sorted[0];
    sel.value = pick.voiceURI;
  }
  if (!speechOK) {
    ['narr-enable', 'narr-stop', 'voice'].forEach(function (id) { $(id).disabled = true; });
    $('narr-hint').textContent = 'Voice not supported in this browser. Captions are shown instead.';
  } else {
    fillVoices();
    if ('onvoiceschanged' in synth) synth.addEventListener('voiceschanged', fillVoices);
    $('voice').addEventListener('change', function (e) { store('voice', e.target.value); if (S.playing && S.narr) schedule(); });
    $('narr-enable').addEventListener('change', function (e) {
      S.narr = e.target.checked; store('narr', S.narr ? '1' : '0');
      if (!S.narr) stopSpeech();
      if (S.playing) schedule();
    });
    $('narr-stop').addEventListener('click', stopAll);
    if (store('narr') === '1') { S.narr = true; $('narr-enable').checked = true; }
  }
  var savedSpeed = store('speed');
  if (savedSpeed && $('speed').querySelector('option[value="' + savedSpeed + '"]')) { $('speed').value = savedSpeed; S.speed = Number(savedSpeed); }
  window.addEventListener('pagehide', stopSpeech);

  // ---------- flows ----------
  function setFlow(i) {
    stopAll(); S.flow = flows[i] || null; S.step = -1; S.ended = false;
    buildDots(); applyState(); reportState();
  }
  var fs = $('flow-select');
  flows.forEach(function (f, i) { fs.appendChild(h('option', { value: i, text: f.title })); });
  fs.addEventListener('change', function () { setFlow(Number(fs.value)); });
  if (flows.length < 2) fs.closest('.field').hidden = true;
  if (!flows.length) { ['btn-play', 'btn-next', 'btn-prev', 'btn-restart'].forEach(function (id) { $(id).disabled = true; }); }

  // ---------- search ----------
  var hay = {}, searchIdx = -1;
  nodes.forEach(function (n) { hay[n.id] = [n.label, n.summary, n.kind, (n.tech || []).join(' '), (n.sources || []).map(function (s) { return s.path; }).join(' ')].join(' ').toLowerCase(); });
  function runSearch() {
    var q = $('search').value.trim().toLowerCase(), matches = [], set = {};
    Object.keys(nodeEls).forEach(function (id) {
      var hit = !q || hay[id].indexOf(q) >= 0;
      if (q && hit) { matches.push(id); set[id] = 1; }
      nodeEls[id].classList.toggle('s-hit', !!q && hit);
      nodeEls[id].classList.toggle('s-miss', !!q && !hit);
    });
    Object.keys(edgeEls).forEach(function (id) { var e = edgeById[id]; edgeEls[id].classList.toggle('s-miss', !!q && !(set[e.from] && set[e.to])); });
    $('search-count').textContent = q ? matches.length + (matches.length === 1 ? ' match' : ' matches') : '';
    return matches;
  }
  $('search').addEventListener('input', function () { searchIdx = -1; runSearch(); });
  new MutationObserver(function () { var c = $('search-count'); if (c && c.textContent) announce(c.textContent, 'search:' + c.textContent); }).observe($('search-count'), { childList: true, characterData: true, subtree: true });
  $('search').addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); $('search').value = ''; searchIdx = -1; runSearch(); $('search').blur(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      var m = runSearch(); if (!m.length) return;
      searchIdx = (searchIdx + 1) % m.length; // Enter again jumps to the next match
      selectNode(m[searchIdx], true);
    }
  });

  // ---------- export (SVG / PNG) ----------
  // The diagram is styled with CSS classes and variables that do not exist outside this page, so the export inlines
  // the resolved colours and fonts into a copy of the SVG, and covers the whole graph rather than the visible area.
  var EXPORT_PROPS = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'opacity', 'font-size', 'font-weight', 'font-family', 'text-anchor', 'paint-order', 'stroke-linejoin'];
  function buildExportSvg() {
    var bb = bbox(Object.keys(boxes)); if (!bb) return null;
    var m = 32, x = Math.floor(bb.x - m), y = Math.floor(bb.y - m), w = Math.ceil(bb.w + 2 * m), hgt = Math.ceil(bb.h + 2 * m);
    var clone = svg.cloneNode(true);
    var src = svg.querySelectorAll('*'), dst = clone.querySelectorAll('*');
    for (var i = 0; i < src.length; i++) {
      var cs = getComputedStyle(src[i]), st = '';
      EXPORT_PROPS.forEach(function (p) { var v = cs.getPropertyValue(p); if (v) st += p + ':' + v + ';'; });
      dst[i].setAttribute('style', st);
      if (dst[i].hasAttribute('tabindex')) dst[i].removeAttribute('tabindex');
    }
    Array.prototype.slice.call(clone.querySelectorAll('.lane-hidden')).forEach(function (el) { el.parentNode.removeChild(el); });
    ['id', 'class', 'tabindex', 'style'].forEach(function (a) { clone.removeAttribute(a); });
    clone.setAttribute('xmlns', NS);
    clone.setAttribute('viewBox', [x, y, w, hgt].join(' '));
    clone.setAttribute('width', w); clone.setAttribute('height', hgt);
    var bgc = getComputedStyle(canvas).backgroundColor;
    var bg = document.createElementNS(NS, 'rect');
    bg.setAttribute('x', x); bg.setAttribute('y', y); bg.setAttribute('width', w); bg.setAttribute('height', hgt); bg.setAttribute('fill', bgc);
    clone.insertBefore(bg, clone.firstChild);
    return { text: new XMLSerializer().serializeToString(clone), w: w, h: hgt };
  }
  function fileBase() { return String(arch.project.name || 'architecture').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-architecture'; }
  function saveBlob(name, blob) {
    var url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }
  function exportSvg() { var r = buildExportSvg(); if (r) saveBlob(fileBase() + '.svg', new Blob([r.text], { type: 'image/svg+xml;charset=utf-8' })); }
  function exportPng() {
    var r = buildExportSvg(); if (!r) return;
    var url = URL.createObjectURL(new Blob([r.text], { type: 'image/svg+xml;charset=utf-8' })), img = new Image();
    img.onload = function () {
      var scale = Math.min(2, 8000 / Math.max(r.w, r.h)), cv = document.createElement('canvas');
      cv.width = Math.round(r.w * scale); cv.height = Math.round(r.h * scale);
      var ctx = cv.getContext('2d'); ctx.scale(scale, scale); ctx.drawImage(img, 0, 0, r.w, r.h);
      URL.revokeObjectURL(url);
      cv.toBlob(function (b) { if (b) saveBlob(fileBase() + '.png', b); }, 'image/png');
    };
    img.onerror = function () { URL.revokeObjectURL(url); };
    img.src = url;
  }
  $('export-svg').addEventListener('click', exportSvg);
  $('export-png').addEventListener('click', exportPng);
  window.__gvExportSvg = buildExportSvg; // used by the automated browser checks

  // ---------- theme & host bridge ----------
  // The tour usually runs in a sandboxed frame (no storage, opaque origin), so the hosting page and the tour keep
  // each other in sync with postMessage. Standalone, the choice is remembered in localStorage.
  var THEMES = ['auto', 'light', 'dark'], theme = 'auto';
  var THEME_LABEL = { auto: '◐ Auto', light: '☀ Light', dark: '☾ Dark' };
  function toHost(msg) { try { if (window.parent && window.parent !== window) window.parent.postMessage(msg, '*'); } catch (e) { /* not framed */ } }
  function applyTheme(t, fromHost) {
    if (THEMES.indexOf(t) < 0) return;
    theme = t;
    if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
    var b = $('theme-btn'); b.textContent = THEME_LABEL[t]; b.setAttribute('aria-label', 'Theme: ' + t + '. Click to change.');
    if (!fromHost) { store('theme', t); toHost({ gvTheme: t }); }
  }
  $('theme-btn').addEventListener('click', function () { applyTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]); });
  window.addEventListener('message', function (e) {
    if (e.source !== window.parent || !e.data || typeof e.data !== 'object') return;
    if (typeof e.data.gvTheme === 'string') applyTheme(e.data.gvTheme, true);
    if (e.data.gvGoto && typeof e.data.gvGoto === 'object') gotoState(e.data.gvGoto);
  });
  applyTheme(store('theme') || 'auto', true);

  // Deep links: report where the tour is, and jump to a reported position. Steps are 1-based in links; 0 or missing means the overview.
  function reportState() {
    if (!S.flow) return;
    var st = { flow: S.flow.id, step: S.step + 1 };
    toHost({ gvState: st });
    if (window.parent === window) { try { history.replaceState(null, '', st.step > 0 ? '#flow=' + encodeURIComponent(st.flow) + '&step=' + st.step : location.pathname + location.search); } catch (e) { /* not allowed here */ } }
  }
  function gotoState(g) {
    var idx = -1;
    flows.forEach(function (f, i) { if (idx < 0 && f.id === g.flow) idx = i; });
    if (idx < 0) idx = 0;
    if (!flows.length) return;
    stopAll(); $('flow-select').value = idx; S.flow = flows[idx]; S.step = -1; S.ended = false; buildDots();
    var n = Number(g.step);
    if (Number.isInteger(n) && n >= 1 && n <= S.flow.steps.length && (g.flow == null || flows[idx].id === g.flow)) goto(n - 1); // paused on that step
    else { applyState(); reportState(); }
  }

  // ---------- grouping (swimlanes) ----------
  function relayout(focusEl) {
    render(); applyState(); runSearch();
    if (!userMoved) fit();
    var key = focusEl && focusEl.getAttribute && focusEl.getAttribute('aria-label');
    if (key) { var again = svg.querySelector('.lane-head[aria-label="' + key.replace('Collapse', 'Expand') + '"], .lane-head[aria-label="' + key.replace('Expand', 'Collapse') + '"]'); if (again) again.focus(); }
    syncLaneButton();
  }
  function toggleLane(key, from) {
    collapsed[key] = !collapsed[key];
    announce(String(key) + (collapsed[key] ? ' collapsed, ' + laneMembers(key).length + ' components hidden.' : ' expanded.'));
    relayout(from);
  }
  function expandFor(id) { // a component that must be shown (selected, or a search hit) opens its lane
    if (!isHidden(id)) return false;
    collapsed[laneKeyOf(byId[id])] = false;
    render(); applyState(); runSearch(); syncLaneButton();
    return true;
  }
  function syncLaneButton() {
    var b = $('lanes-toggle');
    if (!b) return;
    var grouped = groupMode !== 'none' && laneRects.length > 1;
    b.hidden = !grouped;
    if (!grouped) return;
    var allCollapsed = laneRects.every(function (lr) { return lr.collapsed; });
    b.textContent = allCollapsed ? 'Expand all' : 'Collapse all';
    b.setAttribute('aria-label', allCollapsed ? 'Expand all groups' : 'Collapse all groups');
  }
  var hasGroups = nodes.some(function (n) { return typeof n.group === 'string' && n.group; });
  (function () {
    var sel = $('group-by');
    [['none', 'No grouping'], ['kind', 'By kind']].concat(hasGroups ? [['group', 'By group']] : []).forEach(function (o) { sel.appendChild(h('option', { value: o[0], text: o[1] })); });
    groupMode = hasGroups ? 'group' : 'none';
    sel.value = groupMode;
    sel.addEventListener('change', function () {
      groupMode = sel.value; collapsed = {}; render(); applyState(); runSearch(); fit(); syncLaneButton();
    });
    var lt = $('lanes-toggle');
    if (lt) lt.addEventListener('click', function () {
      var collapseAll = !laneRects.every(function (lr) { return lr.collapsed; });
      laneRects.forEach(function (lr) { collapsed[lr.key] = collapseAll; });
      announce(collapseAll ? 'All groups collapsed.' : 'All groups expanded.');
      relayout();
    });
    syncLaneButton();
  })();

  // ---------- boot ----------
  $('proj-name').textContent = arch.project.name;
  $('proj-desc').textContent = arch.project.description || '';
  if (typeof arch.project.repoUrl === 'string' && arch.project.repoUrl.indexOf('https://github.com/') === 0) {
    var rl = $('repo-link'); rl.href = arch.project.repoUrl; rl.hidden = false;
  }
  $('app').hidden = false;
  render(); buildDots(); fit(); applyState();
  var savedFollow = store('follow');
  S.follow = savedFollow == null ? fitScale < 0.5 : savedFollow === '1';
  $('follow').checked = S.follow;
  $('follow').addEventListener('change', function (e) { S.follow = e.target.checked; store('follow', S.follow ? '1' : '0'); if (S.follow) cameraForStep(); else fit(); });
  var hm = /[#&]flow=([^&]+)&step=(\d+)/.exec(location.hash); // standalone deep link
  if (hm) gotoState({ flow: decodeURIComponent(hm[1]), step: Number(hm[2]) });
})();
