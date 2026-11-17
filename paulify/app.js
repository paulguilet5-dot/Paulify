/* Paulify — étape 1 : connexion, playlists, tri, lecteur */
"use strict";

const SCOPES = [
  "user-read-private", "user-read-email", "user-top-read", "user-read-recently-played",
  "playlist-read-private", "playlist-read-collaborative", "playlist-modify-private", "playlist-modify-public",
  "user-library-read", "streaming", "user-read-playback-state", "user-modify-playback-state",
  "user-read-currently-playing"
].join(" ");
const REDIRECT = location.origin + location.pathname.replace(/[^/]*$/, "");
const $ = (id) => document.getElementById(id);

/* ---------- petits utilitaires ---------- */
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} }
};
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fmtMs(ms) { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }
function fmtTotal(ms) { const m = Math.round(ms / 60000); return m >= 60 ? Math.floor(m / 60) + " h " + String(m % 60).padStart(2, "0") : m + " min"; }
function smallestImg(imgs, min) {
  if (!imgs || !imgs.length) return null;
  const sorted = imgs.slice().sort((a, b) => (a.width || 0) - (b.width || 0));
  return (sorted.find((i) => (i.width || 999) >= (min || 0)) || sorted[sorted.length - 1]).url;
}
let toastTimer;
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add("hidden"), 2600);
}

/* ---------- connexion (PKCE + jeton de rafraîchissement) ---------- */
function b64url(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function randomStr(n) {
  const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(n)), (x) => c[x % c.length]).join("");
}
async function startLogin() {
  const cid = ($("cid").value || ls.get("paulify_cid") || "").trim();
  if (!cid) { $("cid").focus(); return; }
  ls.set("paulify_cid", cid);
  const verifier = randomStr(64);
  ls.set("paulify_verifier", verifier);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const u = new URL("https://accounts.spotify.com/authorize");
  u.search = new URLSearchParams({ client_id: cid, response_type: "code", redirect_uri: REDIRECT, scope: SCOPES, code_challenge_method: "S256", code_challenge: challenge }).toString();
  location.href = u.toString();
}
async function tokenRequest(params) {
  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: ls.get("paulify_cid"), ...params })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.error || "connexion refusée");
  ls.set("paulify_access", j.access_token);
  ls.set("paulify_exp", String(Date.now() + (j.expires_in || 3600) * 1000));
  if (j.refresh_token) ls.set("paulify_refresh", j.refresh_token);
  return j.access_token;
}
let refreshing = null;
async function getToken(force) {
  const tok = ls.get("paulify_access"), exp = +ls.get("paulify_exp") || 0;
  if (!force && tok && Date.now() < exp - 60000) return tok;
  const rt = ls.get("paulify_refresh");
  if (!rt) return null;
  if (!refreshing) refreshing = tokenRequest({ grant_type: "refresh_token", refresh_token: rt }).finally(() => { refreshing = null; });
  return refreshing;
}
function logout() {
  ["paulify_access", "paulify_exp", "paulify_refresh"].forEach((k) => ls.set(k, null));
  location.href = REDIRECT;
}

