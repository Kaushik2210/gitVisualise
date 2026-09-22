// Visual polish for the landing page only: GSAP for scroll-driven reveals, anime.js for small
// interactive flourishes, three.js for the drifting node-graph behind the hero. All three load
// from a CDN as ES modules and are strictly optional — if a fetch fails, WebGL is unavailable, or
// the visitor prefers reduced motion, the page renders exactly as it does in site/app.css with no
// animation at all. Nothing here touches the result view, the tour frame, or any repo data.
const landing = document.getElementById('landing');
if (landing && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  init().catch(() => { /* CDN unreachable or WebGL unavailable: the static page still works */ });
}

async function init() {
  const [gsapMod, stMod, animeMod] = await Promise.all([
    import('https://cdn.jsdelivr.net/npm/gsap@3.12.5/+esm'),
    import('https://cdn.jsdelivr.net/npm/gsap@3.12.5/ScrollTrigger.js/+esm'),
    import('https://cdn.jsdelivr.net/npm/animejs@3.2.2/+esm'),
  ]);
  const gsap = gsapMod.gsap;
  gsap.registerPlugin(stMod.ScrollTrigger);
  const anime = animeMod.default;

  splitHeadline(gsap);
  heroEntrance(gsap);
  scrollReveals(gsap, stMod.ScrollTrigger);
  countUpStats(anime);
  magneticButtons(anime);
  rippleButtons();
  navShrink(stMod.ScrollTrigger);
  navUnderline(gsap);
  tiltCards(gsap);
  cursorSpotlight(gsap);
  parallaxFrame(gsap, stMod.ScrollTrigger);
  languageMarquee(gsap);
  scrollProgress(gsap, stMod.ScrollTrigger);
  starCount(anime);
  heroGraph(); // three.js; independent so a WebGL failure here doesn't cancel the rest
}

// ---------- hero headline: split into characters and fly in ----------
// The <span class="grad"> node paints its text with a background-clip gradient (color: transparent,
// inherited by children) — splitting *its* text into further child spans would make them invisible,
// since the gradient only clips to an element's own glyphs. So it is kept and animated as one unit.
function splitHeadline(gsap) {
  const h1 = document.querySelector('.hero h1');
  if (!h1) return;
  const frag = document.createDocumentFragment();
  for (const node of [...h1.childNodes]) {
    if (node.nodeType === Node.TEXT_NODE) {
      for (const ch of node.textContent) {
        const span = document.createElement('span');
        span.textContent = ch === ' ' ? ' ' : ch;
        span.style.display = 'inline-block';
        frag.append(span);
      }
    } else {
      node.style.display = 'inline-block';
      frag.append(node);
    }
  }
  h1.textContent = '';
  h1.append(frag);
  const chars = h1.querySelectorAll(':scope > span');
  gsap.set(chars, { opacity: 0, y: 34, rotateX: -60, transformOrigin: '50% 100%' });
  gsap.to(chars, { opacity: 1, y: 0, rotateX: 0, duration: 0.7, ease: 'back.out(1.6)', stagger: 0.018 });
}

// ---------- hero entrance ----------
function heroEntrance(gsap) {
  const targets = ['.eyebrow', '.hero .lede', '.go', '.examples', '.trust', '.frame']
    .map((sel) => document.querySelector(sel))
    .filter(Boolean);
  if (!targets.length) return;
  gsap.set(targets, { opacity: 0, y: 22 });
  gsap.to(targets, { opacity: 1, y: 0, duration: 0.7, ease: 'power3.out', stagger: 0.09, delay: 0.15 });
}

// ---------- scroll-triggered reveals ----------
function scrollReveals(gsap, ScrollTrigger) {
  const groups = [
    '.gallery .kicker, .gallery h2, .gallery .sub',
    '.gcard',
    '.fgrid article',
    '.langs',
    '.steps3 li',
    '.three article',
    '.cta',
  ];
  for (const sel of groups) {
    const items = document.querySelectorAll(sel);
    if (!items.length) continue;
    gsap.set(items, { opacity: 0, y: 26 });
    ScrollTrigger.batch(items, {
      start: 'top 88%',
      once: true,
      onEnter: (batch) => gsap.to(batch, { opacity: 1, y: 0, duration: 0.6, ease: 'power2.out', stagger: 0.08 }),
    });
  }
}

