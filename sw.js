/*
 * sw.js — the service worker (owner I): SYNTH offline, as an installed app or in a browser tab, and updates that wait
 * for the user. A classic script with no imports, registered by pwa.js (scope ./, updateViaCache none) on https: and on
 * localhost. Unit-tested in node against fake caches, fetch and clients (tests/pwa.test.mjs).
 *
 * Caches (named synth-*; activating a worker deletes every other synth-* cache):
 *   synth-shell-v<VERSION>-<BUILD>  the precache — ASSETS at ?v=VERSION: every module, the stylesheet, the AudioWorklet
 *                           scripts and the Workers the page requests (tools/precache.mjs derives the list from the
 *                           sources; the tests check it), and STATIC: the page itself ('./', only a page of this VERSION),
 *                           the manifest, the icons and the bundled fonts (fonts/*.woff2: precache.mjs finds them in fonts.css, and
 *                           the OFL-*.txt licence texts beside them, so the iPad app's bundle carries the licence too).
 *                           Fetched with cache: 'no-cache' (revalidated: never a stale HTTP
 *                           copy). BUILD is a hash of all of them (tools/precache.mjs --write; the tests check it): a
 *                           change deployed without a VERSION bump still makes a new worker, with a precache of its own.
 *   (synth-fonts-v1, which kept Google's fonts before they were bundled, goes at the next activation like any synth-* cache)
 * Strategies (GET only: other methods, range requests and other origins are left to the browser):
 *   ?v=N files              cache first: this worker's own precache, then any synth-* cache (a ?v=N URL names one build
 *                           of a file: a waiting worker's precache serves a page that is already the new version); a miss
 *                           goes to the network and is kept when N is this VERSION (a 200 from this origin). On the
 *                           development hosts (localhost: files change without a version bump) network first instead.
 *                           AudioWorklet addModule, module Workers and their imports and importScripts all arrive here.
 *   navigations             network first; after NAV_WAIT ms without an answer, or offline, the cached page (the
 *                           network's answer still refreshes it), which an error page (a 404 / 5xx while the site
 *                           deploys) never replaces either. Only a page of this VERSION (its main.js?v=N) replaces the
 *                           cached one, so the cached page always matches the cached files.
 *   the bundled fonts       cache first: this worker's precache (BUILD hashes their bytes), then the way of other same-origin GETs
 *                           — a slow network neither holds the page's load nor draws system faces
 *   other same-origin GETs  network first; offline the cached copy, then the precached ?v= build of that file
 * Messages (from the page, pwa.js):
 *   { t: 'adopt', v }       a waiting worker activates at once when the asking page already is version v = VERSION and
 *                           is the only window (nothing changes for it) — not when an older build of VERSION is cached
 *                           (the page runs on its files); replies { t: 'adopt', ok } on the message port
 *   { t: 'skip' }           the user accepted the update (the page has saved): skipWaiting → activate → clients.claim;
 *                           the page reloads on controllerchange
 *   { t: 'version' }        replies { t: 'version', v: VERSION }
 * A new worker never activates by itself while a SYNTH window is open (no skipWaiting at install).
 */