/* ---------- API Spotify ---------- */
async function api(path, opts = {}, retry = 0) {
  const tok = await getToken();
  if (!tok) { showLogin(); throw new Error("Non connecté"); }
  const r = await fetch(path.startsWith("http") ? path : "https://api.spotify.com/v1" + path, {
    ...opts, headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json", ...(opts.headers || {}) }
  });
  if (r.status === 401 && retry < 1) { await getToken(true); return api(path, opts, retry + 1); }
  if (r.status === 429 && retry < 4) { await sleep(((+r.headers.get("Retry-After")) || 2) * 1000); return api(path, opts, retry + 1); }
  if (r.status === 204 || r.status === 202) return null;
  const text = await r.text();
  let body = null; try { body = text ? JSON.parse(text) : null; } catch (e) {}
  if (!r.ok) {
    const err = new Error((body && body.error && (body.error.message || body.error)) || r.statusText || ("Erreur " + r.status));
    err.status = r.status; throw err;
  }
  return body;
}
async function getAll(path) {
  let url = path, out = [];
  while (url) { const page = await api(url); out = out.concat(page.items || []); url = page.next; }
  return out;
}
// Spotify a renommé /tracks en /items pour les playlists : on essaie les deux
let ITEMS_SUFFIX = ls.get("paulify_items_suffix") || "items";
async function playlistItemsCall(id, query, opts) {
  try { return await api("/playlists/" + id + "/" + ITEMS_SUFFIX + (query || ""), opts); }
  catch (e) {
    if (e.status !== 404 && e.status !== 403 && e.status !== 410) throw e;
    const other = ITEMS_SUFFIX === "items" ? "tracks" : "items";
    const res = await api("/playlists/" + id + "/" + other + (query || ""), opts);
    ITEMS_SUFFIX = other; ls.set("paulify_items_suffix", other);
    return res;
  }
}

/* ---------- état ---------- */
const S = {
  me: null, playlists: [], current: null, items: [], sort: "perso",
  sdkPlayer: null, sdkDevice: null, sdkReady: false,
  playback: null, lastPoll: 0, saving: false
};

/* ---------- écrans ---------- */
function showLogin(errMsg) {
  $("main").classList.add("hidden");
  $("login").classList.remove("hidden");
  $("cid").value = ls.get("paulify_cid") || "";
  $("cid-block").classList.toggle("hidden", !!ls.get("paulify_cid") && !errMsg);
  if (errMsg) { $("login-err").textContent = errMsg; $("login-err").classList.remove("hidden"); }
}
async function showMain() {
  $("login").classList.add("hidden");
  $("main").classList.remove("hidden");
  try {
    S.me = await api("/me");
  } catch (e) { showLogin("Connexion impossible : " + e.message); return; }
  const av = $("avatar"); av.textContent = "";
  const img = smallestImg(S.me.images, 64);
  if (img) av.append(h("img", { src: img, alt: "" })); else av.textContent = (S.me.display_name || "P")[0].toUpperCase();
  $("acc-name").textContent = S.me.display_name || S.me.id;
  $("acc-sub").textContent = "Compte " + (S.me.product === "premium" ? "Premium" : S.me.product || "");
  loadPlaylists();
  initSdk();
  pollPlayback();
  setInterval(() => { if (!document.hidden) pollPlayback(); }, 5000);
  setInterval(tickProgress, 1000);
}

/* ---------- playlists ---------- */
async function loadPlaylists() {
  $("pl-grid").replaceChildren(h("p", { class: "muted" }, "Chargement de tes playlists…"));
  try {
    S.playlists = (await getAll("/me/playlists?limit=50")).filter(Boolean);
    renderPlaylists();
  } catch (e) { $("pl-grid").replaceChildren(h("p", { class: "err" }, "Impossible de charger les playlists : " + e.message)); }
}
function renderPlaylists() {
  const q = $("pl-search").value.trim().toLowerCase();
  const list = S.playlists.filter((p) => !q || (p.name || "").toLowerCase().includes(q));
  $("pl-empty").classList.toggle("hidden", list.length > 0);
  $("pl-grid").replaceChildren(...list.map((p) => {
    const img = smallestImg(p.images, 200);
    const count = (p.items && p.items.total) ?? (p.tracks && p.tracks.total);
    return h("button", { class: "pl-card", type: "button", onclick: () => openPlaylist(p) },
      img ? h("img", { class: "cover", src: img, alt: "", loading: "lazy" }) : h("div", { class: "cover-fallback" }, (p.name || "?")[0]),
      h("span", { class: "n ellipsis" }, p.name || "Sans titre"),
      h("span", { class: "muted small" }, count != null ? count + " titres" : "")
    );
  }));
}

