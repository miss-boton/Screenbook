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
