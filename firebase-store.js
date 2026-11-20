// Almacén en Firebase: cada persona entra con Google y tiene sus propias listas
// en users/{uid}/items y sus ajustes en users/{uid}. Quién puede entrar lo
// deciden las reglas de Firestore (lista de emails autorizados).
const V = "10.12.2";
const SDK = (m) => `https://www.gstatic.com/firebasejs/${V}/firebase-${m}.js`;

export async function initFirebase(config) {
  const [{ initializeApp }, auth, fs] = await Promise.all([
    import(SDK("app")), import(SDK("auth")), import(SDK("firestore")),
  ]);
  const app = initializeApp(config);
  const a = auth.getAuth(app);
  const db = fs.initializeFirestore(app, { localCache: fs.persistentLocalCache(), ignoreUndefinedProperties: true });
  const provider = new auth.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });

  return {
    onUser: (fn) => auth.onAuthStateChanged(a, fn),
    async signIn() {
      try { await auth.signInWithPopup(a, provider); }
      catch (e) {
        if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment"].includes(e.code)) return auth.signInWithRedirect(a, provider);
        if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") throw e;
      }
    },
    signOut: () => auth.signOut(a),
    // Entrar con un enlace enviado por email (sirve para Outlook, Hotmail, Gmail…).
    async sendEmailLink(email) {
      const url = location.origin + location.pathname;
      await auth.sendSignInLinkToEmail(a, email, { url, handleCodeInApp: true });
      try { localStorage.setItem("screenbook.emailForSignIn", email); } catch {}
    },
    async completeEmailLink(askEmail) {
      if (!auth.isSignInWithEmailLink(a, location.href)) return false;
      let email = null;
      try { email = localStorage.getItem("screenbook.emailForSignIn"); } catch {}
      if (!email) email = askEmail();
      if (!email) return false;
      await auth.signInWithEmailLink(a, email, location.href);
      try { localStorage.removeItem("screenbook.emailForSignIn"); } catch {}
      history.replaceState(null, "", location.pathname);
      return true;
    },
    getRedirectResult: () => auth.getRedirectResult(a).catch(() => null),
    async openStore(user) {
      const userDoc = fs.doc(db, "users", user.uid);
      const col = fs.collection(db, "users", user.uid, "items");
      // Comprueba el permiso antes de mostrar nada.
      const snap = await fs.getDoc(userDoc); // lanza permission-denied si no está autorizada
      let settings = snap.exists() ? snap.data().settings || {} : {};
      let items = {};
      const listeners = new Set();
      const emit = () => listeners.forEach((fn) => fn(items));
      let ready;
      const first = new Promise((r) => (ready = r));
      fs.onSnapshot(col, (qs) => {
        const next = {};
        qs.forEach((d) => { next[d.data().key] = d.data(); });
        items = next; emit(); ready();
      }, (err) => { console.error(err); ready(); });
      await first;
      // Listas compartidas en las que está esta persona.
      let shared = [];
      const sharedCol = fs.collection(db, "sharedLists");
      fs.onSnapshot(fs.query(sharedCol, fs.where("members", "array-contains", user.email)), (qs) => {
        shared = qs.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.name.localeCompare(b.name));
        emit();
      }, (err) => console.warn("sharedLists", err.code));
      const id = (key) => key.replace("/", "_");
      return {
        mode: "firebase",
        user,
        all: () => items,
        get: (key) => items[key],
        subscribe(fn) { listeners.add(fn); fn(items); return () => listeners.delete(fn); },
        put: (item) => fs.setDoc(fs.doc(col, id(item.key)), { ...item, updatedAt: Date.now() }),
        remove: (key) => fs.deleteDoc(fs.doc(col, id(key))),
        async putMany(list, onProgress) {
          const now = Date.now();
          for (let i = 0; i < list.length; i += 400) {
            const batch = fs.writeBatch(db);
            for (const it of list.slice(i, i + 400)) batch.set(fs.doc(col, id(it.key)), { ...it, updatedAt: it.updatedAt || now });
            await batch.commit();
            onProgress?.(Math.min(i + 400, list.length), list.length);
          }
        },
        shared: () => shared,
        async createShared({ name, members, items }) {
          const ref = fs.doc(sharedCol);
          await fs.setDoc(ref, { name, owner: user.email, members, items, createdAt: Date.now() });
          return ref.id;
        },
        updateShared: (id, patch) => fs.updateDoc(fs.doc(sharedCol, id), patch),
        deleteShared: (id) => fs.deleteDoc(fs.doc(sharedCol, id)),
        setSharedItem: (id, key, brief) => fs.updateDoc(fs.doc(sharedCol, id), new fs.FieldPath("items", key), brief || fs.deleteField()),
        getSettings: () => settings,
        async saveSettings(s) {
          settings = s;
          await fs.setDoc(userDoc, { settings: s, email: user.email }, { merge: true });
        },
      };
    },
  };
}