// ---------- animated stat counters ----------
function countUpStats(anime) {
  for (const li of document.querySelectorAll('.trust li')) {
    const b = li.querySelector('b');
    if (!b) continue;
    const m = /^(\d+)(%?)$/.exec(b.textContent.trim());
    if (!m) continue;
    const end = Number(m[1]);
    const suffix = m[2];
    const counter = { n: 0 };
    anime({
      targets: counter,
      n: end,
      round: 1,
      easing: 'easeOutCubic',
      duration: 1100,
      delay: 500,
      update: () => { b.textContent = counter.n + suffix; },
    });
  }
}

// ---------- magnetic primary buttons ----------
function magneticButtons(anime) {
  for (const btn of document.querySelectorAll('.btn.primary')) {
    btn.addEventListener('mousemove', (e) => {
      const r = btn.getBoundingClientRect();
      anime({ targets: btn, translateX: (e.clientX - r.left - r.width / 2) * 0.18, translateY: (e.clientY - r.top - r.height / 2) * 0.35, duration: 250, easing: 'easeOutQuad' });
    });
    btn.addEventListener('mouseleave', () => { anime({ targets: btn, translateX: 0, translateY: 0, duration: 400, easing: 'easeOutElastic(1, .6)' }); });
  }
}

// ---------- click ripple on every button ----------
function rippleButtons() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn, .chip, .gcard');
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const dot = document.createElement('span');
    dot.className = 'ripple';
    const size = Math.max(r.width, r.height) * 1.8;
    dot.style.width = dot.style.height = size + 'px';
    dot.style.left = (e.clientX - r.left - size / 2) + 'px';
    dot.style.top = (e.clientY - r.top - size / 2) + 'px';
    const prevPosition = getComputedStyle(btn).position;
    if (prevPosition === 'static') btn.style.position = 'relative';
    btn.style.overflow = 'hidden';
    btn.append(dot);
    dot.addEventListener('animationend', () => dot.remove());
  });
}

// ---------- sliding underline for the main nav ----------
function navUnderline(gsap) {
  const links = [...document.querySelectorAll('.nav nav a:not(.btn)')];
  if (links.length < 2) return;
  const bar = document.createElement('span');
  bar.className = 'nav-underline';
  const holder = links[0].parentElement;
  holder.style.position = 'relative';
  holder.append(bar);
  const place = (el, animate) => {
    const hr = holder.getBoundingClientRect();
    const lr = el.getBoundingClientRect();
    const vars = { left: lr.left - hr.left, width: lr.width, opacity: 1 };
    if (animate) gsap.to(bar, { ...vars, duration: 0.35, ease: 'power2.out' }); else gsap.set(bar, vars);
  };
  for (const a of links) a.addEventListener('mouseenter', () => place(a, true));
  holder.addEventListener('mouseleave', () => gsap.to(bar, { opacity: 0, duration: 0.25 }));
}

// ---------- 3D tilt on card grids ----------
function tiltCards(gsap) {
  const cards = document.querySelectorAll('.gcard, .fgrid article, .three article, .steps3 li');
  for (const card of cards) {
    card.classList.add('tilt');
    const rotX = gsap.quickTo(card, 'rotationX', { duration: 0.4, ease: 'power2.out' });
    const rotY = gsap.quickTo(card, 'rotationY', { duration: 0.4, ease: 'power2.out' });
    const lift = gsap.quickTo(card, 'z', { duration: 0.4, ease: 'power2.out' });
    card.addEventListener('mousemove', (e) => {
      const r = card.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
      rotX(py * -8);
      rotY(px * 10);
      lift(12);
    });
    card.addEventListener('mouseleave', () => { rotX(0); rotY(0); lift(0); });
  }
}

