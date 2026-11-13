/* Suite — driver Google Drive per il browser / PWA (iPhone, e in generale dove non c'è il guscio nativo).
   Stessa interfaccia del FolderDriver: list / read / write / remove, ma sulla cartella `SuiteData` in Il mio Drive
   tramite le Google Drive API (v3). Il login usa Google Identity Services (token di accesso, scope `drive`).
   I percorsi sono quelli di sync.js (es. "data/app/chiave.json"); i file/cartelle che iniziano con "." (.conflicts)
   non compaiono in list() ma si possono scrivere. Le eliminazioni vanno nel cestino di Drive (recuperabili). */
(function (root) {
  'use strict';

  const API = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  const FOLDER = 'application/vnd.google-apps.folder';
  const SCOPE = 'https://www.googleapis.com/auth/drive';
  const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  /* ---------- driver ---------- */
  function createDriveDriver({ fetch: f, getToken, rootName = 'SuiteData' }) {
    const doFetch = f || root.fetch.bind(root);
    let rootId = null;
    let files = new Map();      // percorso → {id, mtime}
    const folders = new Map();  // percorso cartella ('' = radice) → id

    async function api(url, opts = {}, retry = true) {
      const token = await getToken(false);
      const res = await doFetch(url, Object.assign({}, opts, { headers: Object.assign({ Authorization: 'Bearer ' + token }, opts.headers || {}) }));
      if (res.status === 401 && retry) { await getToken(true); return api(url, opts, false); }
      if (!res.ok) { const e = new Error(`Drive ${res.status}`); e.status = res.status; throw e; }
      return res;
    }
    const json = async (url, opts) => (await api(url, opts)).json();

    async function children(parentId, extra = '') {
      const out = []; let token = '';
      do {
        const url = `${API}/files?q=${encodeURIComponent(`'${q(parentId)}' in parents and trashed=false${extra}`)}&fields=${encodeURIComponent('nextPageToken,files(id,name,mimeType,modifiedTime)')}&orderBy=createdTime&pageSize=1000${token ? '&pageToken=' + encodeURIComponent(token) : ''}`;
        const r = await json(url); out.push(...(r.files || [])); token = r.nextPageToken || '';
      } while (token);
      return out;
    }

    async function ensureRoot() {
      if (rootId) return rootId;
      const r = await json(`${API}/files?q=${encodeURIComponent(`name='${q(rootName)}' and mimeType='${FOLDER}' and 'root' in parents and trashed=false`)}&fields=files(id)&orderBy=createdTime`);
      if (r.files && r.files.length) rootId = r.files[0].id;
      else rootId = (await json(`${API}/files?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: rootName, mimeType: FOLDER, parents: ['root'] }) })).id;
      folders.set('', rootId);
      return rootId;
    }

    async function list() {
      await ensureRoot();
      const next = new Map(); const out = [];
      folders.clear(); folders.set('', rootId);
      let level = [{ id: rootId, path: '' }];
      while (level.length) {
        const res = await Promise.all(level.map((d) => children(d.id)));
        const nl = [];
        res.forEach((kids, i) => kids.forEach((c) => {
          if (c.name.startsWith('.')) return;
          const p = level[i].path + c.name;
          if (c.mimeType === FOLDER) { folders.set(p, c.id); nl.push({ id: c.id, path: p + '/' }); }
          else if (!next.has(p)) { const mtime = Date.parse(c.modifiedTime) || 0; next.set(p, { id: c.id, mtime }); out.push({ path: p, mtime }); }
        }));
        level = nl;
      }
      files = next;
      return out;
    }

    async function read(path) {
      const e = files.get(path); if (!e) return null;
      try { return await (await api(`${API}/files/${encodeURIComponent(e.id)}?alt=media`)).text(); }
      catch (err) { if (err.status === 404) { files.delete(path); return null; } throw err; }
    }

    async function ensureFolder(parts) {
      let path = '', parent = await ensureRoot();
      for (const name of parts) {
        path = path ? path + '/' + name : name;
        if (folders.has(path)) { parent = folders.get(path); continue; }
        const found = await children(parent, ` and name='${q(name)}' and mimeType='${FOLDER}'`);
        const id = found.length ? found[0].id
          : (await json(`${API}/files?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }) })).id;
        folders.set(path, id); parent = id;
      }
      return parent;
    }

    async function write(path, text) {
      const parts = path.split('/'), name = parts.pop();
      const cur = files.get(path);
      let r;
      if (cur) {
        r = await json(`${UPLOAD}/files/${encodeURIComponent(cur.id)}?uploadType=media&fields=id,modifiedTime`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: text });
      } else {
        const parent = await ensureFolder(parts);
        const b = 'suite' + Math.random().toString(36).slice(2);
        const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [parent] })}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${text}\r\n--${b}--`;
        r = await json(`${UPLOAD}/files?uploadType=multipart&fields=id,modifiedTime`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body });
      }
      files.set(path, { id: r.id, mtime: Date.parse(r.modifiedTime) || 0 });
      return true;
    }

    async function remove(path) {
      const e = files.get(path); if (!e) return true;
      await api(`${API}/files/${encodeURIComponent(e.id)}?fields=id`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
      files.delete(path);
      return true;
    }

    return { list, read, write, remove };
  }

  /* ---------- login Google (Google Identity Services, flusso "token") ---------- */
  function createAuth({ clientId, storage = root.localStorage, doc = root.document, now = Date.now }) {
    const KEY = 'suite.google.token';
    let client = null, waiting = null, loading = null;
    const load = () => { try { const t = JSON.parse(storage.getItem(KEY)); return t && t.exp > now() + 60000 ? t : null; } catch (e) { return null; } };
    const store = (t) => { try { storage.setItem(KEY, JSON.stringify(t)); } catch (e) { /* noop */ } };

    function gis() {
      if (root.google && root.google.accounts && root.google.accounts.oauth2) return Promise.resolve();
      if (!loading) loading = new Promise((res, rej) => {
        const s = doc.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
        s.onload = res; s.onerror = () => { loading = null; rej(new Error('Impossibile caricare il login Google (sei online?)')); };
        doc.head.appendChild(s);
      });
      return loading;
    }
    async function ensureClient() {
      await gis();
      if (client) return client;
      client = root.google.accounts.oauth2.initTokenClient({
        client_id: clientId, scope: SCOPE,
        callback: (r) => { const w = waiting; waiting = null; if (!w) return; if (r.error || !r.access_token) w.rej(Object.assign(new Error(r.error || 'auth'), { code: 'auth' })); else { const t = { t: r.access_token, exp: now() + (Number(r.expires_in) || 3600) * 1000 }; store(t); w.res(t.t); } },
        error_callback: (e) => { const w = waiting; waiting = null; if (w) w.rej(Object.assign(new Error((e && e.type) || 'auth'), { code: 'auth' })); },
      });
      return client;
    }
    /* interactive=true solo da un tocco dell'utente (altrimenti il browser blocca il popup) */
    function request(interactive) {
      return new Promise(async (res, rej) => {
        try {
          const c = await ensureClient();
          waiting = { res, rej };
          setTimeout(() => { if (waiting && waiting.rej === rej) { waiting = null; rej(Object.assign(new Error('auth'), { code: 'auth' })); } }, interactive ? 120000 : 8000);
          c.requestAccessToken({ prompt: interactive ? 'select_account' : 'none' });
        } catch (e) { rej(e); }
      });
    }
    return {
      /* per il driver: token valido o tentativo silenzioso; altrimenti errore code 'auth' */
      async getToken(force) { const t = !force && load(); if (t) return t.t; return request(false); },
      signIn: () => request(true),
      signOut() { try { storage.removeItem(KEY); } catch (e) { /* noop */ } },
      signedIn: () => !!load(),
    };
  }

  /* ---------- file collegati (es. un Excel ovunque in Il mio Drive): cerca, scarica, riscrive lo stesso file ---------- */
  function createFiles({ fetch: f, getToken }) {
    const doFetch = f || root.fetch.bind(root);
    async function api(url, opts = {}, retry = true) {
      const token = await getToken(false);
      const res = await doFetch(url, Object.assign({}, opts, { headers: Object.assign({ Authorization: 'Bearer ' + token }, opts.headers || {}) }));
      if (res.status === 401 && retry) { await getToken(true); return api(url, opts, false); }
      if (!res.ok) { const e = new Error(`Drive ${res.status}`); e.status = res.status; throw e; }
      return res;
    }
    const FIELDS = 'id,name,modifiedTime,size,trashed';
    return {
      /* file il cui nome finisce con `ext` (es. ".xlsx"), i più recenti per primi */
      async search(ext) {
        const e = String(ext || '').toLowerCase();
        const qs = `${e ? `name contains '${q(e)}' and ` : ''}mimeType != '${FOLDER}' and trashed=false`;
        const r = await (await api(`${API}/files?q=${encodeURIComponent(qs)}&fields=${encodeURIComponent(`files(${FIELDS})`)}&orderBy=${encodeURIComponent('modifiedTime desc')}&pageSize=100`)).json();
        return (r.files || []).filter((x) => !e || String(x.name).toLowerCase().endsWith(e)).map((x) => ({ id: x.id, name: x.name, mtime: x.modifiedTime, size: Number(x.size) || 0 }));
      },
      async meta(id) {
        const x = await (await api(`${API}/files/${encodeURIComponent(id)}?fields=${encodeURIComponent(FIELDS)}`)).json();
        return { id: x.id, name: x.name, mtime: x.modifiedTime, trashed: !!x.trashed };
      },
      async download(id) { return (await api(`${API}/files/${encodeURIComponent(id)}?alt=media`)).arrayBuffer(); },
      /* riscrive il contenuto dello stesso file (Drive conserva da solo le versioni precedenti); restituisce il nuovo mtime */
      async upload(id, data, type) {
        const r = await (await api(`${UPLOAD}/files/${encodeURIComponent(id)}?uploadType=media&fields=id,modifiedTime`, { method: 'PATCH', headers: { 'Content-Type': type || 'application/octet-stream' }, body: data })).json();
        return r.modifiedTime;
      },
    };
  }

  const api = { createDriveDriver, createFiles, createAuth, SCOPE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SuiteDrive = api;
})(typeof self !== 'undefined' ? self : this);