'use strict';
const VERSION = '9';
const BUILD = '6be01775df14'; // (tools/precache.mjs --write: a hash of the precached files)
// (tools/precache.mjs --write rewrites these two lists from the sources)
const ASSETS = [
  'appstore.js', 'arrange.js', 'assets.js', 'audioclock.js', 'classic-panel.js', 'cv-art.js', 'cv-cables.js',
  'cv-cords.js', 'cv-cost.js', 'cv-drum.js', 'cv-face.js', 'cv-gl.js', 'cv-graph.js', 'cv-keys.js', 'cv-migrate.js',
  'cv-model.js', 'cv-modlayer.js', 'cv-mods-ui.js', 'cv-mods.js', 'cv-module.js', 'cv-pads.js', 'cv-panel.js',
  'cv-patch.js', 'cv-tray.js', 'cv-world.js', 'dr-808.js', 'dr-seq.js', 'drum-core.js', 'engine.js', 'fonts/fonts.css',
  'fx-core.js', 'fx-dsp.js', 'fx-mods2.js', 'fx-ui.js', 'gesture.js', 'graph.js', 'laws.js', 'main.js',
  'master-dsp.js', 'master-ui.js', 'midi.js', 'mod-core.js', 'models.js', 'moog-core.js', 'moog-dsp.js',
  'pads-core.js', 'panels/arp2600.js', 'panels/cs80.js', 'panels/dx7.js', 'panels/index.js', 'panels/juno60.js',
  'panels/jupiter8.js', 'panels/m900.js', 'panels/m900b.js', 'panels/m900c.js', 'panels/minimoog.js',
  'panels/modular.js', 'panels/ms20.js', 'panels/obxa.js', 'panels/prophet5.js', 'panels/sdsv.js', 'panels/solina.js',
  'panels/tb303.js', 'panels/tr606.js', 'panels/tr808.js', 'panels/tr909.js', 'patch-core.js', 'patch-dsp.js',
  'pwa.js', 'rig-core.js', 'rig-grid.js', 'rig-ui.js', 'roll.js', 'seq-core.js', 'serum-core.js', 'serum-dsp.js',
  'serum-ui.js', 'smp.js', 'smpgen.js', 'smprender.js', 'smpstore.js', 'smpwork.js', 'song.js', 'style.css',
  'sx-base.js', 'sx-edges.js', 'sx-filt2.js', 'sx-gran.js', 'sx-host.js', 'sx-mod.js', 'sx-sample.js', 'sx-seq.js',
  'sx-spec.js', 'sx-ui-mix.js', 'sx-ui-mod.js', 'sx-ui-osc.js', 'sx-ui-seq.js', 'sx-warp.js', 'tuning.js', 'wk.js',
  'wt.js', 'wtedit.js', 'wtstore.js', 'wtwork.js',
];
const STATIC = [
  './', 'fonts/ArchivoNarrowVariable.woff2', 'fonts/InterVariable.woff2', 'fonts/JetBrainsMono-Regular.woff2',
  'fonts/JetBrainsMono-SemiBold.woff2', 'fonts/OFL-ArchivoNarrow.txt', 'fonts/OFL-Inter.txt',
  'fonts/OFL-JetBrainsMono.txt', 'icons/apple-touch-icon-180.png', 'icons/favicon-32.png', 'icons/icon-192.png',
  'icons/icon-512.png', 'icons/icon-maskable-512.png', 'manifest.webmanifest',
];
const SHELL_V = 'synth-shell-v' + VERSION, SHELL = SHELL_V + '-' + BUILD, PREFIX = 'synth-';
const NAV_WAIT = 4000;
const BASE = new URL('./', self.location.href), PAGE = BASE.href;
const DEV = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(self.location.hostname);
const ANY = { ignoreVary: true }, LOOSE = { ignoreVary: true, ignoreSearch: true };

const shellURLs = () => ASSETS.map(f => new URL(f + '?v=' + VERSION, BASE).href).concat(STATIC.map(f => new URL(f, BASE).href));
const pageVersion = html => (/\bmain\.js\?v=(\d+)/.exec(html) || [])[1] || null;
const isPage = url => url.pathname === BASE.pathname || url.pathname === BASE.pathname + 'index.html';
const mine = res => !!res && res.ok && res.type === 'basic';
// a stored copy of the page: its text and type only (a redirected answer cannot answer a navigation, and the network's
// length / encoding headers describe the compressed transfer)
const pageCopy = (res, text) => new Response(text, { status: 200, statusText: 'OK',
  headers: { 'Content-Type': (res.headers && res.headers.get('content-type')) || 'text/html; charset=utf-8' } });

/* ------------------------------------------------------------------ install / activate */
self.addEventListener('install', e => { e.waitUntil(precache()); });
async function precache() {
  const cache = await caches.open(SHELL);
  await Promise.all(shellURLs().map(async url => {
    const res = await fetch(new Request(url, { cache: 'no-cache' }));
    if (!res.ok) throw new Error('precache: ' + url + ' → ' + res.status);
    if (url === PAGE) { // the page must be this version: its files are the ones being cached
      const text = await res.text(), v = pageVersion(text);
      if (v !== VERSION) throw new Error('precache: the page is version ' + v + ', this worker ' + VERSION);
      await cache.put(url, pageCopy(res, text));
      return;
    }
    await cache.put(url, res);
  }));
}
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith(PREFIX) && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

