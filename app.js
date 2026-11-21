import * as tmdb from "./tmdb.js";
import { createStore, exportBackup } from "./store.js";
import { ALL_PLATFORMS, DEFAULT_PLATFORMS, FIREBASE } from "./config.js";
import { initFirebase } from "./firebase-store.js";
import { importTvTime, importTvTimeLists } from "./import.js";
import { buildNews } from "./news.js";

let store = null;
let settings = { platforms: DEFAULT_PLATFORMS };
let fb = null;
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const STATUSES = [
  { id: "watching", label: "Viendo" },
  { id: "paused", label: "En pausa" },
  { id: "pending", label: "Pendiente" },
  { id: "seen", label: "Visto" },
];
let tab = "news";
let typeFilter = "all";
let platformFilter = "all"; // "all", una plataforma, o "none" (en ninguna de las mías)

// ---------- Listas ----------
function progressOf(item) {
  if (item.type !== "tv") return null;
  const done = Object.keys(item.watched || {}).length;
  return { done, total: item.total || 0 };
}

function nextEpisode(item) {
  if (item.type !== "tv" || !item.seasons) return null;
  for (const s of item.seasons) {
    for (let e = 1; e <= s.count; e++) if (!item.watched?.[`s${s.n}e${e}`]) return `T${s.n} · E${e}`;
  }
  return null;
}

function card(item, note = "") {
  const p = progressOf(item);
  const pct = p && p.total ? Math.round((p.done / p.total) * 100) : 0;
  const next = item.status === "watching" ? nextEpisode(item) : null;
  return `
    <button class="card" data-open="${item.type}:${item.id}" aria-label="${esc(item.title)}">
      <div class="poster">${item.poster ? `<img loading="lazy" src="${tmdb.IMG(item.poster)}" alt="">` : `<span>${esc(item.title)}</span>`}
        <span class="badge ${item.type}">${item.type === "tv" ? "Serie" : "Película"}</span>
      </div>
      <div class="meta">
        <strong>${esc(item.title)}</strong>
        <small>${esc(item.year || "")}${next ? ` · Sigue: ${next}` : ""}</small>
        ${note ? `<small class="note">${esc(note)}</small>` : ""}
        ${p && p.total ? `<div class="bar"><i style="width:${pct}%"></i></div><small>${p.done}/${p.total} episodios</small>` : ""}
      </div>
    </button>`;
}

function renderList() {
  const inTab = Object.values(store.all())
    .filter((i) => i.status === tab && (typeFilter === "all" || i.type === typeFilter))
    .sort((a, b) => sortDate(b).localeCompare(sortDate(a)));
  const items = inTab.filter(platformMatch);
  const counts = Object.fromEntries(STATUSES.map((s) => [s.id, 0]));
  Object.values(store.all()).forEach((i) => counts[i.status] != null && counts[i.status]++);
  counts.lists = listIds().length;
  renderPlatformSelect();
  document.querySelectorAll("[data-tab]").forEach((b) => {
    const id = b.dataset.tab;
    b.classList.toggle("on", id === tab);
    const c = b.querySelector(".count");
    if (c) c.textContent = counts[id] ?? "";
  });
  const main = $("#main");
  if (tab === "discover") return renderDiscover(main);
  if (tab === "news") return renderNews(main);
  if (tab === "lists") return renderLists(main);
  if (ensureDetails(inTab, main, platformFilter !== "all")) return;
  main.innerHTML = items.length
    ? `${provJob ? `<p class="hint" id="provTxt">Actualizando fechas y plataformas…</p>` : ""}<div class="grid">${items.map((i) => card(i)).join("")}</div>`
    : platformFilter !== "all"
      ? `<div class="empty"><p>Nada en <b>${STATUSES.find((s) => s.id === tab).label}</b> ${platformFilter === "none" ? "fuera de tus plataformas" : `en ${esc(platformFilter)}`}.</p></div>`
      : `<div class="empty"><p>Aún no hay nada en <b>${STATUSES.find((s) => s.id === tab).label}</b>.</p><p>Busca una serie o película arriba para añadirla.</p></div>`;
}

// Orden: películas por fecha de estreno y series por fecha del último episodio, de más reciente a más antiguo.
const sortDate = (i) => i.date || (i.year ? `${i.year}-01-01` : "");
const detailDate = (d) => d.last_episode_to_air?.air_date || d.last_air_date || d.release_date || d.first_air_date || "";

