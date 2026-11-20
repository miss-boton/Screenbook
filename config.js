// Configuración personal de Screenbook.
// TMDB_KEY: tu "Clave de la API" (v3) de themoviedb.org.
export const TMDB_KEY = "268779c3dcf223e8513ee03eb686d6d0";
export const REGION = "ES";
export const LANG = "es-ES";

// Plataformas disponibles en España. Cada persona elige las suyas en Ajustes.
// Se reconocen por el nombre que usa TMDB.
export const ALL_PLATFORMS = [
  { label: "Movistar+", match: ["movistar"] },
  { label: "Netflix", match: ["netflix"] },
  { label: "Prime Video", match: ["amazon prime video", "prime video"] },
  { label: "HBO Max", match: ["hbo max", "max"] },
  { label: "Apple TV+", match: ["apple tv"] },
  { label: "SkyShowtime", match: ["skyshowtime"] },
  { label: "Atresplayer", match: ["atresplayer"] },
  { label: "Disney+", match: ["disney plus", "disney+"] },
  { label: "Filmin", match: ["filmin"] },
  { label: "RTVE Play", match: ["rtve"] },
  { label: "Rakuten TV", match: ["rakuten"] },
  { label: "Mubi", match: ["mubi"] },
  { label: "Crunchyroll", match: ["crunchyroll"] },
  { label: "Pluto TV", match: ["pluto"] },
];
// Plataformas marcadas por defecto para una persona nueva.
export const DEFAULT_PLATFORMS = ["Movistar+", "Netflix", "Prime Video", "HBO Max", "Apple TV+", "SkyShowtime", "Atresplayer", "Disney+"];

// Firebase (no es secreto: identifica el proyecto). Con Firebase, cada persona
// entra con su cuenta de Google y tiene sus propias listas y plataformas.
// Quién puede entrar se controla con una lista de emails autorizados en las
// reglas de Firestore (firestore.rules), no aquí: este archivo es público.
export const FIREBASE = {
  apiKey: "AIzaSyAoEowv7eACGUm1j1qaDSXJ9FSMai_Qvyg",
  authDomain: "screenbook-54684.firebaseapp.com",
  projectId: "screenbook-54684",
  storageBucket: "screenbook-54684.firebasestorage.app",
  messagingSenderId: "1059530013888",
  appId: "1:1059530013888:web:abae072d8e102e9c974125",
};