async function openPlaylist(p) {
  S.current = p; S.items = []; S.sort = "perso";
  $("view-list").classList.add("hidden");
  $("view-detail").classList.remove("hidden");
  $("scroll").scrollTop = 0;
  $("d-name").textContent = p.name || "Sans titre";
  $("d-cover").src = smallestImg(p.images, 300) || "";
  $("d-meta").textContent = "";
  $("tracks").replaceChildren();
  $("tracks-loading").classList.remove("hidden");
  renderSorts(); updateSaveBox();
  try {
    const raw = await getAllItems(p.id);
    if (S.current !== p) return;
    S.items = raw.map((it, i) => {
      const t = it.item || it.track;
      if (!t) return { idx: i, title: "Titre indisponible", artist: "", off: true, dur: 0 };
      return {
        idx: i, uri: t.uri, off: !!t.is_local || !t.uri || t.type === "episode" && !t.uri,
        title: t.name || "", artist: (t.artists || []).map((a) => a.name).join(", ") || (t.show && t.show.name) || "",
        album: (t.album && t.album.name) || "", release: (t.album && t.album.release_date) || "",
        img: smallestImg((t.album && t.album.images) || t.images, 64), dur: t.duration_ms || 0, added: it.added_at || ""
      };
    });
    const total = S.items.reduce((a, t) => a + t.dur, 0);
    $("d-meta").textContent = S.items.length + " titres · " + fmtTotal(total) + (canEdit() ? "" : " · lecture seule");
    renderTracks();
  } catch (e) {
    $("tracks").replaceChildren(h("p", { class: "err" }, "Impossible de charger les titres : " + e.message));
  } finally { $("tracks-loading").classList.add("hidden"); }
}
async function getAllItems(id) {
  let offset = 0, out = [];
  for (;;) {
    const page = await playlistItemsCall(id, "?limit=100&offset=" + offset);
    out = out.concat(page.items || []);
    if (!page.next || !(page.items || []).length) break;
    offset += page.items.length;
  }
  return out;
}
function canEdit() {
  const p = S.current;
  return !!(p && S.me && ((p.owner && p.owner.id === S.me.id) || p.collaborative));
}

const SORTS = [
  ["perso", "Mon ordre"], ["artiste", "Artiste A→Z"], ["titre", "Titre A→Z"], ["album", "Album"],
  ["recent", "Ajout récent"], ["ancien", "Ajout ancien"], ["sortie", "Date de sortie"], ["duree", "Durée"]
];
const coll = new Intl.Collator("fr", { sensitivity: "base", numeric: true });
const CMP = {
  artiste: (a, b) => coll.compare(a.artist, b.artist) || coll.compare(a.album, b.album) || coll.compare(a.title, b.title),
  titre: (a, b) => coll.compare(a.title, b.title),
  album: (a, b) => coll.compare(a.album, b.album) || a.idx - b.idx,
  recent: (a, b) => b.added.localeCompare(a.added),
  ancien: (a, b) => a.added.localeCompare(b.added),
  sortie: (a, b) => b.release.localeCompare(a.release),
  duree: (a, b) => a.dur - b.dur
};
function sortedItems() {
  const list = S.items.slice();
  if (CMP[S.sort]) list.sort((a, b) => CMP[S.sort](a, b) || a.idx - b.idx);
  return list;
}
function renderSorts() {
  $("sorts").replaceChildren(...SORTS.map(([k, label]) =>
    h("button", { type: "button", class: "chip" + (S.sort === k ? " on" : ""), "aria-pressed": S.sort === k ? "true" : "false",
      onclick: () => { if (S.saving) return; S.sort = k; renderSorts(); renderTracks(); updateSaveBox(); } }, label)));
}
function sideInfo(t) {
  if (S.sort === "recent" || S.sort === "ancien") return t.added ? new Date(t.added).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "2-digit" }) : "";
  if (S.sort === "sortie") return t.release ? t.release.slice(0, 4) : "";
  if (S.sort === "album") return "";
  return t.dur ? fmtMs(t.dur) : "";
}
function renderTracks() {
  const nowUri = S.playback && S.playback.item && S.playback.item.uri;
  $("tracks").replaceChildren(...sortedItems().map((t, i) =>
    h("button", { type: "button", class: "track" + (t.off ? " off" : "") + (t.uri && t.uri === nowUri ? " playing" : ""), disabled: t.off,
      onclick: () => playFromPlaylist(t.uri) },
      h("span", { class: "num" }, i + 1),
      t.img ? h("img", { src: t.img, alt: "", loading: "lazy" }) : h("div", { class: "ph" }),
      h("span", { class: "stack tight", style: "flex:1" },
        h("span", { class: "t ellipsis" }, t.title),
        h("span", { class: "muted small ellipsis" }, S.sort === "album" ? (t.album || t.artist) : t.artist)),
      h("span", { class: "side" }, sideInfo(t))
    )));
}
function updateSaveBox() {
  const show = S.sort !== "perso" && S.items.length > 1;
  $("save-box").classList.toggle("hidden", !show);
  if (!show) return;
  if (!canEdit()) {
    $("save-txt").textContent = "Cette playlist appartient à quelqu’un d’autre : le tri s’affiche ici mais ne peut pas être enregistré sur Spotify.";
    $("save-btn").classList.add("hidden");
  } else {
    $("save-txt").textContent = "Ce tri n’est visible que dans Paulify pour l’instant.";
    $("save-btn").classList.remove("hidden");
  }
}