// ---------- Filtro por plataforma ----------
// Cada título guarda en "prov" las plataformas (de la lista de España) donde está, y cuándo se comprobó.
const PROV_TTL = 7 * 864e5;
function platformMatch(i) {
  if (platformFilter === "all") return true;
  const mine = (i.prov || []).filter((p) => settings.platforms.includes(p));
  return platformFilter === "none" ? i.provAt && !mine.length : mine.includes(platformFilter);
}
function renderPlatformSelect() {
  const sel = $("#platformFilter");
  if (!sel) return;
  sel.hidden = ["news", "lists", "discover"].includes(tab);
  const opts = [["all", "Todas las plataformas"], ...settings.platforms.map((p) => [p, p]), ["none", "En ninguna de las mías"]];
  if (!opts.some(([v]) => v === platformFilter)) platformFilter = "all";
  sel.innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}" ${v === platformFilter ? "selected" : ""}>${esc(l)}</option>`).join("");
}
let provJob = null;
// Completa plataformas y fecha de cada título (una vez por semana). Si "blocking", espera antes de mostrar la lista.
function ensureDetails(list, main, blocking) {
  const stale = list.filter((i) => !i.provAt || i.date === undefined || Date.now() - i.provAt > PROV_TTL);
  if (!stale.length) return false;
  if (provJob) return blocking;
  if (blocking) main.innerHTML = `<p class="hint" id="provTxt">Comprobando en qué plataformas está cada título: 0 de ${stale.length}…</p><div class="bar big"><i id="provBar" style="width:0"></i></div>`;
  provJob = (async () => {
    let done = 0, i = 0;
    const out = [];
    async function worker() {
      while (i < stale.length) {
        const it = stale[i++];
        try {
          const d = await tmdb.details(it.type, it.id);
          out.push({ ...store.get(it.key), prov: tmdb.platformLabels(d), provAt: Date.now(), date: detailDate(d) });
          if (out.length >= 100) await store.putMany(out.splice(0).filter((x) => x.key));
        } catch {}
        done++;
        const t = $("#provTxt"), b = $("#provBar");
        if (t) t.textContent = `${blocking ? "Comprobando en qué plataformas está cada título" : "Actualizando fechas y plataformas"}: ${done} de ${stale.length}…`;
        if (b) b.style.width = `${Math.round((done / stale.length) * 100)}%`;
      }
    }
    await Promise.all(Array.from({ length: 6 }, worker));
    await store.putMany(out.filter((x) => x.key));
  })().finally(() => { provJob = null; renderList(); });
  return blocking;
}

// ---------- Novedades ----------
let newsCache = null;
async function renderNews(main) {
  if (newsCache && Date.now() - newsCache.at < 10 * 60e3) return drawNews(main, newsCache.data);
  main.innerHTML = `<p class="hint">Revisando tus series y tus plataformas…</p>`;
  try {
    const data = await buildNews(store.all());
    newsCache = { at: Date.now(), data };
    if (tab === "news") drawNews(main, data);
  } catch (e) { main.innerHTML = `<div class="empty"><p>No se pudieron cargar las novedades (${esc(e.message)}).</p></div>`; }
}
function drawNews(main, n) {
  const block = (title, list, empty) => `
    <section class="news"><h3>${title}</h3>
      ${list.length ? `<div class="grid">${list.map((x) => card(x.item, x.note)).join("")}</div>` : `<p class="hint">${empty}</p>`}
    </section>`;
  main.innerHTML =
    block("Temporadas completas para ver", n.complete, "Ninguna de tus series ha terminado temporada en los últimos dos meses.") +
    block("Episodios nuevos", n.fresh, "No hay episodios nuevos esta semana en tus series.") +
    block("Próximos estrenos", n.upcoming, "Nada previsto en las próximas semanas.") +
    block("Series nuevas en tus plataformas", n.newShows, "Sin novedades ahora mismo.") +
    block("Películas nuevas en tus plataformas", n.newMovies, "Sin novedades ahora mismo.");
}

// ---------- Listas propias y compartidas ----------
// Lista personal: id "p:<nombre>" (etiqueta en cada título). Compartida: id "s:<docId>" (documento en Firestore).
let currentList = null;
const personalLists = () => {
  const names = new Set(settings.lists || []);
  Object.values(store.all()).forEach((i) => (i.lists || []).forEach((l) => names.add(l)));
  return [...names];
};
const sharedLists = () => (store.shared ? store.shared() : []);
const listIds = () => [...personalLists().map((n) => `p:${n}`), ...sharedLists().map((s) => `s:${s.id}`)];
const sharedById = (id) => sharedLists().find((s) => s.id === id);
const listLabel = (lid) => lid.startsWith("p:") ? lid.slice(2) : `👥 ${sharedById(lid.slice(2))?.name || ""}`;
function listItems(lid) {
  if (lid.startsWith("p:")) { const n = lid.slice(2); return Object.values(store.all()).filter((i) => (i.lists || []).includes(n)); }
  const s = sharedById(lid.slice(2));
  return s ? Object.values(s.items || {}).map((x) => ({ ...x, ...(store.get(x.key) || {}) })) : [];
}
const inList = (lid, key) => lid.startsWith("p:") ? (store.get(key)?.lists || []).includes(lid.slice(2)) : !!sharedById(lid.slice(2))?.items?.[key];

