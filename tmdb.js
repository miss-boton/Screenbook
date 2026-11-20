import { TMDB_KEY, REGION, LANG, ALL_PLATFORMS, DEFAULT_PLATFORMS } from "./config.js";

let mine = DEFAULT_PLATFORMS;
export const setMyPlatforms = (labels) => { mine = labels; };

const API = "https://api.themoviedb.org/3";
export const IMG = (path, size = "w342") => (path ? `https://image.tmdb.org/t/p/${size}${path}` : "");
const cache = new Map();

export const hasKey = () => Boolean(TMDB_KEY);

async function get(path, params = {}) {
  const url = new URL(API + path);
  url.searchParams.set("api_key", TMDB_KEY);
  url.searchParams.set("language", LANG);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const key = url.toString();
  if (cache.has(key)) return cache.get(key);
  const p = fetch(key).then((r) => {
    if (!r.ok) throw new Error(`TMDB ${r.status}`);
    return r.json();
  });
  cache.set(key, p);
  p.catch(() => cache.delete(key));
  return p;
}

export async function search(query) {
  const data = await get("/search/multi", { query, include_adult: "false", region: REGION });
  return data.results
    .filter((r) => r.media_type === "tv" || r.media_type === "movie")
    .map((r) => brief(r));
}

export function brief(r, type = r.media_type) {
  return {
    id: r.id,
    type,
    title: r.title || r.name,
    poster: r.poster_path || "",
    year: (r.release_date || r.first_air_date || "").slice(0, 4),
  };
}

export async function details(type, id) {
  return get(`/${type}/${id}`, { append_to_response: "watch/providers" });
}

export async function season(id, n) {
  return get(`/tv/${id}/season/${n}`);
}

// Plataformas en España (suscripción), marcando las tuyas.
export function providers(detail) {
  const es = detail?.["watch/providers"]?.results?.[REGION];
  const flat = es?.flatrate || [];
  return flat.map((p) => ({
    name: p.provider_name,
    logo: IMG(p.logo_path, "w92"),
    mine: myLabel(p.provider_name),
  }));
}

export function myLabel(name) {
  const n = name.toLowerCase();
  const hit = ALL_PLATFORMS.filter((p) => mine.includes(p.label)).find((p) => p.match.some((m) => (m === "max" ? n === "max" : n.includes(m))));
  return hit ? hit.label : null;
}

export async function trending() {
  const data = await get("/trending/all/week");
  return data.results.filter((r) => r.media_type === "tv" || r.media_type === "movie").map((r) => brief(r));
}

// Para importar: TheTVDB (ids de TV Time) -> TMDB, y búsqueda de películas.
export async function findByTvdb(tvdbId) {
  const data = await get(`/find/${tvdbId}`, { external_source: "tvdb_id" });
  return data.tv_results?.[0] || null;
}
export async function searchMovie(name, year) {
  const withYear = year ? await get("/search/movie", { query: name, primary_release_year: year }) : null;
  const hit = withYear?.results?.[0];
  if (hit) return hit;
  const any = await get("/search/movie", { query: name });
  return any.results?.[0] || null;
}
