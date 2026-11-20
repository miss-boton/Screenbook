// "Novedades": temporadas completas, episodios nuevos y próximos de tus series,
// y lo nuevo en tus plataformas. Se calcula al abrir la pestaña.
import * as tmdb from "./tmdb.js";

const DAY = 864e5;
const daysFrom = (s) => (new Date(s) - new Date(new Date().toDateString())) / DAY;

async function pool(list, size, fn) {
  let i = 0;
  const out = new Array(list.length);
  async function worker() { while (i < list.length) { const k = i++; try { out[k] = await fn(list[k]); } catch { out[k] = null; } } }
  await Promise.all(Array.from({ length: size }, worker));
  return out;
}

export async function buildNews(items) {
  const series = Object.values(items).filter((i) => i.type === "tv" && (i.status === "watching" || i.status === "paused"));
  const details = await pool(series, 6, (s) => tmdb.details("tv", s.id));
  const complete = [], fresh = [], upcoming = [];
  series.forEach((s, k) => {
    const d = details[k];
    if (!d) return;
    const seasons = (d.seasons || []).filter((x) => x.season_number > 0 && x.episode_count > 0);
    const last = d.last_episode_to_air, next = d.next_episode_to_air;
    const seen = (n) => Object.keys(s.watched || {}).filter((key) => key.startsWith(`s${n}e`)).length;
    if (last?.air_date) {
      const sea = seasons.find((x) => x.season_number === last.season_number);
      const ago = -daysFrom(last.air_date);
      const left = Math.max(0, last.episode_number - seen(last.season_number));
      if (sea && last.episode_number >= sea.episode_count && ago <= 60 && left > 0) {
        complete.push({ item: s, note: `Temporada ${last.season_number} completa · te faltan ${left}`, sort: ago });
      } else if (ago <= 14 && left > 0) {
        fresh.push({ item: s, note: `Nuevo: T${last.season_number} · E${last.episode_number}`, sort: ago });
      }
    }
    if (next?.air_date) {
      const inDays = daysFrom(next.air_date);
      if (inDays >= 0 && inDays <= 45) {
        const when = new Date(next.air_date).toLocaleDateString("es-ES", { day: "numeric", month: "short" });
        upcoming.push({ item: s, note: `${when} · T${next.season_number} · E${next.episode_number}${next.episode_number === 1 ? " (estreno)" : ""}`, sort: inDays });
      }
    }
  });
  const by = (a, b) => a.sort - b.sort;
  const known = (r) => items[`${r.type}:${r.id}`];
  let newMovies = [], newShows = [];
  try {
    const [mIds, tIds] = await Promise.all([tmdb.myProviderIds("movie"), tmdb.myProviderIds("tv")]);
    const [m, t] = await Promise.all([tmdb.discoverNew("movie", mIds, 90), tmdb.discoverNew("tv", tIds, 60)]);
    const withPlatform = async (list, type) => (await pool(list.slice(0, 18), 6, async (r) => {
      const p = tmdb.providers(await tmdb.details(type, r.id)).filter((x) => x.mine).map((x) => x.mine);
      return p.length ? { item: { ...r, ...(known(r) || {}) }, note: [...new Set(p)].join(" · ") } : null;
    })).filter(Boolean);
    [newMovies, newShows] = await Promise.all([withPlatform(m, "movie"), withPlatform(t, "tv")]);
  } catch {}
  return { complete: complete.sort(by), fresh: fresh.sort(by), upcoming: upcoming.sort(by), newShows, newMovies };
}