function renderLists(main) {
  const ids = listIds();
  if (!ids.length) { main.innerHTML = `<div class="empty"><p>Aún no tienes listas.</p><p><button class="primary" data-listact="new">+ Nueva lista</button></p><p>También puedes importar tus listas de TV Time en Ajustes.</p></div>`; return; }
  if (!ids.includes(currentList)) currentList = ids[0];
  const items = listItems(currentList).filter((i) => typeFilter === "all" || i.type === typeFilter);
  const sh = currentList.startsWith("s:") ? sharedById(currentList.slice(2)) : null;
  const me = store.user?.email;
  main.innerHTML = `<div class="listchips">${ids.map((l) => `<button data-list="${esc(l)}" class="${l === currentList ? "on" : ""}">${esc(listLabel(l))} <span class="count">${listItems(l).length}</span></button>`).join("")}</div>
    <div class="listbar">
      ${sh ? `<span class="sub">Compartida con ${esc(sh.members.filter((m) => m !== me).join(", ") || "nadie más")}</span>` : ""}
      <button class="link" data-listact="new">+ Nueva lista</button>
      <button class="link" data-listact="rename">Renombrar</button>
      ${store.mode === "firebase" ? `<button class="link" data-listact="share">${sh ? "Añadir persona" : "Compartir"}</button>` : ""}
      <button class="link danger" data-listact="delete">${sh && sh.owner !== me ? "Salir de la lista" : "Eliminar lista"}</button>
    </div>
    ${items.length ? `<div class="grid">${items.sort((a, b) => a.title.localeCompare(b.title)).map((i) => card(i)).join("")}</div>` : `<p class="hint">Esta lista está vacía.</p>`}`;
}

async function listAction(act) {
  if (act === "new") {
    const name = (prompt("Nombre de la nueva lista") || "").trim();
    if (!name) return;
    const share = store.mode === "firebase" && confirm(`¿Quieres compartir "${name}" con alguien para que también pueda añadir títulos?`);
    if (share) {
      const emails = askEmails("Email de la persona (si son varias, sepáralos con comas). Tiene que estar en tu lista de personas autorizadas.");
      if (emails.length) {
        const id = await store.createShared({ name, members: [store.user.email, ...emails], items: {} });
        currentList = `s:${id}`; renderList(); return;
      }
    }
    settings = { ...settings, lists: [...new Set([...(settings.lists || []), name])] };
    await store.saveSettings(settings);
    currentList = `p:${name}`; renderList(); return;
  }
  const lid = currentList;
  if (!lid) return;
  if (lid.startsWith("p:")) {
    const name = lid.slice(2);
    const tagged = Object.values(store.all()).filter((i) => (i.lists || []).includes(name));
    if (act === "rename") {
      const nn = (prompt("Nuevo nombre de la lista", name) || "").trim();
      if (!nn || nn === name) return;
      await store.putMany(tagged.map((i) => ({ ...i, lists: [...new Set(i.lists.map((x) => (x === name ? nn : x)))] })));
      settings = { ...settings, lists: [...new Set((settings.lists || []).map((x) => (x === name ? nn : x)))] };
      await store.saveSettings(settings);
      currentList = `p:${nn}`;
    } else if (act === "delete") {
      if (!confirm(`¿Eliminar la lista "${name}"? Los títulos siguen en tus pestañas; solo se quita la lista.`)) return;
      await store.putMany(tagged.map((i) => ({ ...i, lists: i.lists.filter((x) => x !== name) })));
      settings = { ...settings, lists: (settings.lists || []).filter((x) => x !== name) };
      await store.saveSettings(settings);
      currentList = null;
    } else if (act === "share") {
      const emails = askEmails(`¿Con quién quieres compartir "${name}"? Escribe su email (si son varios, sepáralos con comas). Tiene que estar en tu lista de personas autorizadas.`);
      if (!emails.length) return;
      const items = Object.fromEntries(tagged.map((i) => [i.key, briefOf(i)]));
      const id = await store.createShared({ name, members: [store.user.email, ...emails], items });
      await store.putMany(tagged.map((i) => ({ ...i, lists: i.lists.filter((x) => x !== name) })));
      settings = { ...settings, lists: (settings.lists || []).filter((x) => x !== name) };
      await store.saveSettings(settings);
      currentList = `s:${id}`;
    }
  } else {
    const s = sharedById(lid.slice(2));
    if (!s) return;
    if (act === "rename") {
      const nn = (prompt("Nuevo nombre de la lista", s.name) || "").trim();
      if (nn && nn !== s.name) await store.updateShared(s.id, { name: nn });
    } else if (act === "share") {
      const emails = askEmails("Email de la persona que quieres añadir (tiene que estar en tu lista de personas autorizadas).");
      if (emails.length) await store.updateShared(s.id, { members: [...new Set([...s.members, ...emails])] });
    } else if (act === "delete") {
      const owner = s.owner === store.user.email;
      if (!confirm(owner ? `¿Eliminar "${s.name}" para todas las personas con las que la compartes?` : `¿Salir de "${s.name}"? Dejarás de verla.`)) return;
      if (owner) await store.deleteShared(s.id);
      else await store.updateShared(s.id, { members: s.members.filter((m) => m !== store.user.email) });
      currentList = null;
    }
  }
  renderList();
}
function askEmails(msg) {
  return (prompt(msg) || "").split(/[,;\s]+/).map((e) => e.trim().toLowerCase()).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && e !== store.user?.email);
}
const briefOf = (i) => ({ key: i.key, id: i.id, type: i.type, title: i.title, poster: i.poster || "", year: i.year || "" });

