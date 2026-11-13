/* Suite — shell prototipo. Dipende da layout.js (window.Layout).
   Storage: layout in localStorage, app (manifest + html) in IndexedDB, dati app in localStorage con prefisso.
   Sincronizzazione: con il guscio nativo (window.webkit…suiteFS) e una cartella SuiteData collegata, sync.js mantiene
   allineati layout, app e dati con la cartella (Google Drive per desktop). localStorage/IndexedDB restano la cache locale. */
(function () {
  'use strict';

  /* ---------------- utilità ---------------- */
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { toast('Salvataggio non riuscito'); } poke(k); };
  const lsDel = (k) => { try { localStorage.removeItem(k); } catch (e) { /* noop */ } poke(k); };
  const lsKeys = () => { try { return Object.keys(localStorage); } catch (e) { return []; } };

  let toastTimer;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  /* ---------------- IndexedDB (registro app) ---------------- */
  let dbp;
  function db() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open('suite', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('apps', { keyPath: 'id' });
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction('apps', mode); const out = fn(t.objectStore('apps'));
      t.oncomplete = () => res(out && out.result !== undefined ? out.result : undefined); t.onerror = () => rej(t.error);
    });
  }
  const putApp = (rec) => tx('readwrite', (s) => s.put(rec)).then((r) => { poke('apps/'); return r; });
  const delApp = (id) => tx('readwrite', (s) => s.delete(id)).then((r) => { poke('apps/'); return r; });
  const getApp = (id) => tx('readonly', (s) => s.get(id));
  const allApps = () => tx('readonly', (s) => s.getAll());

  /* ---------------- stato ---------------- */
  const state = { layout: null, apps: new Map(), view: { type: 'section', id: null }, editing: false };

  /* con la sync attiva i riferimenti ad app non (ancora) presenti su questo dispositivo vanno conservati */
  const norm = (l) => Layout.normalize(l, [...state.apps.keys()], { keepUnknown: sync.on });
  const saveLayout = () => lsSet('suite.layout', JSON.stringify(state.layout));
  function commit(fn) {
    state.layout = norm(fn(state.layout));
    saveLayout(); render();
  }
  async function refreshApps() {
    state.apps = new Map((await allApps()).map((r) => [r.id, r]));
  }

  /* ---------------- tema ---------------- */
  const mq = matchMedia('(prefers-color-scheme: dark)');
  function effectiveTheme() {
    const s = state.layout.settings.theme;
    return s === 'auto' ? (mq.matches ? 'dark' : 'light') : s;
  }
  function applyTheme() {
    const s = state.layout.settings.theme;
    if (s === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', s);
    postTheme();
  }
  mq.addEventListener('change', () => { if (state.layout) applyTheme(); });

  /* ---------------- icone ---------------- */
  const FILEISH = /\.(svg|png|jpe?g|webp|gif)$/i;
  function appIcon(rec, cls) {
    const m = rec.manifest, c = esc(m.color || '#111111');
    let inner;
    if (rec.iconData) inner = `<img src="${esc(rec.iconData)}" alt="" style="width:62%;height:62%;object-fit:contain">`;
    else if (m.icon && !FILEISH.test(m.icon)) inner = esc(m.icon);
    else inner = esc(m.name.replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase());
    return `<span class="${cls}" style="--c:${c}">${inner}</span>`;
  }

  /* ---------------- modali ---------------- */
  const dlg = $('#dlg'), dlgForm = $('#dlg-form');
  function modal({ title, body = '', submit = 'Salva', danger = false, onSubmit, after }) {
    dlgForm.innerHTML = `<h2>${esc(title)}</h2>${body}<div class="dlg-actions"><button type="button" class="btn" data-x>Annulla</button>${submit ? `<button class="btn ${danger ? 'danger' : 'primary'}">${esc(submit)}</button>` : ''}</div>`;
    $('[data-x]', dlgForm).onclick = () => dlg.close();
    dlgForm.onsubmit = (e) => {
      e.preventDefault();
      try { if (!onSubmit || onSubmit(new FormData(dlgForm)) !== false) dlg.close(); } catch (err) { toast(err.message); }
    };
    if (after) after(dlgForm);
    dlg.showModal();
    const first = $('input[type=text]', dlgForm); if (first) first.focus();
  }

  const EMOJI = ['💼', '❤️', '🏠', '📚', '💰', '🛠️', '🎯', '🧠', '✈️', '🎨', '🏃', '🍎'];
  function sectionModal(section) {
    const s = section || { name: '', icon: '📁', color: '#111111' };
    modal({
      title: section ? 'Modifica sezione' : 'Nuova sezione',
      body: `<label class="field">Nome<input type="text" name="name" value="${esc(s.name)}" maxlength="30" required></label>
        <label class="field">Icona (emoji)<input type="text" name="icon" value="${esc(s.icon)}" maxlength="4"></label>
        <div class="chips" style="margin:-6px 0 14px">${EMOJI.map((e) => `<button type="button" class="chip" data-e="${e}">${e}</button>`).join('')}</div>
        <label class="field">Colore<input type="color" name="color" value="${esc(s.color)}"></label>`,
      after: (f) => f.querySelectorAll('[data-e]').forEach((b) => { b.onclick = () => { f.icon.value = b.dataset.e; }; }),
      onSubmit: (fd) => {
        const patch = { name: fd.get('name'), icon: fd.get('icon') || '📁', color: fd.get('color') };
        if (section) commit((l) => Layout.updateSection(l, section.id, patch));
        else {
          const l2 = Layout.addSection(state.layout, patch.name, patch.icon, patch.color);
          const id = l2.sections[l2.sections.length - 1].id;
          state.layout = norm(l2); saveLayout();
          go({ type: 'section', id }); toast('Sezione creata');
        }
      },
    });
  }

  function addAppsModal(section) {
    const cand = [...state.apps.values()].filter((r) => !section.apps.includes(r.id));
    if (!cand.length) { toast('Tutte le app sono già in questa sezione. Installane una nuova da Gestisci.'); return; }
    modal({
      title: `Aggiungi a ${section.name}`,
      body: `<div class="card">${cand.map((r) => `<label class="list-row"><input type="checkbox" name="app" value="${esc(r.id)}">${appIcon(r, 'mini-ico')}<span class="grow"><b>${esc(r.manifest.name)}</b><small>${esc(r.manifest.description || '')}</small></span></label>`).join('')}</div>`,
      submit: 'Aggiungi',
      onSubmit: (fd) => {
        const ids = fd.getAll('app'); if (!ids.length) return false;
        commit((l) => ids.reduce((acc, id) => Layout.assignApp(acc, id, section.id), l));
      },
    });
  }

  /* ---------------- navigazione ---------------- */
  function go(view) { state.view = view; state.editing = false; render(); $('#main').scrollTop = 0; }

  function renderNav() {
    const l = state.layout, v = state.view;
    const item = (type, id, ico, name, count, color) =>
      `<button class="nav-item" data-go="${type}" data-id="${esc(id || '')}" ${v.type === type && (v.id || '') === (id || '') ? 'aria-current="page"' : ''} style="--c:${esc(color || 'var(--accent)')}">
        <span class="ico">${ico}</span><span>${esc(name)}</span>${count != null ? `<span class="count">${count}</span>` : ''}</button>`;
    $('#nav').innerHTML = `<div class="brand"><i>A</i>Suite</div><div class="nav-label">Sezioni</div>` +
      l.sections.map((s) => item('section', s.id, esc(s.icon), s.name, s.apps.length, s.color)).join('') +
      (openApps.size && multi() ? `<div class="nav-label">Aperte</div>` + [...openApps].map(([id, o]) =>
        `<button class="nav-item" data-resume="${esc(id)}" style="--c:${esc(o.rec.manifest.color || 'var(--accent)')}"><span class="ico">${o.rec.iconData ? '●' : esc(o.rec.manifest.icon && !FILEISH.test(o.rec.manifest.icon) ? o.rec.manifest.icon : '●')}</span><span>${esc(o.rec.manifest.name)}</span></button>`).join('') : '') +
      `<div class="nav-label">Altro</div>` + item('all', '', '🗂️', 'Tutte le app', state.apps.size) +
      `<div class="nav-spacer"></div>` + item('manage', '', '🧩', 'Gestisci') + item('settings', '', '🎛️', 'Impostazioni') +
      (sync.on ? `<div class="nav-label" id="nav-sync" style="text-transform:none">${esc(syncLabel())}</div>` : '');
  }

  function tile(id, opts = {}) {
    const rec = state.apps.get(id); if (!rec) return '';
    const m = rec.manifest, pinned = state.layout.pinned.includes(id);
    const tools = opts.editSection ? `<div class="tools">
        <button class="tool" data-act="left" data-id="${esc(id)}" aria-label="Sposta prima">◀</button>
        <button class="tool" data-act="right" data-id="${esc(id)}" aria-label="Sposta dopo">▶</button>
        <button class="tool" data-act="pin" data-id="${esc(id)}" aria-label="Preferito">${pinned ? '★' : '☆'}</button>
        <button class="tool danger" data-act="remove" data-id="${esc(id)}" aria-label="Togli dalla sezione">−</button></div>` : (pinned ? '<span class="pin">★</span>' : '');
    return `<button class="tile" data-open="${esc(id)}" style="--c:${esc(m.color || '#111111')}" ${opts.editSection ? 'tabindex="-1"' : ''}>
      ${openApps.has(id) ? '<span class="live" title="Aperta">●</span>' : ''}${appIcon(rec, 'app-ico')}<h3>${esc(m.name)}</h3><p>${esc(m.description || '')}</p>${tools}</button>`;
  }

  function sectionView(s) {
    const apps = s.apps.filter((a) => state.apps.has(a));
    $('#main').style.setProperty('--sec', s.color);
    return `<div class="view ${state.editing ? 'editing' : ''}">
      <div class="page-head"><span class="big-ico">${esc(s.icon)}</span>
        <div><h1>${esc(s.name)}</h1><p>${apps.length === 1 ? '1 app' : apps.length + ' app'}</p></div><span class="spacer"></span>
        ${state.editing ? `<button class="btn" data-act="edit-section">✏️ Rinomina</button><button class="btn danger" data-act="del-section">Elimina sezione</button>` : ''}
        <button class="btn ${state.editing ? 'primary' : ''}" data-act="toggle-edit">${state.editing ? 'Fine' : 'Modifica'}</button></div>
      ${apps.length || state.editing ? `<div class="grid">${apps.map((a) => tile(a, { editSection: state.editing })).join('')}
        ${state.editing ? `<button class="tile add" data-act="add-apps"><span style="font-size:30px">＋</span>Aggiungi app</button>` : ''}</div>`
        : `<div class="empty"><span class="emo">🫥</span><b>Nessuna app in questa sezione</b><p>Aggiungi le app che vuoi vedere qui.</p>
           <button class="btn primary" data-act="add-apps">＋ Aggiungi app</button></div>`}
    </div>`;
  }

  function allView() {
    $('#main').style.setProperty('--sec', 'var(--accent)');
    const l = state.layout, ids = [...state.apps.keys()];
    const row = (title, list) => list.length ? `<h2 class="sub">${title}</h2><div class="grid">${list.map((a) => tile(a)).join('')}</div>` : '';
    return `<div class="view"><div class="page-head"><span class="big-ico">🗂️</span><div><h1>Tutte le app</h1><p>${ids.length} installate</p></div></div>
      ${row('Preferiti', l.pinned)}${row('Recenti', l.recent)}${row('Tutte', ids)}
      ${ids.length ? '' : '<div class="empty"><span class="emo">📦</span><b>Nessuna app installata</b><p>Vai in Gestisci per installarne una.</p></div>'}</div>`;
  }

  function manageView() {
    $('#main').style.setProperty('--sec', 'var(--accent)');
    const l = state.layout;
    const secRows = l.sections.map((s, i) => `<div class="list-row" style="--c:${esc(s.color)}">
        <span class="mini-ico">${esc(s.icon)}</span><span class="grow"><b>${esc(s.name)}</b><small>${s.apps.length} app</small></span>
        <button class="btn sm" data-act="s-up" data-id="${esc(s.id)}" ${i === 0 ? 'disabled' : ''} aria-label="Su">↑</button>
        <button class="btn sm" data-act="s-down" data-id="${esc(s.id)}" ${i === l.sections.length - 1 ? 'disabled' : ''} aria-label="Giù">↓</button>
        <button class="btn sm" data-act="s-edit" data-id="${esc(s.id)}">Modifica</button>
        <button class="btn sm danger" data-act="s-del" data-id="${esc(s.id)}">Elimina</button></div>`).join('');
    const appRows = [...state.apps.values()].map((r) => `<div class="list-row" style="--c:${esc(r.manifest.color || '#111111')}">
        ${appIcon(r, 'mini-ico')}<span class="grow"><b>${esc(r.manifest.name)} <span class="pill">v${esc(r.manifest.version)}</span></b><small>${esc(r.manifest.description || r.id)}</small></span>
        <div class="chips">${l.sections.map((s) => `<button class="chip" style="--c:${esc(s.color)}" data-act="toggle-assign" data-id="${esc(r.id)}" data-s="${esc(s.id)}" aria-pressed="${s.apps.includes(r.id)}">${esc(s.icon)} ${esc(s.name)}</button>`).join('')}</div>
        <button class="btn sm danger" data-act="uninstall" data-id="${esc(r.id)}">Disinstalla</button></div>`).join('');
    return `<div class="view"><div class="page-head"><span class="big-ico">🧩</span><div><h1>Gestisci</h1><p>Sezioni e app: aggiungi, rimuovi, scegli cosa mostrare dove.</p></div></div>
      <h2 class="sub">Sezioni</h2><div class="card">${secRows || '<div class="list-row">Nessuna sezione.</div>'}</div>
      <div class="row" style="margin-top:14px"><button class="btn primary" data-act="add-section">＋ Nuova sezione</button></div>
      <h2 class="sub">App installate — tocca una sezione per mostrarla/nasconderla</h2>
      <div class="card">${appRows || '<div class="list-row">Nessuna app installata.</div>'}</div>
      <div class="row" style="margin-top:14px"><button class="btn primary" data-act="install-folder">📁 Installa da cartella</button>
        <button class="btn" data-act="install-file">📄 Installa da file HTML</button></div></div>`;
  }

  function settingsView() {
    $('#main').style.setProperty('--sec', 'var(--accent)');
    const t = state.layout.settings.theme;
    const seg = (v, n) => `<button data-act="theme" data-v="${v}" aria-pressed="${t === v}">${n}</button>`;
    return `<div class="view"><div class="page-head"><span class="big-ico">🎛️</span><div><h1>Impostazioni</h1><p>Tema attuale: ${effectiveTheme() === 'dark' ? 'scuro' : 'chiaro'}</p></div></div>
      <h2 class="sub">Aspetto</h2><div class="card"><div class="list-row"><span class="grow"><b>Tema</b><small>Automatico segue il sistema del dispositivo</small></span>
        <div class="seg">${seg('auto', 'Automatico')}${seg('light', 'Chiaro')}${seg('dark', 'Scuro')}</div></div></div>
      <h2 class="sub">Dati e sincronizzazione</h2><div class="card">
        ${syncRows()}
        <div class="list-row"><span class="grow"><b>Backup</b><small>Esporta o importa tutta la Suite (sezioni, app, dati) in un file</small></span>
          <button class="btn sm" data-act="export">Esporta</button><button class="btn sm" data-act="import">Importa</button></div>
        <div class="list-row"><span class="grow"><b>Ripristina</b><small>Cancella tutto e ricarica le app dimostrative</small></span><button class="btn sm danger" data-act="reset">Ripristina</button></div></div></div>`;
  }

  function render() {
    const v = state.view, l = state.layout;
    if (v.type === 'section' && !l.sections.find((s) => s.id === v.id)) state.view = v = l.sections.length ? { type: 'section', id: l.sections[0].id } : { type: 'manage' };
    renderNav();
    let html;
    if (v.type === 'section') html = sectionView(l.sections.find((s) => s.id === v.id));
    else if (v.type === 'all') html = allView();
    else if (v.type === 'manage') html = manageView();
    else html = settingsView();
    $('#main').innerHTML = html;
  }

  /* ---------------- azioni (delegation) ---------------- */
  const sectionOf = (id) => state.layout.sections.find((s) => s.id === id);
  const curSection = () => sectionOf(state.view.id);
  function move(arr, id, d) { const a = [...arr], i = a.indexOf(id), j = i + d; if (i < 0 || j < 0 || j >= a.length) return a; [a[i], a[j]] = [a[j], a[i]]; return a; }

  document.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]'); if (tab) return showApp(tab.dataset.tab);
    const cl = e.target.closest('[data-closeapp]'); if (cl) return closeApp(cl.dataset.closeapp);
    const res = e.target.closest('[data-resume]'); if (res) return showApp(res.dataset.resume);
    const nav = e.target.closest('[data-go]');
    if (nav) return go({ type: nav.dataset.go, id: nav.dataset.id || null });
    const act = e.target.closest('[data-act]');
    if (act) { e.preventDefault(); e.stopPropagation(); return doAct(act.dataset.act, act.dataset); }
    const open = e.target.closest('[data-open]');
    if (open && !state.editing) openApp(open.dataset.open);
  });

  function doAct(a, d) {
    const id = d.id, l = state.layout;
    switch (a) {
      case 'toggle-edit': state.editing = !state.editing; return render();
      case 'edit-section': return sectionModal(curSection());
      case 'del-section': return delSectionModal(curSection());
      case 'add-apps': return addAppsModal(curSection());
      case 'left': return commit((x) => Layout.reorderApps(x, state.view.id, move(curSection().apps, id, -1)));
      case 'right': return commit((x) => Layout.reorderApps(x, state.view.id, move(curSection().apps, id, 1)));
      case 'remove': return commit((x) => Layout.unassignApp(x, id, state.view.id));
      case 'pin': return commit((x) => Layout.togglePinned(x, id));
      case 'add-section': return sectionModal(null);
      case 's-edit': return sectionModal(sectionOf(id));
      case 's-del': return delSectionModal(sectionOf(id));
      case 's-up': return commit((x) => Layout.reorderSections(x, move(l.sections.map((s) => s.id), id, -1)));
      case 's-down': return commit((x) => Layout.reorderSections(x, move(l.sections.map((s) => s.id), id, 1)));
      case 'toggle-assign': return commit((x) => sectionOf(d.s).apps.includes(id) ? Layout.unassignApp(x, id, d.s) : Layout.assignApp(x, id, d.s));
      case 'uninstall': return uninstallModal(id);
      case 'install-folder': $('#pick-folder').value = ''; return $('#pick-folder').click();
      case 'install-file': $('#pick-file').value = ''; $('#pick-file').dataset.mode = 'install'; return $('#pick-file').click();
      case 'theme': l.settings.theme = d.v; saveLayout(); applyTheme(); return render();
      case 'web-enable': return webEnable();
      case 'web-signin': return webSignIn();
      case 'web-disable': return webDisable();
      case 'web-client': return webClientModal();
      case 'sync-choose': return syncChoose();
      case 'sync-now': return syncNow(true);
      case 'sync-off': return syncOff();
      case 'sync-clear': sync.engine && sync.engine.clearConflicts(); return render();
      case 'export': return exportBackup();
      case 'import': $('#pick-file').value = ''; $('#pick-file').dataset.mode = 'import'; return $('#pick-file').click();
      case 'reset': return modal({ title: 'Ripristinare la Suite?', body: '<p>Verranno cancellati sezioni, app e dati. Questa azione non si può annullare.</p>', submit: 'Cancella tutto', danger: true, onSubmit: () => { resetAll(); } });
    }
  }

  function delSectionModal(s) {
    modal({ title: `Eliminare "${s.name}"?`, body: '<p>Le app non vengono disinstallate: restano disponibili in "Tutte le app" e nelle altre sezioni.</p>', submit: 'Elimina', danger: true,
      onSubmit: () => { commit((l) => Layout.removeSection(l, s.id)); toast('Sezione eliminata'); } });
  }

  function uninstallModal(id) {
    const r = state.apps.get(id);
    modal({ title: `Disinstallare "${r.manifest.name}"?`, body: '<label class="field" style="display:flex;gap:10px;align-items:center"><input type="checkbox" name="data"> Elimina anche i dati dell\'app</label>', submit: 'Disinstalla', danger: true,
      onSubmit: async (fd) => {
        const wipe = fd.get('data');
        if (openApps.has(id)) closeApp(id);
        await delApp(id); await refreshApps();
        if (wipe) lsKeys().filter((k) => k.startsWith(`suite.data.${id}.`) || k.startsWith(`suite.ls.${id}.`)).forEach(lsDel);
        commit((l) => Layout.removeApp(l, id)); toast('App disinstallata');
      } });
  }

  /* ---------------- installazione ---------------- */
  const readText = (f) => f.text();
  const readDataUrl = (f) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f); });
  const dirOf = (p) => p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '';
  function resolvePath(base, rel) {
    const out = (base + rel.replace(/^\.\//, '')).split('/'); const st = [];
    out.forEach((p) => { if (p === '..') st.pop(); else if (p && p !== '.') st.push(p); }); return st.join('/');
  }
  /* Inline di css/js/immagini relativi (nel prototipo l'app gira in srcdoc). Con Tauri: protocollo custom. */
  async function inlineAssets(html, fileMap, base) {
    const get = (rel) => fileMap.get(resolvePath(base, rel.split('?')[0]));
    const isLocal = (u) => u && !/^(https?:|data:|blob:|#|\/\/)/i.test(u);
    const reps = [];
    for (const m of html.matchAll(/<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi)) {
      const h = /href=["']([^"']+)["']/i.exec(m[0]); const f = h && isLocal(h[1]) && get(h[1]);
      if (f) reps.push([m[0], `<style>${await readText(f)}</style>`]);
    }
    for (const m of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>\s*<\/script>/gi)) {
      const f = isLocal(m[1]) && get(m[1]);
      if (f) reps.push([m[0], `<script>${(await readText(f)).replace(/<\/script/gi, '<\\/script')}</script>`]);
    }
    for (const m of html.matchAll(/(<img\b[^>]*\bsrc=)["']([^"']+)["']/gi)) {
      const f = isLocal(m[2]) && get(m[2]);
      if (f) reps.push([m[0], `${m[1]}"${await readDataUrl(f)}"`]);
    }
    reps.forEach(([a, b]) => { html = html.split(a).join(b); });
    return html;
  }

  $('#pick-folder').addEventListener('change', async (e) => {
    const files = [...e.target.files]; if (!files.length) return;
    try {
      const map = new Map(files.map((f) => [f.webkitRelativePath.split('/').slice(1).join('/'), f]));
      const mpath = [...map.keys()].filter((p) => /(^|\/)manifest\.json$/.test(p)).sort((a, b) => a.length - b.length)[0];
      if (!mpath) return toast('manifest.json non trovato nella cartella');
      const base = dirOf(mpath);
      const manifest = JSON.parse(await readText(map.get(mpath)));
      const errs = Layout.validateManifest(manifest); if (errs.length) return toast('Manifest non valido: ' + errs[0]);
      const entry = map.get(resolvePath(base, manifest.entry)); if (!entry) return toast(`File "${manifest.entry}" non trovato`);
      let html = await inlineAssets(await readText(entry), map, dirOf(resolvePath(base, manifest.entry)));
      let iconData = null;
      if (manifest.icon && FILEISH.test(manifest.icon)) { const f = map.get(resolvePath(base, manifest.icon)); if (f) iconData = await readDataUrl(f); }
      await installRecord({ id: manifest.id, manifest, html, iconData });
    } catch (err) { toast('Installazione non riuscita: ' + err.message); }
  });

  $('#pick-file').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    if (e.target.dataset.mode === 'import') return importBackup(f);
    const html = await readText(f), base = Layout.slug(f.name.replace(/\.\w+$/, ''));
    modal({
      title: 'Installa app da file', submit: 'Installa',
      body: `<label class="field">Nome<input type="text" name="name" value="${esc(f.name.replace(/\.\w+$/, ''))}" required></label>
        <label class="field">Icona (emoji)<input type="text" name="icon" value="🧩" maxlength="4"></label>
        <label class="field">Colore<input type="color" name="color" value="#111111"></label>`,
      onSubmit: (fd) => installRecord({ id: Layout.slug(fd.get('name')) || base, html, iconData: null,
        manifest: { id: Layout.slug(fd.get('name')) || base, name: fd.get('name'), version: '1.0.0', entry: f.name, icon: fd.get('icon'), color: fd.get('color'), permissions: ['storage', 'files', 'notifications'] } }),
    });
  });

  async function installRecord(rec) {
    const existed = state.apps.has(rec.id);
    await putApp(rec); await refreshApps();
    commit((l) => l);
    if (existed) return toast(`"${rec.manifest.name}" aggiornata (dati mantenuti)`);
    const secs = state.layout.sections; if (!secs.length) return toast('App installata');
    const pre = rec.manifest.defaultSections || [];
    modal({ title: `"${rec.manifest.name}" installata`, submit: 'Conferma',
      body: `<p>In quali sezioni vuoi mostrarla?</p><div class="chips">${secs.map((s) => `<label class="chip" style="--c:${esc(s.color)}"><input type="checkbox" name="s" value="${esc(s.id)}" ${pre.includes(s.id) ? 'checked' : ''}> ${esc(s.icon)} ${esc(s.name)}</label>`).join('')}</div>`,
      onSubmit: (fd) => { const ids = fd.getAll('s'); commit((l) => ids.reduce((acc, s) => Layout.assignApp(acc, rec.id, s), l)); } });
  }

  /* ---------------- runtime + SDK host ---------------- */
  /* Più app aperte insieme (solo Mac e Windows): ogni app ha il proprio iframe, che resta vivo anche quando si torna
     alla Suite o si passa a un'altra scheda. Su iPhone/PWA resta una sola app alla volta. */
  const framesBox = $('#runner-frames');
  const openApps = new Map(); // id → { rec, frame }
  let activeId = null;
  const multi = () => (platform === 'mac' || platform === 'win') && !(navigator.maxTouchPoints > 1);
  const entryOf = (source) => [...openApps.values()].find((o) => o.frame.contentWindow === source);

  function shim(id, theme, snapshot) {
    return `<script>(function(){
var snap=${JSON.stringify(snapshot).replace(/</g, '\\u003c')},n=0,pend={};
function call(method,args){return new Promise(function(res,rej){var i=++n;pend[i]={res:res,rej:rej};parent.postMessage({suite:1,id:i,method:method,args:args||[]},'*');});}
addEventListener('message',function(e){var d=e.data;if(!d)return;
 if(d.suiteReply&&pend[d.id]){var p=pend[d.id];delete pend[d.id];d.error?p.rej(new Error(d.error)):p.res(d.result);}
 if(d.suiteTheme)setTheme(d.suiteTheme);});
function setTheme(t){document.documentElement.setAttribute('data-theme',t);document.documentElement.style.colorScheme=t;
 var ev=new CustomEvent('themechange',{detail:t});dispatchEvent(ev);}
var cur=${JSON.stringify(theme)};
try{var ls={getItem:function(k){return Object.prototype.hasOwnProperty.call(snap,k)?snap[k]:null},setItem:function(k,v){snap[k]=String(v);call('ls.set',[k,String(v)]);},removeItem:function(k){delete snap[k];call('ls.remove',[k]);},clear:function(){Object.keys(snap).forEach(function(k){call('ls.remove',[k]);});snap={};},key:function(i){return Object.keys(snap)[i]||null},get length(){return Object.keys(snap).length}};
 Object.defineProperty(window,'localStorage',{value:ls,configurable:true});}catch(e){}
window.suite={version:'1.0',
 storage:{get:function(k){return call('storage.get',[k]);},set:function(k,v){return call('storage.set',[k,v]);},remove:function(k){return call('storage.remove',[k]);}},
 files:{save:function(name,data,type){return call('files.save',[name,data,type]);},open:function(accept){return call('files.open',[accept]);},
  link:function(accept){return call('files.link',[accept]);},linked:function(){return call('files.linked');},saveLinked:function(data,type){return call('files.saveLinked',[data,type]);},unlink:function(){return call('files.unlink');}},
 shared:{get:function(ns){return call('shared.get',[ns]);},set:function(ns,v){return call('shared.set',[ns,v]);}},
 nav:{home:function(){return call('nav.home');}},
 theme:{get:function(){return cur;}},
 notify:function(t,b){return call('notify',[t,b]);}};
addEventListener('themechange',function(e){cur=e.detail;});
document.documentElement.setAttribute('data-theme',cur);document.documentElement.style.colorScheme=cur;
})();<\/script>`;
  }

  function snapshotLs(id) {
    const p = `suite.ls.${id}.`, o = {};
    lsKeys().filter((k) => k.startsWith(p)).forEach((k) => { o[k.slice(p.length)] = lsGet(k); });
    return o;
  }

  async function openApp(id) {
    if (multi() && openApps.has(id)) return showApp(id); // già aperta: porta in primo piano, senza ricaricarla
    const rec = state.apps.has(id) ? await getApp(id) : null; if (!rec) return toast('App non trovata');
    state.layout = Layout.touchRecent(state.layout, id); saveLayout();
    if (!multi()) [...openApps.keys()].forEach((k) => dropApp(k)); // una sola app alla volta (iPhone/PWA)
    const sh = shim(id, effectiveTheme(), snapshotLs(id));
    let html = rec.html;
    if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => m + sh);
    else if (/<html[^>]*>/i.test(html)) html = html.replace(/<html[^>]*>/i, (m) => m + sh);
    else html = sh + html;
    const fr = document.createElement('iframe');
    fr.title = rec.manifest.name; fr.hidden = true;
    fr.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-downloads allow-popups');
    fr.srcdoc = html; framesBox.append(fr);
    openApps.set(id, { rec, frame: fr });
    showApp(id);
  }
  /* porta in primo piano l'app `id` (le altre restano aperte, nascoste) */
  function showApp(id) {
    const o = openApps.get(id); if (!o) return;
    activeId = id;
    openApps.forEach((x, k) => { x.frame.hidden = k !== id; });
    $('#runner-title').textContent = o.rec.manifest.name;
    $('#runner-title').hidden = multi();
    $('#runner').hidden = false; renderTabs(); renderNav();
    o.frame.focus(); $('#runner-back').focus();
  }
  /* torna alla Suite lasciando le app aperte in background (multi) */
  function showSuite() { $('#runner').hidden = true; render(); }
  function dropApp(id) { const o = openApps.get(id); if (!o) return; o.frame.srcdoc = ''; o.frame.remove(); openApps.delete(id); }
  function closeApp(id) {
    id = id || activeId; dropApp(id);
    if (activeId === id) {
      activeId = null;
      const last = [...openApps.keys()].pop();
      if (last) return showApp(last);
      $('#runner').hidden = true;
    }
    renderTabs(); render();
  }
  function renderTabs() {
    const t = $('#runner-tabs');
    t.innerHTML = multi() ? [...openApps].map(([id, o]) => `<div class="rtab" role="presentation" aria-selected="${id === activeId}">
      <button role="tab" data-tab="${esc(id)}" aria-selected="${id === activeId}" title="${esc(o.rec.manifest.name)}">${esc(o.rec.manifest.name)}</button>
      <button class="x" data-closeapp="${esc(id)}" aria-label="Chiudi ${esc(o.rec.manifest.name)}" title="Chiudi">×</button></div>`).join('') : '';
  }
  $('#runner-back').addEventListener('click', () => (multi() ? showSuite() : closeApp()));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#runner').hidden && !dlg.open) (multi() ? showSuite() : closeApp()); });
  function postTheme() { openApps.forEach((o) => { if (o.frame.contentWindow) o.frame.contentWindow.postMessage({ suiteTheme: effectiveTheme() }, '*'); }); }

  /* suite.files.open: la scelta del file avviene con un clic diretto dell'utente su un controllo della shell
     (un input nascosto aperto da un postMessage perderebbe il gesto in WKWebView/Safari). Risponde {name, data:ArrayBuffer}. */
  function pickFile(accept) {
    return new Promise((resolve, reject) => {
      const ov = document.createElement('div');
      ov.style.cssText = 'position:fixed;inset:0;z-index:80;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:20px';
      const box = document.createElement('div');
      box.style.cssText = 'background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:var(--radius,20px);padding:20px;max-width:420px;width:100%;box-shadow:var(--shadow)';
      box.innerHTML = '<strong>Scegli il file</strong><p class="muted" style="margin:8px 0 12px"></p>';
      const inp = document.createElement('input'); inp.type = 'file'; if (accept) inp.accept = String(accept); inp.style.cssText = 'width:100%;margin-bottom:12px';
      const no = document.createElement('button'); no.className = 'btn ghost'; no.textContent = 'Annulla';
      const done = (fn) => { ov.remove(); fn(); };
      inp.addEventListener('change', async () => { const f = inp.files[0]; if (!f) return; try { const data = await f.arrayBuffer(); done(() => resolve({ name: f.name, data })); } catch (e) { done(() => reject(e)); } });
      no.addEventListener('click', () => done(() => reject(new Error('annullato'))));
      box.append(inp, no); ov.append(box); document.body.append(ov); inp.focus();
    });
  }

  const NEED = { 'storage.get': 'storage', 'storage.set': 'storage', 'storage.remove': 'storage', 'ls.set': 'storage', 'ls.remove': 'storage', 'files.save': 'files', 'files.open': 'files', 'files.link': 'files', 'files.linked': 'files', 'files.saveLinked': 'files', 'files.unlink': 'files', 'shared.get': 'shared', 'shared.set': 'shared', 'notify': 'notifications' };
  window.addEventListener('message', async (e) => {
    const d = e.data;
    const ent = d && d.suite ? entryOf(e.source) : null; // l'app che ha chiamato (ognuna ha il suo iframe)
    if (!ent) return;
    const running = ent.rec, frame = ent.frame;
    const id = running.id, perms = running.manifest.permissions;
    const reply = (r) => frame.contentWindow && frame.contentWindow.postMessage(Object.assign({ suiteReply: 1, id: d.id }, r), '*');
    const need = NEED[d.method];
    if (need && Array.isArray(perms) && !perms.includes(need)) return reply({ error: 'permission-denied' });
    const [a, b, c] = d.args || [];
    if (d.method.startsWith('shared.') && !(Array.isArray(running.manifest.shared) && running.manifest.shared.includes(a))) return reply({ error: 'permission-denied' });
    try {
      switch (d.method) {
        case 'storage.get': { const v = lsGet(`suite.data.${id}.${a}`); return reply({ result: v == null ? null : JSON.parse(v) }); }
        case 'storage.set': lsSet(`suite.data.${id}.${a}`, JSON.stringify(b)); return reply({ result: true });
        case 'storage.remove': lsDel(`suite.data.${id}.${a}`); return reply({ result: true });
        case 'ls.set': lsSet(`suite.ls.${id}.${a}`, String(b)); return reply({ result: true });
        case 'ls.remove': lsDel(`suite.ls.${id}.${a}`); return reply({ result: true });
        case 'shared.get': { const v = lsGet(`suite.shared.${a}`); return reply({ result: v == null ? null : JSON.parse(v) }); }
        case 'shared.set': lsSet(`suite.shared.${a}`, JSON.stringify(b)); return reply({ result: true });
        case 'nav.home': if (multi()) showSuite(); else closeApp(id); return;
        case 'notify': toast(`${a}${b ? ' — ' + b : ''}`); return reply({ result: true });
        case 'files.save': {
          const blob = a && b instanceof Blob ? b : new Blob([b], { type: c || 'application/octet-stream' });
          const url = URL.createObjectURL(blob), el = document.createElement('a'); el.href = url; el.download = a || 'file'; el.click();
          setTimeout(() => URL.revokeObjectURL(url), 2000); return reply({ result: true });
        }
        case 'files.open': return reply({ result: await pickFile(a) });
        /* file collegato su Google Drive (solo versione web/PWA): l'app sceglie un file una volta, poi lo rilegge e lo riscrive */
        case 'files.link': {
          if (fsBridge) { // guscio Mac/Windows: file del disco, scelto con il pannello di sistema e ricordato dal guscio
            const f = await nativeFile('fileChoose', { app: id, accept: a });
            nativeMtime.set(id, f.mtime);
            return reply({ result: { name: f.name, data: b64ToBuf(f.data), kind: 'local', locked: !!f.locked } });
          }
          if (!cloudFilesOn()) return reply({ error: 'unavailable' });
          const f = await pickCloudFile(a, linkOf(id));
          lsSet(`suite.link.${id}`, JSON.stringify({ id: f.id, name: f.name, mtime: f.mtime }));
          return reply({ result: { name: f.name, data: f.data, kind: 'drive' } });
        }
        case 'files.linked': {
          if (fsBridge) {
            let f; try { f = await nativeFile('fileRead', { app: id }); } catch (err) { if (err.message === 'unavailable') return reply({ result: null }); throw err; }
            if (!f) return reply({ result: null });
            nativeMtime.set(id, f.mtime);
            return reply({ result: { name: f.name, data: b64ToBuf(f.data), kind: 'local', locked: !!f.locked } });
          }
          const lk = cloudFilesOn() ? linkOf(id) : null; if (!lk) return reply({ result: null });
          let m; try { m = await cloudFiles().meta(lk.id); } catch (err) { if (err.status === 404) m = { trashed: true }; else throw err; }
          if (m.trashed) { lsDel(`suite.link.${id}`); return reply({ result: null }); }
          const data = await cloudFiles().download(lk.id);
          lsSet(`suite.link.${id}`, JSON.stringify({ id: lk.id, name: m.name, mtime: m.mtime }));
          return reply({ result: { name: m.name, data, kind: 'drive' } });
        }
        case 'files.saveLinked': {
          if (fsBridge) { // errori: unlinked, locked (aperto in Excel), changed (modificato dopo l'ultima lettura)
            const r = await nativeFile('fileWrite', { app: id, data: await bufToB64(a), mtime: nativeMtime.has(id) ? nativeMtime.get(id) : -1 });
            nativeMtime.set(id, r.mtime);
            return reply({ result: { name: r.name } });
          }
          const lk = cloudFilesOn() ? linkOf(id) : null; if (!lk) return reply({ error: 'unlinked' });
          const m = await cloudFiles().meta(lk.id);
          if (m.trashed) return reply({ error: 'unlinked' });
          if (m.mtime !== lk.mtime) return reply({ error: 'changed' }); // modificato altrove dopo l'ultima lettura: l'app deve rileggerlo
          const mtime = await cloudFiles().upload(lk.id, a instanceof Blob ? a : new Blob([a], { type: b || 'application/octet-stream' }), b);
          lsSet(`suite.link.${id}`, JSON.stringify({ id: lk.id, name: m.name, mtime }));
          return reply({ result: { name: m.name } });
        }
        case 'files.unlink': if (fsBridge) { nativeMtime.delete(id); await nativeFile('fileUnlink', { app: id }); return reply({ result: true }); }
          lsDel(`suite.link.${id}`); return reply({ result: true });
        default: return reply({ error: 'unknown-method' });
      }
    } catch (err) { reply({ error: err && err.code === 'auth' ? 'auth' : err.message }); }
  });

  /* ---- file collegati sul disco (guscio Mac/Windows): il guscio ricorda il percorso per ogni app, lo rilegge e lo riscrive ---- */
  const nativeMtime = new Map(); // id app → data di modifica del file all'ultima lettura/scrittura (per accorgersi di modifiche fatte altrove)
  async function nativeFile(op, args) {
    try { return await fsBridge.postMessage(Object.assign({ op }, args)); }
    catch (e) { const m = String((e && e.message) || e); throw new Error(/operazione sconosciuta/.test(m) ? 'unavailable' : m); } // guscio vecchio: l'app ripiega su files.open
  }
  const b64ToBuf = (s) => { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; };
  const bufToB64 = async (data) => { const u = new Uint8Array(await new Blob([data]).arrayBuffer()); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };

  /* ---- file collegati su Google Drive (versione web) ---- */
  let cloudFilesApi = null;
  const cloudFilesOn = () => webMode && !!googleClientId();
  const cloudFiles = () => cloudFilesApi || (cloudFilesApi = SuiteDrive.createFiles({ getToken: (force) => getWebAuth().getToken(force) }));
  const linkOf = (id) => { try { const x = JSON.parse(lsGet(`suite.link.${id}`)); return x && x.id ? x : null; } catch (e) { return null; } };
  /* Riquadro della shell con l'elenco dei file di Drive che finiscono con `accept` (es. ".xlsx"). Risponde {id, name, mtime, data}.
     Se serve il login, il pulsante «Accedi a Google» è un tocco diretto dell'utente (necessario per il popup). */
  function pickCloudFile(accept, current) {
    return new Promise((resolve, reject) => {
      const el = (tag, css, text) => { const x = document.createElement(tag); if (css) x.style.cssText = css; if (text != null) x.textContent = text; return x; };
      const ov = el('div', 'position:fixed;inset:0;z-index:80;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:max(12px,env(safe-area-inset-top)) 12px max(12px,env(safe-area-inset-bottom))');
      const box = el('div', 'background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:var(--radius,20px);padding:18px;max-width:460px;width:100%;max-height:100%;display:flex;flex-direction:column;gap:10px;box-shadow:var(--shadow);overflow:hidden');
      const msg = el('p', 'margin:0;font-size:14px;color:var(--text-muted)');
      const find = el('input', 'flex:0 0 auto'); find.type = 'text'; find.placeholder = 'Cerca per nome o cartella'; find.hidden = true;
      find.setAttribute('autocapitalize', 'off'); find.setAttribute('autocorrect', 'off'); find.setAttribute('aria-label', 'Cerca tra i file');
      /* l'elenco è l'unica parte che scorre; le righe non si restringono (flex:0 0 auto), altrimenti si schiacciano */
      const list = el('div', 'flex:1 1 auto;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;display:flex;flex-direction:column;gap:6px');
      const bar = el('div', 'flex:0 0 auto;display:flex;gap:8px;justify-content:flex-end');
      const no = el('button', '', 'Annulla'); no.className = 'btn ghost';
      const done = (fn) => { ov.remove(); fn(); };
      no.addEventListener('click', () => done(() => reject(new Error('annullato'))));
      let files = [], names = {}, showBk = false;
      const folder = (f) => names[f.parent] || '';
      const isBk = (f) => /^(backup|copie)/i.test(folder(f)); // le copie di sicurezza stanno in fondo, chiuse
      const size = (n) => (n ? (n >= 1048576 ? (n / 1048576).toLocaleString('it-IT', { maximumFractionDigits: 1 }) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' kB') : '');
      async function choose(f) {
        list.replaceChildren(); find.hidden = true; msg.textContent = `Scarico «${f.name}»…`;
        try { const data = await cloudFiles().download(f.id); done(() => resolve({ id: f.id, name: f.name, mtime: f.mtime, data })); }
        catch (e) { msg.textContent = 'Download non riuscito: ' + (e && e.message || e); load(); }
      }
      function row(f) {
        const b = el('button', 'flex:0 0 auto;display:flex;flex-direction:column;align-items:stretch;gap:3px;text-align:left;height:auto;padding:10px 12px;white-space:normal;font-weight:400'); b.className = 'btn';
        const top = el('span', 'display:flex;gap:8px;align-items:center');
        top.append(el('b', 'flex:1;min-width:0;overflow-wrap:anywhere', f.name));
        if (current && current.id === f.id) { const p = el('span', 'flex:0 0 auto', 'collegato ora'); p.className = 'pill'; top.append(p); }
        const d = f.mtime ? new Date(f.mtime).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '';
        b.append(top, el('small', 'color:var(--text-muted)', [folder(f) ? `Cartella «${folder(f)}»` : '', d ? `modificato ${d}` : '', size(f.size)].filter(Boolean).join(' · ')));
        b.addEventListener('click', () => choose(f)); return b;
      }
      function draw() {
        const q = find.value.trim().toLowerCase();
        const vis = files.filter((f) => !q || `${f.name} ${folder(f)}`.toLowerCase().includes(q));
        const main = vis.filter((f) => !isBk(f)), bk = vis.filter(isBk), open = showBk || !!q || !main.length;
        list.replaceChildren(...main.map(row));
        if (bk.length) {
          const t = el('button', 'flex:0 0 auto;justify-content:flex-start', `${open ? '▾' : '▸'} Copie di backup (${bk.length})`); t.className = 'btn ghost sm';
          t.addEventListener('click', () => { showBk = !open; draw(); });
          list.append(t); if (open) list.append(...bk.map(row));
        }
        if (!vis.length) list.append(el('p', 'margin:8px 0;color:var(--text-muted)', 'Nessun file corrisponde alla ricerca.'));
      }
      find.addEventListener('input', draw);
      async function load() {
        msg.textContent = 'Cerco i file su Google Drive…'; list.replaceChildren(); find.hidden = true;
        try { files = await cloudFiles().search(accept); }
        catch (e) {
          if (!(e && e.code === 'auth')) { msg.textContent = 'Google Drive non raggiungibile: ' + (e && e.message || e); return; }
          msg.textContent = 'Per leggere il file serve l\'accesso a Google.';
          const b = el('button', 'flex:0 0 auto', 'Accedi a Google'); b.className = 'btn primary';
          b.addEventListener('click', async () => { try { await getWebAuth().signIn(); load(); } catch (e2) { msg.textContent = 'Accesso a Google non riuscito.'; } });
          list.append(b); return;
        }
        names = {};
        try { if (cloudFiles().folderNames) names = await cloudFiles().folderNames(files.map((f) => f.parent)); } catch (e) { /* l'elenco resta senza cartelle */ }
        if (current) files.sort((x, y) => (y.id === current.id) - (x.id === current.id)); // il file già collegato per primo
        msg.textContent = files.length ? 'Tocca il file da collegare: verrà riletto e salvato direttamente su Drive.' : `Nessun file ${accept || ''} trovato su Google Drive.`;
        find.hidden = files.length < 6; find.value = ''; showBk = false; draw();
      }
      bar.append(no); box.append(el('strong', 'flex:0 0 auto', 'File su Google Drive'), msg, find, list, bar); ov.append(box); document.body.append(ov);
      load();
    });
  }

  /* ---------------- backup / reset ---------------- */
  async function exportBackup() {
    const data = {}; lsKeys().filter((k) => k.startsWith('suite.data.') || k.startsWith('suite.ls.') || k.startsWith('suite.shared.')).forEach((k) => { data[k] = lsGet(k); });
    const blob = new Blob([JSON.stringify({ suiteBackup: 1, date: new Date().toISOString(), layout: state.layout, apps: await allApps(), data })], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `suite-${new Date().toISOString().slice(0, 10)}.suitebackup.json`; a.click();
    toast('Backup esportato');
  }
  async function importBackup(file) {
    try {
      const b = JSON.parse(await readText(file)); if (!b.suiteBackup) throw new Error('File non valido');
      for (const r of b.apps) await putApp(r);
      Object.entries(b.data || {}).forEach(([k, v]) => lsSet(k, v));
      await refreshApps(); state.layout = norm(b.layout); saveLayout(); applyTheme(); render(); toast('Backup importato');
    } catch (err) { toast('Importazione non riuscita: ' + err.message); }
  }
  async function resetAll() {
    /* ripristino LOCALE: non deve cancellare i dati nella cartella SuiteData (niente tombstone) */
    sync.suppress = true; clearTimeout(sync.timer); sync.engine = null;
    for (const id of state.apps.keys()) await delApp(id);
    lsKeys().filter((k) => k.startsWith('suite.')).forEach(lsDel);
    sync.suppress = false;
    await boot(); toast('Suite ripristinata');
  }

  /* ---------------- app incluse (apps/index.json) ---------------- */
  /* La shell non conosce le app: legge apps/index.json (elenco di cartelle), e per ciascuna
     manifest.json + entry (+ icona). Si installa alla prima apertura e si aggiorna se cambia `version`;
     i dati dell'app restano. La collocazione nelle sezioni (defaultSections) avviene solo alla prima installazione. */
  async function fetchText(u) { const r = await fetch(u); if (!r.ok) throw new Error(u + ' ' + r.status); return r.text(); }
  async function fetchDataUrl(u) {
    const r = await fetch(u); if (!r.ok) return null; const blob = await r.blob();
    return new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
  }
  async function installBundled() {
    let ids = []; try { ids = JSON.parse(await fetchText('apps/index.json')); } catch (e) { return; } // nessuna app inclusa (es. server senza apps/)
    for (const id of ids) {
      try {
        const manifest = JSON.parse(await fetchText(`apps/${id}/manifest.json`));
        const errs = Layout.validateManifest(manifest); if (errs.length) { console.warn('manifest non valido', id, errs[0]); continue; }
        const key = `suite.bundled.${manifest.id}`;
        if (state.apps.has(manifest.id) && lsGet(key) === manifest.version) continue;
        const html = await fetchText(`apps/${id}/${manifest.entry}`);
        const iconData = manifest.icon && FILEISH.test(manifest.icon) ? await fetchDataUrl(`apps/${id}/${manifest.icon}`) : null;
        const first = !state.apps.has(manifest.id);
        await putApp({ id: manifest.id, manifest, html, iconData });
        await refreshApps();
        if (first) state.layout = (manifest.defaultSections || []).reduce((l, sec) => l.sections.some((x) => x.id === sec) ? Layout.assignApp(l, manifest.id, sec) : l, state.layout);
        lsSet(key, manifest.version);
      } catch (err) { console.warn('App inclusa non installata:', id, err); }
    }
    state.layout = norm(state.layout); saveLayout();
  }

  /* ---------------- sincronizzazione con SuiteData ---------------- */
  const fsBridge = (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.suiteFS) // macOS
    || (window.chrome && window.chrome.webview ? SuiteSync.webviewBridge(window.chrome.webview) : null); // Windows (WebView2)
  const sync = { editedAt: 0, on: false, folder: null, engine: null, timer: null, suppress: false, status: 'off', busy: false, pending: new Map() };
  const platform = /Mac/i.test(navigator.platform || '') ? 'mac' : /Win/i.test(navigator.platform || '') ? 'win' : 'ios';
  function deviceId() {
    let d = lsGet('suite.deviceId');
    if (!d) { d = `${platform}-${Math.random().toString(36).slice(2, 8)}`; try { localStorage.setItem('suite.deviceId', d); } catch (e) { /* noop */ } }
    return d;
  }
  const STATUS = { login: '🔑 Accedi a Google', ok: '✓ Aggiornato', sync: '⟳ Sincronizzo…', conflict: '⚠ Conflitto', error: '☁︎✕ Cartella non raggiungibile', off: '💾 Locale' };
  const syncLabel = () => STATUS[sync.status] || STATUS.off;
  function setStatus(s) {
    sync.status = s;
    const el = $('#runner-sync'); if (el) { el.textContent = syncLabel(); el.title = sync.folder ? 'SuiteData: ' + sync.folder : 'Dati salvati solo su questo dispositivo'; }
    const n = $('#nav-sync'); if (n) n.textContent = syncLabel();
    const sp = $('#sync-pill'); if (sp) sp.textContent = syncLabel(); // solo etichette: niente ridisegno della pagina (evita il lampeggio)
  }

  /* Un dato locale è cambiato: sincronizza tra poco (raggruppa le modifiche ravvicinate). */
  function poke(key) {
    if (!sync.on || sync.suppress || !sync.engine) return;
    if (!(String(key).startsWith('apps/') || String(key) === 'suite.layout' || SuiteSync.keyToPath(String(key)))) return;
    if (!sync.editedAt) sync.editedAt = Date.now();
    schedule(1500);
  }
  function schedule(ms) { clearTimeout(sync.timer); sync.timer = setTimeout(() => syncNow(false), ms); }

  const driver = fsBridge && {
    list: () => fsBridge.postMessage({ op: 'list' }),
    read: (path) => fsBridge.postMessage({ op: 'read', path }),
    write: (path, text) => fsBridge.postMessage({ op: 'write', path, text }),
    remove: (path) => fsBridge.postMessage({ op: 'remove', path }),
  };

  const syncAdapter = {
    async list() {
      const m = new Map();
      lsKeys().forEach((k) => { const p = SuiteSync.keyToPath(k); if (p) m.set(p, lsGet(k)); });
      SuiteSync.layoutToRecords(state.layout).forEach((v, p) => m.set(p, v));
      (await allApps()).forEach((r) => m.set(SuiteSync.appPath(r.id), r));
      return m;
    },
    async apply(path, value, deleted) {
      const appId = SuiteSync.appIdOf(path);
      sync.suppress = true;
      try {
        if (SuiteSync.isLayoutPath(path)) sync.pending.set(path, { value, deleted });
        else if (appId) { if (deleted) await delApp(appId); else await putApp(value); }
        else {
          const k = SuiteSync.pathToKey(path); if (!k) return;
          try { if (deleted) localStorage.removeItem(k); else localStorage.setItem(k, value); } catch (e) { /* noop */ }
        }
      } finally { sync.suppress = false; }
    },
    async done(changed) {
      sync.suppress = true;
      try {
        await refreshApps();
        if (sync.pending.size) state.layout = SuiteSync.applyToLayout(state.layout, sync.pending);
        sync.pending = new Map();
        state.layout = norm(state.layout);
        try { localStorage.setItem('suite.layout', JSON.stringify(state.layout)); } catch (e) { /* noop */ }
        applyTheme();
        if ([...openApps.keys()].some((rid) => changed.some((p) => p.startsWith(`data/${rid}/`) || p.startsWith(`apps/${rid}`)))) toast('Dati aggiornati da un altro dispositivo: riapri l\'app');
        if ($('#runner').hidden) render();
      } finally { sync.suppress = false; }
    },
  };

  /* Modalità web (iPhone/PWA, browser): niente guscio nativo → Google Drive API dal browser (drive-web.js) */
  const webMode = !fsBridge && /^https?:$/.test(location.protocol) && !!window.SuiteDrive;
  const googleClientId = () => (lsGet('suite.web.clientId') || (window.SUITE_CONFIG && window.SUITE_CONFIG.googleClientId) || '').trim();
  let webAuth = null;
  const getWebAuth = () => webAuth || (webAuth = SuiteDrive.createAuth({ clientId: googleClientId() }));

  async function initSync() {
    sync.on = false; sync.folder = null;
    if (webMode) { if (lsGet('suite.web.sync') === '1' && googleClientId()) { sync.on = true; sync.folder = 'Google Drive › SuiteData'; } return; }
    if (!fsBridge) return;
    try { const s = await fsBridge.postMessage({ op: 'status' }); if (s && s.exists) { sync.folder = s.folder; sync.on = true; } } catch (e) { /* noop */ }
  }

  function startSync() {
    if (!sync.on || sync.engine) return;
    const load = () => { try { const x = JSON.parse(lsGet('suite.syncstate')); return x && x.folder === sync.folder ? x : null; } catch (e) { return null; } };
    const drv = webMode ? SuiteDrive.createDriveDriver({ getToken: (force) => getWebAuth().getToken(force) }) : driver;
    sync.engine = SuiteSync.createSync({
      driver: drv, adapter: syncAdapter, deviceId: deviceId(), editedAt: () => sync.editedAt,
      store: { load, save: (st) => { try { localStorage.setItem('suite.syncstate', JSON.stringify(Object.assign({}, st, { folder: sync.folder }))); } catch (e) { /* noop */ } } },
      onStatus: (s, info) => { setStatus(s === 'error' && info && info.code === 'auth' ? 'login' : s); if (s === 'error') console.warn('sync:', info); },
    });
    setStatus('sync'); syncNow(false);
  }

  async function syncNow(manual) {
    if (!sync.on || !sync.engine) return;
    try { const r = await sync.engine.sync(); sync.editedAt = 0; if (manual) toast(r.changed ? `Sincronizzato: ${r.changed} modifiche ricevute` : 'Già aggiornato'); }
    catch (e) { if (manual) toast(e && e.code === 'auth' ? 'Accedi a Google per sincronizzare' : 'Sincronizzazione non riuscita: ' + (e && e.message || e)); }
  }

  async function syncChoose() {
    try {
      const s = await fsBridge.postMessage({ op: 'choose' });
      if (!s || !s.exists) return;
      if (s.folder !== sync.folder) { sync.engine = null; try { localStorage.removeItem('suite.syncstate'); } catch (e) { /* noop */ } }
      sync.folder = s.folder; sync.on = true; state.layout = norm(state.layout);
      startSync(); render();
    } catch (e) { toast('Cartella non valida: ' + (e && e.message || e)); }
  }
  async function syncOff() {
    await fsBridge.postMessage({ op: 'disconnect' });
    try { localStorage.removeItem('suite.syncstate'); } catch (e) { /* noop */ }
    clearTimeout(sync.timer); sync.engine = null; sync.on = false; sync.folder = null; setStatus('off'); render();
    toast('Cartella scollegata: i dati restano in questo dispositivo');
  }

  /* ---- modalità web: attivazione, login, disattivazione ---- */
  function webClientModal() {
    modal({ title: 'ID client Google', submit: 'Salva',
      body: `<label class="field">ID client OAuth (finisce con .apps.googleusercontent.com)<input type="text" name="cid" value="${esc(googleClientId())}" autocapitalize="off" autocorrect="off" spellcheck="false"></label>`,
      onSubmit: (fd) => { const v = String(fd.get('cid') || '').trim(); if (!/\.apps\.googleusercontent\.com$/.test(v)) throw new Error('ID client non valido'); lsSet('suite.web.clientId', v); webAuth = null; render(); } });
  }
  async function webEnable() {
    if (!googleClientId()) return webClientModal();
    try { await getWebAuth().signIn(); } catch (e) { return toast('Accesso a Google non riuscito' + (e && e.message ? ': ' + e.message : '')); }
    lsSet('suite.web.sync', '1'); sync.on = true; sync.folder = 'Google Drive › SuiteData'; state.layout = norm(state.layout);
    startSync(); render();
  }
  async function webSignIn() {
    try { await getWebAuth().signIn(); syncNow(true); } catch (e) { toast('Accesso a Google non riuscito'); }
  }
  function webDisable() {
    try { localStorage.removeItem('suite.web.sync'); localStorage.removeItem('suite.syncstate'); } catch (e) { /* noop */ }
    getWebAuth().signOut(); clearTimeout(sync.timer); sync.engine = null; sync.on = false; sync.folder = null; setStatus('off'); render();
    toast('Sincronizzazione disattivata: i dati restano su questo dispositivo');
  }
  window.addEventListener('online', () => { if (sync.on) schedule(500); });

  function syncRows() {
    if (webMode) {
      if (!sync.on) return `<div class="list-row"><span class="grow"><b>Sincronizzazione con Google Drive</b><small>${googleClientId() ? 'Accedi con Google per avere sezioni, app e dati uguali su tutti i dispositivi (cartella SuiteData).' : 'Prima va inserito l\'ID client Google (vedi guida).'}</small></span>
        ${googleClientId() ? '<button class="btn sm primary" data-act="web-enable">Accedi e attiva</button>' : ''}<button class="btn sm" data-act="web-client">ID client…</button></div>`;
      const st = sync.engine ? sync.engine.state() : { conflicts: [] };
      const conf = (st.conflicts || []).filter((c) => c.at > (st.seenAt || 0)).slice(0, 5).map((c) => `<small>${esc(new Date(c.at).toLocaleString('it-IT'))} · ${esc(c.path)} · ${esc(c.why)}</small>`).join('<br>');
      return `<div class="list-row"><span class="grow"><b>Sincronizzazione</b><small>${esc(sync.folder)}</small><small>Dispositivo: ${esc(deviceId())}</small></span>
          <span class="pill" id="sync-pill">${esc(syncLabel())}</span>${sync.status === 'login' ? '<button class="btn sm primary" data-act="web-signin">Accedi</button>' : ''}<button class="btn sm" data-act="sync-now">Sincronizza ora</button></div>
        <div class="list-row"><span class="grow"><b>Google Drive</b><small>Disattiva la sincronizzazione (i dati locali restano)</small></span><button class="btn sm danger" data-act="web-disable">Disattiva</button></div>
        ${conf ? `<div class="list-row"><span class="grow"><b>Conflitti recenti</b><small>La versione sostituita è salvata in SuiteData/.conflicts</small>${conf}</span><button class="btn sm" data-act="sync-clear">Segna come visti</button></div>` : ''}`;
    }
    if (!fsBridge) return `<div class="list-row"><span class="grow"><b>Archiviazione</b><small>Dati salvati solo in questo browser. La sincronizzazione con Google Drive è disponibile nell'app Suite.</small></span><span class="pill">💾 Locale</span></div>`;
    if (!sync.on) return `<div class="list-row"><span class="grow"><b>Sincronizzazione</b><small>Scegli la cartella SuiteData in Google Drive: sezioni, app e dati saranno gli stessi su tutti i tuoi dispositivi.</small></span>
      <button class="btn sm primary" data-act="sync-choose">Scegli cartella…</button></div>`;
    const st = sync.engine ? sync.engine.state() : { conflicts: [] };
    const conf = (st.conflicts || []).filter((c) => c.at > (st.seenAt || 0)).slice(0, 5).map((c) => `<small>${esc(new Date(c.at).toLocaleString('it-IT'))} · ${esc(c.path)} · ${esc(c.why)}</small>`).join('<br>');
    return `<div class="list-row"><span class="grow"><b>Sincronizzazione</b><small>${esc(sync.folder)}</small><small>Dispositivo: ${esc(deviceId())}</small></span>
        <span class="pill" id="sync-pill">${esc(syncLabel())}</span><button class="btn sm" data-act="sync-now">Sincronizza ora</button></div>
      <div class="list-row"><span class="grow"><b>Cartella</b><small>Cambia o scollega la cartella (i dati locali restano)</small></span>
        <button class="btn sm" data-act="sync-choose">Cambia…</button><button class="btn sm danger" data-act="sync-off">Scollega</button></div>
      ${conf ? `<div class="list-row"><span class="grow"><b>Conflitti recenti</b><small>La versione sostituita è salvata in SuiteData/.conflicts</small>${conf}</span><button class="btn sm" data-act="sync-clear">Segna come visti</button></div>` : ''}`;
  }

  /* Eventi dal guscio nativo (cartella cambiata) + ritorno in primo piano + controllo periodico */
  window.__suiteFSChanged = () => { if (sync.on && sync.status !== 'sync') schedule(800); };
  window.addEventListener('focus', () => { if (sync.on) schedule(300); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && sync.on) schedule(300); });
  setInterval(() => { if (sync.on && !document.hidden) syncNow(false); }, 60000);

  /* PWA: offline per la shell (solo su https o localhost; non nel guscio nativo) */
  if (!fsBridge && 'serviceWorker' in navigator && (/^https:$/.test(location.protocol) || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* noop */ });
  }

  /* ---------------- avvio ---------------- */
  async function boot() {
    await initSync();
    await refreshApps();
    let l = null; try { l = JSON.parse(lsGet('suite.layout')); } catch (e) { /* layout corrotto: ripartenza */ }
    if (!l || !lsGet('suite.seeded')) {
      state.layout = norm(Layout.create()); lsSet('suite.seeded', '1');
    } else {
      /* pulizia una tantum delle vecchie app dimostrative rimosse (la Lista spesa tornerà come app vera) */
      if (!lsGet('suite.demoCleanup3')) {
        for (const id of ['demo-note', 'demo-commesse', 'demo-peso', 'demo-promemoria', 'demo-spesa']) {
          if (state.apps.has(id)) { await delApp(id); lsKeys().filter((k) => k.startsWith(`suite.data.${id}.`) || k.startsWith(`suite.ls.${id}.`)).forEach(lsDel); }
        }
        await refreshApps(); lsSet('suite.demoCleanup3', '1');
      }
      state.layout = norm(l);
    }
    await installBundled();
    state.view = { type: 'section', id: state.layout.settings.startSection };
    applyTheme(); render();
    startSync();
  }
  boot();
  window.__suite = { state, Layout }; // utile per debug nel prototipo
})();
