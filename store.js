// Almacén de tus listas. Hoy: este navegador. Con Firebase: tu cuenta de Google.
// Cada título: { key, id, type: "tv"|"movie", title, poster, year, status,
//   watched: { "s1e3": fecha }, seasons: [{n, count}], total, addedAt, updatedAt }
const LS_KEY = "screenbook.items.v1";
const LS_SETTINGS = "screenbook.settings.v1";

export function loadSettings() {
  try { return JSON.parse(localStorage.getItem(LS_SETTINGS)) || {}; } catch { return {}; }
}
export function saveSettings(s) {
  try { localStorage.setItem(LS_SETTINGS, JSON.stringify(s)); } catch {}
}

function readLocal() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; }
}
function writeLocal(items) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(items)); } catch {}
}

export function createStore() {
  let items = readLocal();
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => fn(items));

  return {
    mode: "local",
    all: () => items,
    get: (key) => items[key],
    subscribe(fn) { listeners.add(fn); fn(items); return () => listeners.delete(fn); },
    async put(item) {
      items = { ...items, [item.key]: { ...item, updatedAt: Date.now() } };
      writeLocal(items); emit();
    },
    async remove(key) {
      const { [key]: _, ...rest } = items; items = rest;
      writeLocal(items); emit();
    },
    async putMany(list) {
      const now = Date.now();
      items = { ...items };
      for (const it of list) items[it.key] = { ...it, updatedAt: it.updatedAt || now };
      writeLocal(items); emit();
    },
    getSettings: () => loadSettings(),
    async saveSettings(st) { saveSettings(st); },
    async replaceAll(next) { items = next; writeLocal(items); emit(); },
  };
}

export function exportBackup(items) {
  const blob = new Blob(
    [JSON.stringify({ app: "screenbook", version: 1, exportedAt: new Date().toISOString(), items }, null, 2)],
    { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `screenbook-copia-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