async function renderDiscover(main) {
  if (!tmdb.hasKey()) {
    main.innerHTML = `<div class="empty"><p>Falta la clave de TMDB para ver tendencias.</p></div>`;
    return;
  }
  main.innerHTML = `<p class="hint">Lo más visto esta semana que aún no tienes en Screenbook</p><div class="grid" id="trend"></div>`;
  try {
    const pages = await Promise.all([1, 2, 3, 4].map((p) => tmdb.trending(p)));
    const seenKeys = new Set();
    const list = pages.flat().filter((r) => {
      const k = `${r.type}:${r.id}`;
      if (seenKeys.has(k) || store.get(k)) return false;
      seenKeys.add(k); return true;
    }).filter((r) => typeFilter === "all" || r.type === typeFilter).slice(0, 40);
    $("#trend").innerHTML = list.length ? list.map((r) => card(r)).join("") : `<p class="hint">Ya tienes todo lo más visto de la semana.</p>`;
  } catch (e) {
    main.innerHTML = `<div class="empty"><p>No se pudo cargar TMDB (${esc(e.message)}).</p></div>`;
  }
}

// ---------- Búsqueda ----------
let searchTimer;
function onSearch(q) {
  clearTimeout(searchTimer);
  const box = $("#results");
  if (q.trim().length < 2) { box.hidden = true; return; }
  searchTimer = setTimeout(async () => {
    if (!tmdb.hasKey()) { box.hidden = false; box.innerHTML = `<p class="hint">Falta la clave de TMDB.</p>`; return; }
    try {
      const res = await tmdb.search(q);
      box.hidden = false;
      box.innerHTML = res.length
        ? res.slice(0, 12).map((r) => `
          <button class="row" data-open="${r.type}:${r.id}">
            ${r.poster ? `<img src="${tmdb.IMG(r.poster, "w92")}" alt="">` : `<span class="noimg"></span>`}
            <span><strong>${esc(r.title)}</strong><small>${r.type === "tv" ? "Serie" : "Película"} ${esc(r.year)}</small></span>
            ${store.get(`${r.type}:${r.id}`) ? `<em>${STATUSES.find((s) => s.id === store.get(`${r.type}:${r.id}`).status)?.label || ""}</em>` : ""}
          </button>`).join("")
        : `<p class="hint">Sin resultados.</p>`;
    } catch (e) {
      box.hidden = false; box.innerHTML = `<p class="hint">Error al buscar: ${esc(e.message)}</p>`;
    }
  }, 300);
}