/* enregistrement de l'ordre : on déplace les titres un par un, ce qui garde les dates d'ajout */
function askConfirm(text) {
  return new Promise((resolve) => {
    $("confirm-txt").textContent = text;
    $("confirm").classList.remove("hidden");
    $("confirm-yes").focus();
    const done = (v) => { $("confirm").classList.add("hidden"); $("confirm-yes").onclick = $("confirm-no").onclick = null; resolve(v); };
    $("confirm-yes").onclick = () => done(true);
    $("confirm-no").onclick = () => done(false);
  });
}
async function saveOrder() {
  if (S.saving || !canEdit()) return;
  const label = SORTS.find((s) => s[0] === S.sort)[1];
  const ok = await askConfirm("« " + S.current.name + " » sera triée par " + label.toLowerCase() + " directement sur Spotify. Les dates d’ajout sont conservées.");
  if (!ok) return;
  const p = S.current;
  const target = sortedItems().map((t) => t.idx);
  const cur = S.items.map((t) => t.idx);
  const moves = target.filter((v, i) => cur[i] !== v).length;
  S.saving = true;
  $("save-btn").disabled = true; $("save-cancel").disabled = true;
  try {
    let snap = p.snapshot_id, done = 0;
    for (let i = 0; i < target.length; i++) {
      const j = cur.indexOf(target[i]);
      if (j === i) continue;
      const res = await playlistItemsCall(p.id, "", { method: "PUT", body: JSON.stringify({ range_start: j, insert_before: i, range_length: 1, snapshot_id: snap }) });
      if (res && res.snapshot_id) snap = res.snapshot_id;
      cur.splice(j, 1); cur.splice(i, 0, target[i]);
      done++;
      $("save-txt").textContent = "Enregistrement… " + Math.min(100, Math.round(done / Math.max(1, moves) * 100)) + " %";
    }
    p.snapshot_id = snap;
    toast("Ordre enregistré sur Spotify");
    S.saving = false;
    await openPlaylist(p);
  } catch (e) {
    $("save-txt").textContent = "Erreur pendant l’enregistrement : " + e.message + ". Rouvre la playlist pour voir l’ordre actuel.";
  } finally {
    S.saving = false;
    $("save-btn").disabled = false; $("save-cancel").disabled = false;
  }
}