/* ------------------------------------------------------------------ fetch */
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  if (url.origin !== BASE.origin || !url.href.startsWith(BASE.href)) return;
  if (req.mode === 'navigate') { e.respondWith(navigation(e, url)); return; }
  const v = url.searchParams.get('v');
  e.respondWith(v ? versioned(e, v === VERSION) : isFont(url) ? bundledFont(req) : other(req));
});

// The bundled fonts (STATIC's fonts/*.woff2): cache first from this worker's own precache. BUILD hashes their bytes, so the
// precache is the build's font; network first held the page's load and drew system faces until a slow network answered (IMPL-A
// §12, R2-F2). A miss (cleared cache, a page newer than this worker) takes the way of any unversioned file.
const isFont = url => STATIC.some(f => /^fonts\/[^?#]+\.woff2$/.test(f) && new URL(f, BASE).href === url.href);
async function bundledFont(req) {
  return (await (await caches.open(SHELL)).match(req, ANY)) || other(req);
}

// the network's answer; a 200 from this origin is kept in the shell cache when `keep`
async function network(e, keep) {
  const res = await fetch(e.request);
  if (keep && mine(res)) {
    const copy = res.clone();
    e.waitUntil(caches.open(SHELL).then(c => c.put(e.request, copy)).catch(() => {}));
  }
  return res;
}
async function versioned(e, current) {
  if (DEV) {
    try { return await network(e, current); } catch (err) {
      const hit = await caches.match(e.request, ANY);
      if (hit) return hit;
      throw err;
    }
  }
  // its own precache first (an older build of this version may still be cached beside it until this worker activates)
  const hit = (await (await caches.open(SHELL)).match(e.request, ANY)) || (await caches.match(e.request, ANY));
  return hit || network(e, current);
}
async function navigation(e, url) {
  const page = isPage(url);
  const net = fetch(e.request);
  // the answer refreshes the cached page — a page of this version only
  e.waitUntil(net.then(async res => {
    if (!page || !mine(res)) return;
    const copy = res.clone(), text = await copy.text();
    if (pageVersion(text) === VERSION) await (await caches.open(SHELL)).put(PAGE, pageCopy(copy, text));
  }).catch(() => {}));
  const stored = async () => (await caches.open(SHELL)).match(page ? PAGE : e.request, LOOSE);
  let timer = 0;
  try {
    const first = await Promise.race([net, new Promise(r => { timer = setTimeout(r, NAV_WAIT, null); })]);
    // the network's page — unless it is an error page (a 404 / 5xx: the site deploying) and the app is cached
    if (first && (!page || first.ok || first.type === 'opaqueredirect')) return first;
    return (await stored()) || first || await net; // a slow network: the cached page, if any
  } catch (err) {
    const hit = await stored();
    if (hit) return hit;
    throw err;
  } finally { clearTimeout(timer); }
}
async function other(req) {
  try { return await fetch(req); } catch (err) {
    const cache = await caches.open(SHELL);
    const hit = (await cache.match(req, ANY)) || (await cache.match(req, LOOSE));
    if (hit) return hit;
    throw err;
  }
}

/* ------------------------------------------------------------------ messages */
self.addEventListener('message', e => {
  const m = e.data && typeof e.data === 'object' ? e.data : {}, port = e.ports && e.ports[0];
  const reply = x => { if (port) port.postMessage(x); };
  if (m.t === 'skip') e.waitUntil(self.skipWaiting());
  else if (m.t === 'version') reply({ t: 'version', v: VERSION });
  else if (m.t === 'adopt') e.waitUntil(adopt(m.v).then(ok => reply({ t: 'adopt', ok }), () => reply({ t: 'adopt', ok: false })));
});
async function adopt(v) {
  if (String(v) !== VERSION) return false;
  // an older build of this version cached (a change deployed without a VERSION bump): the page runs on its files
  for (const k of await caches.keys()) if (k.startsWith(SHELL_V + '-') && k !== SHELL) return false;
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (wins.length > 1) return false;
  await self.skipWaiting();
  return true;
}
