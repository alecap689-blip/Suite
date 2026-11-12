/* Suite — motore di sincronizzazione (vedi docs/07-SINCRONIZZAZIONE.md).
   Indipendente dalla UI e dal supporto: lavora con un `driver` (cartella SuiteData) e un `adapter`
   (dati locali della shell). Un file JSON per record, con metadati {rev, updatedAt, updatedBy, deleted}.
   Conflitto = stesso record modificato su due dispositivi: vince l'updatedAt più recente,
   la versione perdente finisce in `.conflicts/`. Le eliminazioni sono tombstone (30 giorni). */
(function (root) {
  'use strict';

  const TOMBSTONE_DAYS = 30;
  const DAY = 864e5;

  const enc = (s) => encodeURIComponent(s).replace(/[*!'()~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const dec = (s) => decodeURIComponent(s);
  const clone = (x) => JSON.parse(JSON.stringify(x));
  function hash(v) {
    const s = JSON.stringify(v === undefined ? null : v);
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36) + ':' + s.length;
  }

  /* ---------- mappa chiavi locali ⇄ percorsi in SuiteData ---------- */
  function keyToPath(k) {
    let m;
    if ((m = /^suite\.data\.([^.]+)\.(.+)$/.exec(k))) return `data/${m[1]}/${enc(m[2])}.json`;
    if ((m = /^suite\.ls\.([^.]+)\.(.+)$/.exec(k))) return `data/${m[1]}/_ls/${enc(m[2])}.json`;
    if ((m = /^suite\.shared\.(.+)$/.exec(k))) return `shared/${enc(m[1])}.json`;
    return null;
  }
  function pathToKey(p) {
    let m;
    if ((m = /^data\/([^/]+)\/_ls\/(.+)\.json$/.exec(p))) return `suite.ls.${m[1]}.${dec(m[2])}`;
    if ((m = /^data\/([^/]+)\/([^/]+)\.json$/.exec(p))) return `suite.data.${m[1]}.${dec(m[2])}`;
    if ((m = /^shared\/([^/]+)\.json$/.exec(p))) return `suite.shared.${dec(m[1])}`;
    return null;
  }
  const isSyncable = (p) => /\.json$/.test(p) && /^(data|shared|layout|apps)\//.test(p) && !/(^|\/)\./.test(p);
  const appPath = (id) => `apps/${enc(id)}.json`;
  const appIdOf = (p) => { const m = /^apps\/([^/]+)\.json$/.exec(p); return m ? dec(m[1]) : null; };

  /* ---------- layout ⇄ record (un file per sezione: modifiche a sezioni diverse si fondono) ---------- */
  function layoutToRecords(l) {
    const m = new Map();
    m.set('layout/order.json', { sections: l.sections.map((s) => s.id) });
    l.sections.forEach((s) => m.set(`layout/sections/${enc(s.id)}.json`, { id: s.id, name: s.name, icon: s.icon, color: s.color, apps: s.apps.slice() }));
    m.set('layout/pinned.json', (l.pinned || []).slice());
    m.set('layout/settings.json', clone(l.settings || {}));
    return m;
  }
  const isLayoutPath = (p) => p.startsWith('layout/');
  /* changes: Map percorso → {value, deleted}. Ritorna un nuovo layout (da normalizzare). */
  function applyToLayout(layout, changes) {
    const l = clone(layout);
    const sec = new Map(l.sections.map((s) => [s.id, s]));
    let order = l.sections.map((s) => s.id);
    changes.forEach((c, p) => {
      if (p === 'layout/order.json') { if (!c.deleted && c.value && Array.isArray(c.value.sections)) order = c.value.sections; }
      else if (p === 'layout/pinned.json') { if (!c.deleted && Array.isArray(c.value)) l.pinned = c.value; }
      else if (p === 'layout/settings.json') { if (!c.deleted && c.value) l.settings = Object.assign({}, l.settings, c.value); }
      else if (p.startsWith('layout/sections/')) {
        const id = dec(p.slice('layout/sections/'.length, -'.json'.length));
        if (c.deleted) sec.delete(id); else sec.set(id, Object.assign({}, c.value));
      }
    });
    const out = [];
    order.forEach((id) => { if (sec.has(id)) { out.push(sec.get(id)); sec.delete(id); } });
    sec.forEach((s) => out.push(s));
    l.sections = out;
    return l;
  }

  /* ---------- motore ---------- */
  /* driver:  { list(): [{path, mtime}], read(path): string|null, write(path, text), remove(path) }
     adapter: { list(): Map percorso→valore, apply(path, value, deleted), done(changedPaths) }
     store:   { load(): stato|null, save(stato) }   stato = { files:{path:meta}, conflicts:[], connectedAt } */
  /* editedAt(): (opzionale) quando l'utente ha modificato davvero i dati; senza, vale il momento in cui la sync li rileva */
  function createSync({ driver, adapter, store, deviceId, now = Date.now, editedAt = null, onStatus = () => {} }) {
    let st = store.load() || { files: {}, conflicts: [], connectedAt: 0 };
    if (!st.files) st.files = {};
    if (!st.conflicts) st.conflicts = [];
    let chain = Promise.resolve();
    let lastLocal = new Map();
    const save = () => store.save(st);
    const keyOf = (e) => `${e.rev}@${e.updatedBy}@${e.updatedAt}`;
    const stamp = () => new Date(now()).toISOString().replace(/[:.]/g, '-');

    async function conflictCopy(path, env, why) {
      const file = `.conflicts/${stamp()}__${enc(path)}`;
      await driver.write(file, JSON.stringify(Object.assign({ conflict: why, device: deviceId }, env)));
      st.conflicts.unshift({ path, at: now(), why, file });
      st.conflicts = st.conflicts.slice(0, 50);
    }

    /* 1. cosa è cambiato in locale dall'ultima volta */
    async function scan(initial) {
      lastLocal = await adapter.list();
      const e = editedAt && editedAt();
      const t = e ? Math.min(e, now()) : now();
      lastLocal.forEach((value, path) => {
        const h = hash(value), m = st.files[path];
        if (!m) st.files[path] = { rev: 1, updatedAt: initial ? 0 : t, updatedBy: deviceId, deleted: false, hash: h, dirty: true, seen: null };
        else if (m.deleted || m.hash !== h) { m.rev += 1; m.updatedAt = t; m.updatedBy = deviceId; m.deleted = false; m.hash = h; m.dirty = true; }
      });
      Object.keys(st.files).forEach((path) => {
        const m = st.files[path];
        if (!lastLocal.has(path) && !m.deleted) { m.rev += 1; m.updatedAt = t; m.updatedBy = deviceId; m.deleted = true; m.hash = hash(null); m.dirty = true; }
      });
    }

    /* 2. cosa è cambiato in remoto */
    async function pull() {
      const files = (await driver.list()).filter((f) => isSyncable(f.path));
      const present = new Set(files.map((f) => f.path));
      const changes = [];
      for (const f of files) {
        const m = st.files[f.path];
        if (m && m.mtime === f.mtime && m.seen) continue; // file invariato dall'ultima lettura
        let env = null;
        try { env = JSON.parse(await driver.read(f.path)); } catch (e) { env = null; }
        if (!env || typeof env.rev !== 'number' || typeof env.updatedAt !== 'number') continue; // file in scrittura/illeggibile: riprova al prossimo giro
        if (env.id !== f.path) { // copia creata da Drive (es. "file (1).json"): messa da parte
          await conflictCopy(env.id || f.path, env, 'copia-drive'); await driver.remove(f.path); continue;
        }
        if (env.deleted && env.updatedAt < now() - TOMBSTONE_DAYS * DAY && (!m || m.deleted)) { await driver.remove(f.path); delete st.files[f.path]; continue; }
        const rk = keyOf(env);
        if (m && m.seen === rk) { m.mtime = f.mtime; continue; }
        const takeRemote = () => { st.files[f.path] = { rev: env.rev, updatedAt: env.updatedAt, updatedBy: env.updatedBy, deleted: !!env.deleted, hash: hash(env.deleted ? null : env.value), dirty: false, seen: rk, mtime: f.mtime }; changes.push({ path: f.path, value: env.value, deleted: !!env.deleted }); };
        if (!m || !m.dirty) { takeRemote(); continue; }
        if (hash(env.deleted ? null : env.value) === m.hash && !!env.deleted === !!m.deleted) { // stesso contenuto: nessun conflitto reale
          Object.assign(m, { rev: Math.max(m.rev, env.rev), updatedAt: env.updatedAt, updatedBy: env.updatedBy, dirty: false, seen: rk, mtime: f.mtime }); continue;
        }
        const remoteWins = env.updatedAt > m.updatedAt || (env.updatedAt === m.updatedAt && String(env.updatedBy) > String(m.updatedBy));
        if (remoteWins) {
          await conflictCopy(f.path, { id: f.path, rev: m.rev, updatedAt: m.updatedAt, updatedBy: m.updatedBy, deleted: !!m.deleted, value: m.deleted ? null : lastLocal.get(f.path) }, 'locale-sostituita');
          takeRemote();
        } else {
          await conflictCopy(f.path, env, 'remota-sostituita');
          Object.assign(m, { rev: Math.max(m.rev, env.rev) + 1, seen: rk, mtime: f.mtime, dirty: true });
        }
      }
      Object.keys(st.files).forEach((p) => { // file sparito dalla cartella
        const m = st.files[p];
        if (present.has(p) || !isSyncable(p) || m.dirty || !m.seen) return;
        if (m.deleted) delete st.files[p]; else { m.dirty = true; m.seen = null; }
      });
      return changes;
    }

    /* 3. invia le modifiche locali */
    async function push() {
      for (const path of Object.keys(st.files)) {
        const m = st.files[path]; if (!m.dirty) continue;
        const env = { id: path, rev: m.rev, updatedAt: m.updatedAt, updatedBy: m.updatedBy, deleted: !!m.deleted, value: m.deleted ? null : lastLocal.get(path) };
        await driver.write(path, JSON.stringify(env));
        m.dirty = false; m.seen = keyOf(env); m.mtime = undefined;
      }
    }

    async function run() {
      onStatus('sync');
      try {
        let adopt = false; // primo collegamento a una cartella già piena: vince la cartella
        if (!st.connectedAt) {
          const probe = (await driver.list()).filter((f) => isSyncable(f.path));
          if (probe.length) {
            adopt = true; // cartella già piena: i dati locali non devono sovrascriverla; copia di sicurezza
            const snap = {}; (await adapter.list()).forEach((v, k) => { if (!k.startsWith('apps/')) snap[k] = v; });
            await driver.write(`.conflicts/${stamp()}__prima-del-collegamento__${deviceId}.json`, JSON.stringify(snap));
          }
        }
        await scan(adopt);
        const changes = await pull();
        for (const c of changes) await adapter.apply(c.path, c.value, c.deleted);
        if (changes.length) await adapter.done(changes.map((c) => c.path));
        await push();
        if (!st.connectedAt) st.connectedAt = now();
        save();
        onStatus(st.conflicts.length ? 'conflict' : 'ok', { changed: changes.length });
        return { changed: changes.length };
      } catch (e) {
        save(); onStatus('error', e); throw e;
      }
    }
    const sync = () => { const p = chain.then(run); chain = p.catch(() => {}); return p; };

    return { sync, state: () => st, clearConflicts: () => { st.conflicts = []; save(); } };
  }

  const api = { createSync, keyToPath, pathToKey, isSyncable, appPath, appIdOf, layoutToRecords, applyToLayout, isLayoutPath, hash, enc, dec };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SuiteSync = api;
})(typeof self !== 'undefined' ? self : this);
