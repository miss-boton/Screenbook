// Importa el historial de TV Time (archivo tvtime.json preparado a partir de la
// exportación de datos). El archivo se lee en tu navegador y no se sube a ningún sitio.
import * as tmdb from "./tmdb.js";

const RECENT_DAYS = 365;

async function pool(list, size, fn, onTick) {
  let i = 0, done = 0;
  const out = new Array(list.length);
  async function worker() {
    while (i < list.length) {
      const k = i++;
      try { out[k] = await fn(list[k]); } catch { out[k] = null; }
      onTick(++done, list.length);
    }
  }
  await Promise.all(Array.from({ length: size }, worker));
  return out;
}

function airedCount(d, seasons) {
  const last = d.last_episode_to_air;
  if (!last) return 0;
  return seasons.reduce((a, s) => a + (s.n < last.season_number ? s.count : s.n === last.season_number ? Math.min(last.episode_number, s.count) : 0), 0);
}

export async function importTvTime(data, store, onProgress) {
  const existing = store.all();
  const result = { added: [], missing: [] };
  const now = Date.now();
  const series = data.series || [];
  const movies = data.movies || [];
  const total = series.length + movies.length;
  let base = 0;
  const tick = (n) => onProgress(base + n, total);

  // Series
  const seriesItems = await pool(series, 6, async (s) => {
    const hit = await tmdb.findByTvdb(s.tvdb_id);
    if (!hit) { result.missing.push(`${s.name} (serie)`); return null; }
    const d = await tmdb.details("tv", hit.id);
    const seasons = (d.seasons || []).filter((x) => x.season_number > 0 && x.episode_count > 0).map((x) => ({ n: x.season_number, count: x.episode_count }));
    const totalEps = seasons.reduce((a, x) => a + x.count, 0);
    const watched = Object.fromEntries(Object.entries(s.episodes || {}).filter(([k]) => {
      const [, sn, en] = k.match(/s(\d+)e(\d+)/).map(Number);
      const se = seasons.find((x) => x.n === sn);
      return se && en <= se.count;
    }));
    const seen = Object.keys(watched).length;
    const lastDate = Object.values(watched).sort().pop();
    const recent = lastDate && (now - new Date(lastDate)) / 864e5 < RECENT_DAYS;
    const ended = d.status === "Ended" || d.status === "Canceled";
    let status;
    if (seen === 0) status = "pending";
    else if (seen >= airedCount(d, seasons) && ended) status = "seen";
    else if (seen >= airedCount(d, seasons) || recent) status = "watching";
    else status = "paused"; // empezada y sin actividad en el último año
    return { ...tmdb.brief(d, "tv"), key: `tv:${d.id}`, status, watched, seasons, total: totalEps,
      favorite: !!s.favorite, addedAt: now, updatedAt: lastDate ? new Date(lastDate).getTime() : now, from: "tvtime" };
  }, tick);
  base = series.length;

  // Películas
  const movieItems = await pool(movies, 6, async (m) => {
    const hit = await tmdb.searchMovie(m.name, m.year);
    if (!hit) { result.missing.push(`${m.name}${m.year ? ` (${m.year})` : ""}`); return null; }
    return { ...tmdb.brief(hit, "movie"), key: `movie:${hit.id}`, status: m.watched ? "seen" : "pending",
      watched: {}, watchedOn: m.watched_on || null, addedAt: now,
      updatedAt: m.watched_on ? new Date(m.watched_on).getTime() : now, from: "tvtime" };
  }, tick);

  // No pisa lo que ya tengas en Screenbook.
  const toAdd = [...seriesItems, ...movieItems].filter((x) => x && !existing[x.key]);
  const unique = Object.values(Object.fromEntries(toAdd.map((x) => [x.key, x])));
  await store.putMany(unique);
  result.added = unique;
  return result;
}

// Listas propias de TV Time: marca cada título con el nombre de la lista.
export async function importTvTimeLists(data, store, onProgress) {
  const lists = (data.lists || []).filter((l) => l.items?.length);
  const entries = lists.flatMap((l) => l.items.map((it) => ({ list: l.name, it })));
  const res = { lists: lists.map((l) => l.name), tagged: 0, added: 0, missing: [] };
  const found = await pool(entries, 6, async ({ it }) => {
    if (it.type === "tv") {
      const hit = await tmdb.findByTvdb(it.tvdb_id);
      if (!hit) return null;
      return { key: `tv:${hit.id}`, brief: tmdb.brief(hit, "tv") };
    }
    const hit = await tmdb.searchMovie(it.name, it.year);
    return hit ? { key: `movie:${hit.id}`, brief: tmdb.brief(hit, "movie") } : null;
  }, (n) => onProgress(n, entries.length));
  const all = store.all();
  const changed = {};
  entries.forEach(({ list, it }, k) => {
    const f = found[k];
    if (!f) { if (it.name) res.missing.push(`${it.name} (${list})`); return; }
    const cur = changed[f.key] || all[f.key];
    if (!cur) res.added++;
    const base = cur || { ...f.brief, key: f.key, status: "pending", watched: {}, addedAt: Date.now(), from: "tvtime" };
    changed[f.key] = { ...base, lists: [...new Set([...(base.lists || []), list])] };
  });
  const list = Object.values(changed);
  res.tagged = list.length;
  await store.putMany(list);
  return res;
}