// ---------- Ficha ----------
let currentLoadEpisodes = null;
async function openDetail(type, id) {
  $("#results").hidden = true;
  const dlg = $("#detail");
  dlg.innerHTML = `<div class="sheet"><p class="hint">Cargando…</p></div>`;
  if (!dlg.open) dlg.showModal();
  let d;
  try { d = await tmdb.details(type, id); }
  catch (e) { dlg.innerHTML = `<div class="sheet"><button class="close" data-close>×</button><p class="hint">No se pudo cargar: ${esc(e.message)}</p></div>`; return; }
  const key = `${type}:${id}`;
  const base = { ...tmdb.brief(d, type), key };
  const seasons = type === "tv"
    ? (d.seasons || []).filter((s) => s.season_number > 0 && s.episode_count > 0).map((s) => ({ n: s.season_number, count: s.episode_count, name: s.name, air: s.air_date }))
    : null;
  const total = seasons ? seasons.reduce((a, s) => a + s.count, 0) : 0;
  const item = () => store.get(key);
  // Mantén al día temporadas y episodios guardados.
  if (item() && type === "tv") store.put({ ...item(), seasons: seasons.map(({ n, count }) => ({ n, count })), total });

  const provs = tmdb.providers(d);
  const mine = provs.filter((p) => p.mine);
  if (item()) store.put({ ...item(), prov: tmdb.platformLabels(d), provAt: Date.now(), date: detailDate(d) });
  const lastAired = d.last_episode_to_air;
  const nextAir = d.next_episode_to_air;

  function draw() {
    const it = item();
    dlg.innerHTML = `
    <div class="sheet">
      <button class="close" data-close aria-label="Cerrar">×</button>
      <div class="hero" style="${d.backdrop_path ? `background-image:url(${tmdb.IMG(d.backdrop_path, "w780")})` : ""}"></div>
      <div class="head">
        ${d.poster_path ? `<img class="p" src="${tmdb.IMG(d.poster_path)}" alt="">` : ""}
        <div>
          <h2>${esc(base.title)}</h2>
          <p class="sub">${type === "tv" ? "Serie" : "Película"} · ${esc(base.year)}${type === "tv" ? ` · ${seasons.length} temporada${seasons.length === 1 ? "" : "s"} · ${total} episodios` : d.runtime ? ` · ${d.runtime} min` : ""}</p>
          ${type === "tv" ? `<p class="sub">${statusText(d)}</p>` : ""}
        </div>
      </div>
      <section>
        <h3>Dónde verla en España</h3>
        ${provs.length ? `<div class="chips">${provs.map((p) => `<span class="chip ${p.mine ? "mine" : ""}">${p.logo ? `<img src="${p.logo}" alt="">` : ""}${esc(p.name)}</span>`).join("")}</div>
          ${mine.length ? "" : `<p class="warn">No está en tus plataformas.</p>`}`
          : `<p class="warn">No está incluida en ninguna plataforma de suscripción en España.</p>`}
      </section>
      <section class="status">
        ${STATUSES.map((s) => `<button data-status="${s.id}" class="${it?.status === s.id ? "on" : ""}">${s.label}</button>`).join("")}
        ${it ? `<button data-status="remove" class="ghost">Quitar</button>` : ""}
      </section>
      <section>
        <h3>Mis listas</h3>
        <div class="listchips small">${listIds().map((l) => `<button data-togglelist="${esc(l)}" class="${inList(l, key) ? "on" : ""}">${esc(listLabel(l))}</button>`).join("")}
          <button data-newlist class="ghost">+ Nueva lista</button></div>
      </section>
      ${d.overview ? `<section><p class="overview">${esc(d.overview)}</p></section>` : ""}
      ${type === "tv" ? `<section><h3>Temporadas</h3>${seasons.map((s) => seasonRow(s, it)).join("")}</section>` : ""}
    </div>`;
  }

  function statusText(d) {
    if (nextAir) return `Próximo episodio: ${fmtDate(nextAir.air_date)} (T${nextAir.season_number} · E${nextAir.episode_number})`;
    if (d.status === "Ended" || d.status === "Canceled") return d.status === "Ended" ? "Serie finalizada" : "Serie cancelada";
    if (lastAired) return `Último emitido: T${lastAired.season_number} · E${lastAired.episode_number}`;
    return "";
  }

  function seasonAired(s) {
    if (!lastAired) return 0;
    if (s.n < lastAired.season_number) return s.count;
    if (s.n === lastAired.season_number) return lastAired.episode_number;
    return 0;
  }

  function seasonRow(s, it) {
    const seen = Array.from({ length: s.count }, (_, i) => it?.watched?.[`s${s.n}e${i + 1}`]).filter(Boolean).length;
    const aired = seasonAired(s);
    const tag = aired >= s.count ? `<span class="tag ok">Completa</span>` : aired > 0 ? `<span class="tag">En emisión · ${aired}/${s.count}</span>` : `<span class="tag">Próximamente</span>`;
    return `
      <details data-season="${s.n}">
        <summary>
          <span>${esc(s.name || `Temporada ${s.n}`)} ${tag}</span>
          <span class="sc">${seen}/${s.count}</span>
        </summary>
        <div class="eps" id="eps-${s.n}"><p class="hint">Cargando episodios…</p></div>
        <button class="small" data-markseason="${s.n}">${seen === s.count ? "Desmarcar temporada" : "Marcar temporada como vista"}</button>
      </details>`;
  }

  async function loadEpisodes(n) {
    const box = $(`#eps-${n}`, dlg);
    try {
      const s = await tmdb.season(id, n);
      const it = item();
      box.innerHTML = s.episodes.map((e) => {
        const k = `s${n}e${e.episode_number}`;
        const future = e.air_date && new Date(e.air_date) > new Date();
        return `<label class="ep ${future ? "future" : ""}">
          <input type="checkbox" data-ep="${k}" ${it?.watched?.[k] ? "checked" : ""}>
          <span><b>${e.episode_number}.</b> ${esc(e.name || "")}</span>
          <small>${e.air_date ? fmtDate(e.air_date) : ""}</small>
        </label>`;
      }).join("");
    } catch (e) { box.innerHTML = `<p class="hint">Error: ${esc(e.message)}</p>`; }
  }

  async function setWatched(changes) {
    const it = item() || { ...base, status: "watching", addedAt: Date.now(), watched: {} };
    const watched = { ...(it.watched || {}) };
    for (const [k, v] of Object.entries(changes)) v ? (watched[k] = Date.now()) : delete watched[k];
    let status = it.status === "pending" ? "watching" : it.status;
    const allDone = Object.keys(watched).length >= total && total > 0;
    if (allDone && !nextAir && (d.status === "Ended" || d.status === "Canceled")) status = "seen";
    await store.put({ ...it, ...base, seasons: seasons.map(({ n, count }) => ({ n, count })), total, watched, status });
  }

  draw();
  dlg.onclick = async (ev) => {
    const t = ev.target;
    if (t === dlg || t.closest("[data-close]")) return dlg.close();
    const tl = t.closest("[data-togglelist]")?.dataset.togglelist;
    const nl = t.closest("[data-newlist]");
    if (tl && tl.startsWith("s:")) {
      await store.setSharedItem(tl.slice(2), key, inList(tl, key) ? null : briefOf(base));
      redrawKeepingOpen();
      return;
    }
    if (tl || nl) {
      const name = tl ? tl.slice(2) : (prompt("Nombre de la nueva lista") || "").trim();
      if (!name) return;
      if (nl && !(settings.lists || []).includes(name)) {
        settings = { ...settings, lists: [...(settings.lists || []), name] };
        store.saveSettings(settings).catch(() => {});
      }
      const cur = item() || { ...base, addedAt: Date.now(), watched: {}, status: "pending",
        ...(seasons ? { seasons: seasons.map(({ n, count }) => ({ n, count })), total } : {}) };
      const has = (cur.lists || []).includes(name);
      await store.put({ ...cur, lists: has && tl ? cur.lists.filter((x) => x !== name) : [...new Set([...(cur.lists || []), name])] });
      redrawKeepingOpen();
      return;
    }
    const st = t.closest("[data-status]")?.dataset.status;
    if (st) {
      if (st === "remove") await store.remove(key);
      else await store.put({ ...(item() || { ...base, addedAt: Date.now(), watched: {} }), ...base,
        ...(seasons ? { seasons: seasons.map(({ n, count }) => ({ n, count })), total } : {}), status: st });
      const open = [...dlg.querySelectorAll("details[open]")].map((x) => x.dataset.season);
      draw(); open.forEach((n) => { const el = $(`details[data-season="${n}"]`, dlg); el.open = true; });
      return;
    }
    const ms = t.closest("[data-markseason]")?.dataset.markseason;
    if (ms) {
      const s = seasons.find((x) => x.n === +ms);
      const it = item();
      const allSeen = Array.from({ length: s.count }, (_, i) => it?.watched?.[`s${s.n}e${i + 1}`]).every(Boolean);
      await setWatched(Object.fromEntries(Array.from({ length: s.count }, (_, i) => [`s${s.n}e${i + 1}`, !allSeen])));
      redrawKeepingOpen();
    }
  };
  dlg.onchange = async (ev) => {
    const k = ev.target.dataset?.ep;
    if (!k) return;
    await setWatched({ [k]: ev.target.checked });
    redrawKeepingOpen();
  };
  currentLoadEpisodes = loadEpisodes;

  function redrawKeepingOpen() {
    const open = [...dlg.querySelectorAll("details[open]")].map((x) => x.dataset.season);
    const scroll = $(".sheet", dlg).scrollTop;
    draw();
    open.forEach((n) => { $(`details[data-season="${n}"]`, dlg).open = true; });
    $(".sheet", dlg).scrollTop = scroll;
  }
}