/* ---------- lecteur ---------- */
function initSdk() {
  window.onSpotifyWebPlaybackSDKReady = () => {
    const player = new Spotify.Player({ name: "Paulify", getOAuthToken: (cb) => getToken().then(cb), volume: 0.8 });
    S.sdkPlayer = player;
    player.addListener("ready", ({ device_id }) => { S.sdkDevice = device_id; S.sdkReady = true; });
    player.addListener("not_ready", () => { S.sdkReady = false; });
    player.addListener("player_state_changed", () => { setTimeout(pollPlayback, 300); });
    player.addListener("autoplay_failed", () => toast("Touche Lecture pour démarrer le son"));
    ["initialization_error", "authentication_error", "account_error", "playback_error"].forEach((ev) =>
      player.addListener(ev, ({ message }) => console.warn("Paulify lecteur :", ev, message)));
    player.connect();
  };
  const s = document.createElement("script");
  s.src = "https://sdk.scdn.co/spotify-player.js";
  document.body.appendChild(s);
}
async function activateSdk() {
  if (S.sdkPlayer && S.sdkPlayer.activateElement) { try { await S.sdkPlayer.activateElement(); } catch (e) {} }
}
const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
let fadeTipShown = false;
async function targetDevice() {
  // 1. un appareil joue déjà : on continue dessus
  if (S.playback && S.playback.device && S.playback.device.id && S.playback.is_playing) return S.playback.device.id;
  const d = await api("/me/player/devices").catch(() => null);
  const list = ((d && d.devices) || []).filter((x) => x.id && !x.is_restricted);
  const others = list.filter((x) => x.id !== S.sdkDevice);
  // 2. le dernier appareil que tu as choisi toi-même
  const pref = ls.get("paulify_pref_device");
  if (pref === "paulify" && S.sdkReady) return S.sdkDevice;
  const prefDev = pref && others.find((x) => x.name === pref);
  if (prefDev) return prefDev.id;
  // 3. sur téléphone : l'appli Spotify du téléphone (fondu enchaîné, écran verrouillé)
  if (IS_MOBILE) {
    const phone = others.find((x) => (x.type || "").toLowerCase() === "smartphone");
    if (phone) return phone.id;
    if (!fadeTipShown) { fadeTipShown = true; toast("Ouvre l’appli Spotify une seconde pour profiter du fondu enchaîné"); }
  }
  // 4. sinon le lecteur intégré à Paulify, puis n'importe quel appareil disponible
  if (S.sdkReady) return S.sdkDevice;
  if (S.playback && S.playback.device && S.playback.device.id) return S.playback.device.id;
  return others[0] ? others[0].id : null;
}
async function playFromPlaylist(uri, shuffle) {
  if (!S.current) return;
  await activateSdk();
  const dev = await targetDevice();
  if (!dev) { toast("Aucun appareil disponible : ouvre Spotify sur ton téléphone, puis réessaie"); return; }
  const q = "?device_id=" + encodeURIComponent(dev);
  try {
    await api("/me/player/shuffle?state=" + (shuffle ? "true" : "false") + "&device_id=" + encodeURIComponent(dev), { method: "PUT" }).catch(() => {});
    const body = { context_uri: S.current.uri };
    if (uri) body.offset = { uri };
    await api("/me/player/play" + q, { method: "PUT", body: JSON.stringify(body) });
    setTimeout(pollPlayback, 600);
  } catch (e) { toast("Lecture impossible : " + e.message); }
}
async function pollPlayback() {
  try {
    const pb = await api("/me/player?additional_types=episode");
    S.playback = pb && pb.item ? pb : (pb && pb.device ? pb : null);
    S.lastPoll = Date.now();
    renderPlayer();
  } catch (e) { /* silencieux */ }
}
function isPlaying() { return !!(S.playback && S.playback.is_playing); }
function playIcon(playing) {
  return playing
    ? '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>'
    : '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
}
function renderPlayer() {
  const pb = S.playback, it = pb && pb.item;
  $("mini").classList.toggle("hidden", !it);
  if (!it) { $("device-name").textContent = pb && pb.device ? pb.device.name : "—"; return; }
  const img = smallestImg((it.album && it.album.images) || it.images, 300);
  const title = it.name || "";
  const artist = (it.artists || []).map((a) => a.name).join(", ") || (it.show && it.show.name) || "";
  $("mini-cover").src = smallestImg((it.album && it.album.images) || it.images, 64) || "";
  $("full-cover").src = img || "";
  $("mini-title").textContent = $("full-title").textContent = title;
  $("mini-artist").textContent = $("full-artist").textContent = artist;
  $("mini-toggle").innerHTML = playIcon(isPlaying());
  $("full-toggle").innerHTML = playIcon(isPlaying()).replace(/20/g, "30");
  $("device-name").textContent = pb.device ? pb.device.name : "—";
  if (!$("view-detail").classList.contains("hidden")) {
    document.querySelectorAll(".track").forEach((el) => el.classList.remove("playing"));
    const list = sortedItems();
    const i = list.findIndex((t) => t.uri === it.uri);
    if (i >= 0 && $("tracks").children[i]) $("tracks").children[i].classList.add("playing");
  }
  tickProgress(true);
}
let seeking = false;
function tickProgress(force) {
  const pb = S.playback; if (!pb || !pb.item) return;
  const dur = pb.item.duration_ms || 1;
  let pos = pb.progress_ms || 0;
  if (pb.is_playing) pos = Math.min(dur, pos + (Date.now() - S.lastPoll));
  $("mini-bar").style.width = (pos / dur * 100) + "%";
  if (!seeking) $("seek").value = Math.round(pos / dur * 1000);
  $("pos").textContent = fmtMs(pos); $("dur").textContent = fmtMs(dur);
}
async function control(action) {
  const pb = S.playback;
  const onSdk = S.sdkReady && pb && pb.device && pb.device.id === S.sdkDevice && S.sdkPlayer;
  try {
    if (action === "toggle") {
      if (onSdk) { await activateSdk(); await S.sdkPlayer.togglePlay(); }
      else await api("/me/player/" + (isPlaying() ? "pause" : "play"), { method: "PUT" });
      if (S.playback) { S.playback.progress_ms = (S.playback.progress_ms || 0) + (S.playback.is_playing ? Date.now() - S.lastPoll : 0); S.lastPoll = Date.now(); S.playback.is_playing = !S.playback.is_playing; renderPlayer(); }
    } else if (action === "next") {
      if (onSdk) await S.sdkPlayer.nextTrack(); else await api("/me/player/next", { method: "POST" });
    } else if (action === "prev") {
      if (onSdk) await S.sdkPlayer.previousTrack(); else await api("/me/player/previous", { method: "POST" });
    }
  } catch (e) { toast("Action impossible : " + e.message); }
  setTimeout(pollPlayback, 500);
}
async function showDevices() {
  const box = $("devices");
  if (!box.classList.contains("hidden")) { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  box.replaceChildren(h("p", { class: "muted small" }, "Recherche des appareils…"));
  try {
    const d = await api("/me/player/devices");
    const list = (d && d.devices) || [];
    if (!list.length) { box.replaceChildren(h("p", { class: "muted small" }, "Aucun appareil trouvé. Ouvre Spotify sur ton téléphone ou ton ordi, puis réessaie.")); return; }
    box.replaceChildren(...list.map((dev) => {
      const isMe = dev.id === S.sdkDevice;
      return h("button", { type: "button", class: "device" + (dev.is_active ? " on" : ""), onclick: async () => {
        try {
          if (isMe) await activateSdk();
          await api("/me/player", { method: "PUT", body: JSON.stringify({ device_ids: [dev.id], play: isPlaying() }) });
          ls.set("paulify_pref_device", isMe ? "paulify" : dev.name);
          toast("Lecture sur " + (isMe ? "Paulify (cet appareil)" : dev.name));
          box.classList.add("hidden");
          setTimeout(pollPlayback, 800);
        } catch (e) { toast("Impossible de changer d’appareil : " + e.message); }
      } },
        h("span", null, isMe ? "Paulify (cet appareil)" : dev.name),
        h("span", { class: "muted small" }, dev.is_active ? "en cours" : (dev.type || "").toLowerCase()));
    }));
  } catch (e) { box.replaceChildren(h("p", { class: "err" }, e.message)); }
}

/* ---------- événements ---------- */
$("login-btn").onclick = startLogin;
$("pl-search").oninput = renderPlaylists;
$("back").onclick = () => {
  if (S.saving) return;
  S.current = null;
  $("view-detail").classList.add("hidden"); $("view-list").classList.remove("hidden");
};
$("d-play").onclick = () => playFromPlaylist(null, false);
$("d-shuffle").onclick = () => playFromPlaylist(null, true);
$("save-btn").onclick = saveOrder;
$("save-cancel").onclick = () => { S.sort = "perso"; renderSorts(); renderTracks(); updateSaveBox(); };
$("mini-open").onclick = () => { $("full").classList.remove("hidden"); tickProgress(true); };
$("full-close").onclick = () => { $("full").classList.add("hidden"); $("devices").classList.add("hidden"); };
$("mini-toggle").onclick = $("full-toggle").onclick = () => control("toggle");
$("next").onclick = () => control("next");
$("prev").onclick = () => control("prev");
$("devices-btn").onclick = showDevices;
function renderPref() {
  const p = ls.get("paulify_pref_device");
  $("pref-txt").textContent = p
    ? "Paulify joue sur « " + (p === "paulify" ? "Paulify (cet appareil)" : p) + " », ton dernier choix."
    : "Automatique : l’appli Spotify sur téléphone, le lecteur Paulify sur ordinateur.";
  $("pref-reset").classList.toggle("hidden", !p);
}
$("pref-reset").onclick = () => { ls.set("paulify_pref_device", null); renderPref(); toast("Choix automatique rétabli"); };
$("avatar").onclick = () => { renderPref(); $("account").classList.remove("hidden"); };
$("account-close").onclick = () => $("account").classList.add("hidden");
$("logout").onclick = logout;
$("seek").oninput = () => { seeking = true; };
$("seek").onchange = async () => {
  const pb = S.playback; seeking = false;
  if (!pb || !pb.item) return;
  const ms = Math.round($("seek").value / 1000 * pb.item.duration_ms);
  try { await api("/me/player/seek?position_ms=" + ms, { method: "PUT" }); pb.progress_ms = ms; S.lastPoll = Date.now(); tickProgress(true); }
  catch (e) { toast("Impossible d’avancer : " + e.message); }
};
document.querySelectorAll(".tab.soon").forEach((b) => { b.onclick = () => toast(b.dataset.soon); });
document.addEventListener("visibilitychange", () => { if (!document.hidden && S.me) pollPlayback(); });

/* ---------- installation (Android / Chrome) ---------- */
let installEvt = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvt = e; $("install-btn").classList.remove("hidden"); });
$("install-btn").onclick = async () => {
  if (!installEvt) return;
  installEvt.prompt();
  await installEvt.userChoice.catch(() => null);
  installEvt = null; $("install-btn").classList.add("hidden");
};
window.addEventListener("appinstalled", () => toast("Paulify est installé"));

/* ---------- démarrage ---------- */
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

(async () => {
  const params = new URLSearchParams(location.search);
  if (params.get("error")) { history.replaceState({}, "", REDIRECT); showLogin("Connexion refusée par Spotify : " + params.get("error")); return; }
  const code = params.get("code");
  if (code) {
    history.replaceState({}, "", REDIRECT);
    try { await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: ls.get("paulify_verifier") }); }
    catch (e) { showLogin("Échec de connexion : " + e.message); return; }
  }
  if (ls.get("paulify_refresh") || ls.get("paulify_access")) {
    const tok = await getToken().catch(() => null);
    if (tok) { showMain(); return; }
  }
  showLogin();
})();