// ---------- cursor spotlight in the hero ----------
function cursorSpotlight(gsap) {
  const hero = document.querySelector('.hero');
  if (!hero) return;
  const glow = document.createElement('div');
  glow.className = 'cursor-glow';
  hero.append(glow);
  const moveX = gsap.quickTo(glow, 'x', { duration: 0.5, ease: 'power3.out' });
  const moveY = gsap.quickTo(glow, 'y', { duration: 0.5, ease: 'power3.out' });
  hero.addEventListener('mousemove', (e) => {
    const r = hero.getBoundingClientRect();
    moveX(e.clientX - r.left);
    moveY(e.clientY - r.top);
    gsap.to(glow, { opacity: 1, duration: 0.3 });
  });
  hero.addEventListener('mouseleave', () => gsap.to(glow, { opacity: 0, duration: 0.4 }));
}

// ---------- parallax on the product screenshot frame ----------
function parallaxFrame(gsap, ScrollTrigger) {
  const frame = document.querySelector('.frame');
  if (!frame) return;
  gsap.to(frame, {
    y: -40,
    ease: 'none',
    scrollTrigger: { trigger: frame, start: 'top bottom', end: 'bottom top', scrub: 0.6 },
  });
}

// ---------- infinite marquee of supported languages ----------
function languageMarquee(gsap) {
  const langs = document.querySelector('.langs');
  if (!langs) return;
  const chips = [...langs.querySelectorAll('b')];
  if (chips.length < 3) return;
  const track = document.createElement('div');
  track.className = 'lang-track';
  const label = langs.querySelector('span');
  const link = langs.querySelector('a');
  const row = document.createElement('div');
  row.className = 'lang-row';
  for (const c of [...chips, ...chips]) row.append(c.cloneNode(true));
  track.append(row);
  langs.replaceChildren(...(label ? [label] : []), track, ...(link ? [link] : []));
  const width = row.scrollWidth / 2;
  gsap.fromTo(row, { x: 0 }, { x: -width, duration: Math.max(18, width / 40), ease: 'none', repeat: -1 });
  track.addEventListener('mouseenter', () => gsap.globalTimeline.timeScale(0.15));
  track.addEventListener('mouseleave', () => gsap.globalTimeline.timeScale(1));
}

// ---------- top scroll-progress bar ----------
function scrollProgress(gsap, ScrollTrigger) {
  const bar = document.createElement('div');
  bar.className = 'scroll-progress';
  document.body.append(bar);
  gsap.to(bar, {
    scaleX: 1,
    ease: 'none',
    scrollTrigger: { start: 0, end: () => document.documentElement.scrollHeight - innerHeight, scrub: 0.2 },
  });
}

// ---------- live GitHub star count ----------
async function starCount(anime) {
  const link = document.querySelector('a.btn.small[href*="github.com/Kaushik2210/gitVisualise"]');
  if (!link || link.id === 'bring-link') return;
  const cacheKey = 'gv:stars';
  const cached = (() => { try { return JSON.parse(localStorage.getItem(cacheKey) || 'null'); } catch { return null; } })();
  const fresh = cached && Date.now() - cached.at < 3600_000 ? cached.n : await fetchStars();
  if (fresh == null) return;
  try { localStorage.setItem(cacheKey, JSON.stringify({ n: fresh, at: Date.now() })); } catch { /* storage unavailable */ }
  const badge = document.createElement('span');
  badge.className = 'star-count';
  link.append(badge);
  const counter = { n: 0 };
  anime({ targets: counter, n: fresh, round: 1, easing: 'easeOutCubic', duration: 900, update: () => { badge.textContent = formatStars(counter.n); } });
}
async function fetchStars() {
  try {
    const res = await fetch('https://api.github.com/repos/Kaushik2210/gitVisualise', { headers: { accept: 'application/vnd.github+json' } });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.stargazers_count === 'number' ? data.stargazers_count : null;
  } catch { return null; }
}
function formatStars(n) {
  return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n);
}

// ---------- nav bar tightens on scroll ----------
function navShrink(ScrollTrigger) {
  const nav = document.querySelector('.nav');
  if (!nav) return;
  ScrollTrigger.create({
    start: 'top -8',
    end: 99999,
    toggleClass: { targets: nav, className: 'is-scrolled' },
  });
}