const fmtDate = (s) => new Date(s).toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric" });

// ---------- Ajustes ----------
function openSettings() {
  const dlg = $("#settings");
  dlg.innerHTML = `
    <form method="dialog" class="sheet pad">
      <button class="close" value="cancel" aria-label="Cerrar">×</button>
      ${store.mode === "firebase" ? `<p class="sub account">Conectada como <b>${esc(store.user.email)}</b> · <button type="button" class="link" id="logout">Cerrar sesión</button></p>
        ${localCount() ? `<p class="sub">Este navegador tiene ${localCount()} títulos guardados de antes. <button type="button" class="link" id="uploadLocal">Pasarlos a mi cuenta</button></p>` : ""}` : ""}
      <h2>Mis plataformas</h2>
      <p class="sub">Marca a las que estás suscrita. Se resaltarán en cada ficha y se usarán para tus avisos.</p>
      <div class="plats">
        ${ALL_PLATFORMS.map((p) => `<label class="plat"><input type="checkbox" name="p" value="${esc(p.label)}" ${settings.platforms.includes(p.label) ? "checked" : ""}><span>${esc(p.label)}</span></label>`).join("")}
      </div>
      <div class="status"><button value="save" class="on">Guardar</button></div>
      <hr>
      <h2>Importar de TV Time</h2>
      <p class="sub">Elige tu archivo <b>tvtime.json</b>. Se procesa en tu navegador y no pisa lo que ya tengas aquí.</p>
      <label class="file"><input type="file" id="tvtimeFile" accept=".json,application/json"><span>Elegir archivo…</span></label>
      <div id="importOut"></div>
      <p class="sub" style="margin-top:16px">¿Ya importaste tu historial? Con el mismo archivo puedes traer tus <b>listas</b> (Classics, Spanish movies…).</p>
      <label class="file"><input type="file" id="tvtimeLists" accept=".json,application/json"><span>Importar mis listas…</span></label>
      <div id="importListsOut"></div>
    </form>`;
  $("#tvtimeFile", dlg).onchange = (e) => runImport(e.target.files[0]);
  $("#tvtimeLists", dlg).onchange = (e) => runImportLists(e.target.files[0]);
  const lo = $("#logout", dlg); if (lo) lo.onclick = () => fb.signOut().then(() => location.reload());
  const up = $("#uploadLocal", dlg);
  if (up) up.onclick = async () => {
    const local = createStore();
    const mine = store.all();
    const list = Object.values(local.all()).filter((x) => !mine[x.key]);
    up.disabled = true; up.textContent = "Subiendo…";
    await store.putMany(list);
    await local.replaceAll({});
    up.parentElement.textContent = `Hecho: ${list.length} títulos pasados a tu cuenta.`;
  };
  dlg.onclose = () => {
    if (dlg.returnValue !== "save") return;
    const chosen = [...dlg.querySelectorAll('input[name="p"]:checked')].map((i) => i.value);
    settings = { ...settings, platforms: chosen };
    store.saveSettings(settings).catch((e) => alertBox(`No se pudieron guardar los ajustes: ${e.message}`));
    tmdb.setMyPlatforms(chosen);
    renderList();
  };
  dlg.showModal();
}

