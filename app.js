import * as tmdb from "./tmdb.js";
import { createStore, exportBackup, loadSettings, saveSettings } from "./store.js";
import { ALL_PLATFORMS, DEFAULT_PLATFORMS } from "./config.js";
import { importTvTime } from "./import.js";

const store = createStore();
let settings = { platforms: DEFAULT_PLATFORMS, ...loadSettings() };
tmdb.setMyPlatforms(settings.platforms);
const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const STATUSES = [
  { id: "watching", label: "Viendo" },
  { id: "pending", label: "Pendiente" },
  { id: "seen", label: "Visto" },
  { id: "paused", label: "En pausa" },
];
let tab = "watching";
let typeFilter = "all";

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

function card(item) {
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
        ${p && p.total ? `<div class="bar"><i style="width:${pct}%"></i></div><small>${p.done}/${p.total} episodios</small>` : ""}
      </div>
    </button>`;
}

function renderList() {
  const items = Object.values(store.all())
    .filter((i) => i.status === tab && (typeFilter === "all" || i.type === typeFilter))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const counts = Object.fromEntries(STATUSES.map((s) => [s.id, 0]));
  Object.values(store.all()).forEach((i) => counts[i.status] != null && counts[i.status]++);
  document.querySelectorAll("[data-tab]").forEach((b) => {
    const id = b.dataset.tab;
    b.classList.toggle("on", id === tab);
    const c = b.querySelector(".count");
    if (c) c.textContent = counts[id] ?? "";
  });
  const main = $("#main");
  if (tab === "discover") return renderDiscover(main);
  main.innerHTML = items.length
    ? `<div class="grid">${items.map(card).join("")}</div>`
    : `<div class="empty"><p>Aún no hay nada en <b>${STATUSES.find((s) => s.id === tab).label}</b>.</p><p>Busca una serie o película arriba para añadirla.</p></div>`;
}

async function renderDiscover(main) {
  if (!tmdb.hasKey()) {
    main.innerHTML = `<div class="empty"><p>Falta la clave de TMDB para ver tendencias.</p></div>`;
    return;
  }
  main.innerHTML = `<p class="hint">Lo más visto esta semana</p><div class="grid" id="trend"></div>`;
  try {
    const list = await tmdb.trending();
    $("#trend").innerHTML = list.map((r) => card({ ...r, ...(store.get(`${r.type}:${r.id}`) || {}) })).join("");
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
    </form>`;
  $("#tvtimeFile", dlg).onchange = (e) => runImport(e.target.files[0]);
  dlg.onclose = () => {
    if (dlg.returnValue !== "save") return;
    const chosen = [...dlg.querySelectorAll('input[name="p"]:checked')].map((i) => i.value);
    settings = { ...settings, platforms: chosen };
    saveSettings(settings);
    tmdb.setMyPlatforms(chosen);
    renderList();
  };
  dlg.showModal();
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
  const open = ev.target.closest("[data-open]");
  if (open && !ev.target.closest("#detail")) {
    const [type, id] = open.dataset.open.split(":");
    return openDetail(type, +id);
  }
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
$("#q").addEventListener("focus", (e) => onSearch(e.target.value));
$("#detail").addEventListener("close", renderList);
$("#detail").addEventListener("toggle", (ev) => {
  const el = ev.target;
  if (el.tagName === "DETAILS" && el.open && currentLoadEpisodes) currentLoadEpisodes(+el.dataset.season);
}, true);
store.subscribe(() => { if (!$("#detail").open) renderList(); });

if (!tmdb.hasKey()) $("#notice").hidden = false;