// ---------- three.js node-graph background ----------
async function heroGraph() {
  const hero = document.querySelector('.hero');
  if (!hero || !window.WebGLRenderingContext) return;
  const THREE = await import('https://cdn.jsdelivr.net/npm/three@0.160.0/+esm');

  const canvas = document.createElement('canvas');
  canvas.className = 'hero-graph';
  canvas.setAttribute('aria-hidden', 'true');
  hero.prepend(canvas);

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100);
  camera.position.z = 20;

  const COUNT = 46;
  const nodes = Array.from({ length: COUNT }, () => ({
    pos: new THREE.Vector3((Math.random() - 0.5) * 34, (Math.random() - 0.5) * 16, (Math.random() - 0.5) * 10),
    vel: new THREE.Vector3((Math.random() - 0.5) * 0.006, (Math.random() - 0.5) * 0.006, (Math.random() - 0.5) * 0.004),
  }));

  const colorOf = () => {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark'
      || (document.documentElement.getAttribute('data-theme') !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
    return dark ? { point: 0x8db3ff, line: 0x3b5fb0 } : { point: 0x2f5bea, line: 0xaebdf2 };
  };

  const pointGeo = new THREE.BufferGeometry();
  const pointPositions = new Float32Array(COUNT * 3);
  pointGeo.setAttribute('position', new THREE.BufferAttribute(pointPositions, 3));
  const pointMat = new THREE.PointsMaterial({ size: 0.32, sizeAttenuation: true, transparent: true, opacity: 0.85 });
  const points = new THREE.Points(pointGeo, pointMat);
  scene.add(points);

  const MAX_LINES = COUNT * 6;
  const lineGeo = new THREE.BufferGeometry();
  const linePositions = new Float32Array(MAX_LINES * 2 * 3);
  lineGeo.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));
  const lineMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.22 });
  const lines = new THREE.LineSegments(lineGeo, lineMat);
  scene.add(lines);

  const applyColors = () => {
    const { point, line } = colorOf();
    pointMat.color.setHex(point);
    lineMat.color.setHex(line);
  };
  applyColors();
  new MutationObserver(applyColors).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyColors);

  function resize() {
    const w = hero.clientWidth, h = hero.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  new ResizeObserver(resize).observe(hero);

  const LINK_DIST = 8.5;
  let raf = 0;
  let visible = true;
  new IntersectionObserver((entries) => { visible = entries[0]?.isIntersecting !== false; }, { threshold: 0 }).observe(hero);

  function tick() {
    raf = requestAnimationFrame(tick);
    if (!visible) return;
    for (const n of nodes) {
      n.pos.add(n.vel);
      if (Math.abs(n.pos.x) > 17) n.vel.x *= -1;
      if (Math.abs(n.pos.y) > 8) n.vel.y *= -1;
      if (Math.abs(n.pos.z) > 5) n.vel.z *= -1;
    }
    const posAttr = pointGeo.getAttribute('position');
    nodes.forEach((n, i) => posAttr.setXYZ(i, n.pos.x, n.pos.y, n.pos.z));
    posAttr.needsUpdate = true;

    let seg = 0;
    for (let i = 0; i < COUNT && seg < MAX_LINES; i++) {
      for (let j = i + 1; j < COUNT && seg < MAX_LINES; j++) {
        if (nodes[i].pos.distanceTo(nodes[j].pos) < LINK_DIST) {
          const lp = lineGeo.getAttribute('position');
          lp.setXYZ(seg * 2, nodes[i].pos.x, nodes[i].pos.y, nodes[i].pos.z);
          lp.setXYZ(seg * 2 + 1, nodes[j].pos.x, nodes[j].pos.y, nodes[j].pos.z);
          seg++;
        }
      }
    }
    lineGeo.setDrawRange(0, seg * 2);
    lineGeo.getAttribute('position').needsUpdate = true;

    scene.rotation.y += 0.0009;
    renderer.render(scene, camera);
  }
  tick();

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { cancelAnimationFrame(raf); } else { tick(); }
  });
}