async function runImportLists(file) {
  const out = $("#importListsOut");
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch { out.innerHTML = `<p class="warn">El archivo no es válido.</p>`; return; }
  if (data.source !== "tvtime") { out.innerHTML = `<p class="warn">Este no parece el archivo de TV Time.</p>`; return; }
  out.innerHTML = `<p class="sub" id="impLTxt">Preparando…</p><div class="bar big"><i id="impLBar" style="width:0"></i></div>`;
  const res = await importTvTimeLists(data, store, (n, total) => {
    $("#impLBar").style.width = `${Math.round((n / total) * 100)}%`;
    $("#impLTxt").textContent = `Buscando los títulos de tus listas: ${n} de ${total}`;
  });
  settings = { ...settings, lists: [...new Set([...(settings.lists || []), ...res.lists])] };
  await store.saveSettings(settings).catch(() => {});
  out.innerHTML = `<p class="sub">Importadas ${res.lists.length} listas con ${res.tagged} títulos (${res.added} eran nuevos y están en Pendiente).</p>
    ${res.missing.length ? `<details><summary>No encontrados en TMDB (${res.missing.length})</summary><ul class="missing">${res.missing.map((m) => `<li>${esc(m)}</li>`).join("")}</ul></details>` : ""}`;
  renderList();
}

async function runImport(file) {
  const out = $("#importOut");
  if (!file) return;
  if (!tmdb.hasKey()) { out.innerHTML = `<p class="warn">Falta la clave de TMDB.</p>`; return; }
  let data;
  try { data = JSON.parse(await file.text()); } catch { out.innerHTML = `<p class="warn">El archivo no es válido.</p>`; return; }
  if (data.source !== "tvtime") { out.innerHTML = `<p class="warn">Este no parece el archivo de TV Time.</p>`; return; }
  out.innerHTML = `<p class="sub" id="impTxt">Preparando…</p><div class="bar big"><i id="impBar" style="width:0"></i></div>`;
  const res = await importTvTime(data, store, (n, total) => {
    $("#impBar").style.width = `${Math.round((n / total) * 100)}%`;
    $("#impTxt").textContent = `Buscando tus títulos en TMDB: ${n} de ${total}`;
  });
  const by = (s) => res.added.filter((x) => x.status === s).length;
  out.innerHTML = `<p class="sub">Importados ${res.added.length} títulos: ${by("watching")} en Viendo, ${by("pending")} en Pendiente, ${by("seen")} en Visto y ${by("paused")} en pausa.</p>
    ${res.missing.length ? `<details><summary>No encontrados en TMDB (${res.missing.length})</summary><ul class="missing">${res.missing.map((m) => `<li>${esc(m)}</li>`).join("")}</ul></details>` : ""}`;
  renderList();
}

// ---------- Arranque ----------
document.addEventListener("click", (ev) => {
  if (!store) return;
  const open = ev.target.closest("[data-open]");
  if (open && !ev.target.closest("#detail")) {
    const [type, id] = open.dataset.open.split(":");
    return openDetail(type, +id);
  }
  const lc = ev.target.closest("[data-list]");
  if (lc) { currentList = lc.dataset.list; renderList(); return; }
  const la = ev.target.closest("[data-listact]");
  if (la) { listAction(la.dataset.listact).catch((e) => alertBox(`No se pudo completar: ${e.message}`)); return; }
  const t = ev.target.closest("[data-tab]");
  if (t) { tab = t.dataset.tab; renderList(); }
  const f = ev.target.closest("[data-type]");
  if (f) {
    typeFilter = f.dataset.type;
    document.querySelectorAll("[data-type]").forEach((b) => b.classList.toggle("on", b === f));
    renderList();
  }
  if (ev.target.closest("#backup")) exportBackup(store.all());
  if (ev.target.closest("#settingsBtn")) openSettings();
  if (!ev.target.closest(".search")) $("#results").hidden = true;
});
$("#q").addEventListener("input", (e) => onSearch(e.target.value));
$("#platformFilter").addEventListener("change", (e) => { platformFilter = e.target.value; renderList(); });
$("#q").addEventListener("focus", (e) => onSearch(e.target.value));
$("#detail").addEventListener("close", renderList);
$("#detail").addEventListener("toggle", (ev) => {
  const el = ev.target;
  if (el.tagName === "DETAILS" && el.open && currentLoadEpisodes) currentLoadEpisodes(+el.dataset.season);
}, true);
function alertBox(msg) { $("#main").insertAdjacentHTML("afterbegin", `<p class="notice">${esc(msg)}</p>`); }
function localCount() { try { return Object.keys(createStore().all()).length; } catch { return 0; } }

function startWith(s) {
  store = s;
  settings = { platforms: DEFAULT_PLATFORMS, ...(store.getSettings() || {}) };
  tmdb.setMyPlatforms(settings.platforms);
  document.body.classList.remove("locked");
  store.subscribe(() => { newsCache = null; if (!$("#detail").open) renderList(); });
}

function showLogin(message = "") {
  document.body.classList.add("locked");
  $("#main").innerHTML = `
    <div class="login">
      <h2>Tu diario de series y películas</h2>
      <p class="sub">Entra para ver tus listas en cualquier dispositivo.</p>
      ${message ? `<p class="warn">${esc(message)}</p>` : ""}
      <button id="signin" class="primary">Entrar con Google</button>
      <p class="sub or">o con cualquier email (Outlook, Hotmail…)</p>
      <form id="emailForm" class="emailform">
        <input id="email" type="email" required placeholder="tu@email.com" autocomplete="email">
        <button class="ghost">Enviarme un enlace</button>
      </form>
      <p class="sub" id="emailMsg"></p>
    </div>`;
  $("#signin").onclick = () => fb.signIn().catch((e) => showLogin(`No se pudo entrar: ${e.message}`));
  $("#emailForm").onsubmit = async (ev) => {
    ev.preventDefault();
    const email = $("#email").value.trim().toLowerCase();
    $("#emailMsg").textContent = "Enviando…";
    try {
      await fb.sendEmailLink(email);
      $("#emailMsg").innerHTML = `Te he enviado un enlace a <b>${esc(email)}</b>. Ábrelo en este mismo dispositivo para entrar. Si no lo ves, mira en correo no deseado.`;
    } catch (e) { $("#emailMsg").textContent = `No se pudo enviar el enlace: ${e.message}`; }
  };
}

let loginErr = "";
async function boot() {
  if (!FIREBASE) return startWith(createStore());
  $("#main").innerHTML = `<p class="hint">Cargando…</p>`;
  try { fb = await initFirebase(FIREBASE); }
  catch (e) { $("#main").innerHTML = `<div class="empty"><p>No se pudo cargar Firebase (${esc(e.message)}).</p></div>`; return; }
  await fb.getRedirectResult();
  try { await fb.completeEmailLink(() => prompt("Confirma tu email para entrar")); }
  catch (e) { loginErr = `No se pudo entrar con el enlace: ${e.message}`; }
  let started = false;
  let loginMsg = loginErr;
  fb.onUser(async (user) => {
    if (!user) return showLogin(loginMsg);
    if (started) return;
    try { startWith(await fb.openStore(user)); started = true; }
    catch (e) {
      const denied = e.code === "permission-denied";
      loginMsg = denied ? `La cuenta ${user.email} no tiene acceso. Pide a quien gestiona Screenbook que te añada.` : `Error: ${e.message}`;
      showLogin(loginMsg);
      await fb.signOut();
      return;
    }
  });
}
boot();

if (!tmdb.hasKey()) $("#notice").hidden = false;
