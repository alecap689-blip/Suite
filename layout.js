/* Layout store: funzioni pure sul layout (vedi docs/03-MODELLO-DATI.md §3).
   Ogni operazione restituisce un NUOVO layout; nessun effetto collaterale. */
(function (root) {
  'use strict';

  const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'sezione';

  const clone = (x) => JSON.parse(JSON.stringify(x));

  function uniqueId(base, taken) {
    let id = base, n = 2;
    while (taken.includes(id)) id = base + '-' + n++;
    return id;
  }

  function create() {
    return {
      version: 1,
      sections: [
        { id: 'lavoro', name: 'Lavoro', icon: '💼', color: '#111111', apps: [] },
        { id: 'salute', name: 'Salute', icon: '❤️', color: '#555555', apps: [] },
        { id: 'generiche', name: 'App generiche', icon: '🧰', color: '#999999', apps: [] },
      ],
      unassigned: [],
      pinned: [],
      recent: [],
      settings: { theme: 'auto', language: 'it', startSection: 'lavoro', genericSeeded: true },
    };
  }

  /* Ricalcola `unassigned` (app installate non presenti in nessuna sezione) e
     ripulisce riferimenti ad app non più installate. */
  /* opts.keepUnknown: con la sync attiva un'app può essere nel layout prima di arrivare su questo dispositivo:
     non va tolta dalle sezioni (la rimozione si propagherebbe agli altri dispositivi). */
  function normalize(layout, installedIds, opts) {
    const keep = !!(opts && opts.keepUnknown);
    const l = clone(layout);
    const known = new Set(installedIds);
    l.sections.forEach((s) => { s.apps = [...new Set(s.apps.filter((a) => keep || known.has(a)))]; });
    const used = new Set(l.sections.flatMap((s) => s.apps));
    l.unassigned = installedIds.filter((a) => !used.has(a));
    l.pinned = (l.pinned || []).filter((a) => keep || known.has(a));
    l.recent = (l.recent || []).filter((a) => known.has(a)).slice(0, 8);
    /* Migrazione: layout salvati prima dell'introduzione di "App generiche" (una sola volta;
       se l'utente la elimina dopo, non ricompare). */
    if (!l.settings.genericSeeded) {
      l.settings.genericSeeded = true;
      if (!l.sections.find((s) => s.id === 'generiche')) {
        l.sections.push({ id: 'generiche', name: 'App generiche', icon: '🧰', color: '#999999', apps: [] });
      }
    }
    if (!l.sections.find((s) => s.id === l.settings.startSection)) {
      l.settings.startSection = l.sections[0] ? l.sections[0].id : null;
    }
    return l;
  }

  function addSection(layout, name, icon, color) {
    const l = clone(layout);
    name = String(name || '').trim();
    if (!name) throw new Error('Nome sezione obbligatorio');
    const id = uniqueId(slug(name), l.sections.map((s) => s.id));
    l.sections.push({ id, name, icon: icon || '📁', color: color || '#4F6BFF', apps: [] });
    return l;
  }

  function updateSection(layout, id, patch) {
    const l = clone(layout);
    const s = l.sections.find((x) => x.id === id);
    if (!s) throw new Error('Sezione inesistente');
    if (patch.name !== undefined) {
      if (!String(patch.name).trim()) throw new Error('Nome sezione obbligatorio');
      s.name = String(patch.name).trim();
    }
    if (patch.icon !== undefined) s.icon = patch.icon;
    if (patch.color !== undefined) s.color = patch.color;
    return l;
  }

  function reorderSections(layout, ids) {
    const l = clone(layout);
    const map = new Map(l.sections.map((s) => [s.id, s]));
    const out = ids.filter((i) => map.has(i)).map((i) => map.get(i));
    l.sections.forEach((s) => { if (!ids.includes(s.id)) out.push(s); });
    l.sections = out;
    return l;
  }

  function removeSection(layout, id) {
    const l = clone(layout);
    l.sections = l.sections.filter((s) => s.id !== id);
    return l; // le app orfane vengono ricalcolate da normalize()
  }

  function assignApp(layout, appId, sectionId, index) {
    const l = clone(layout);
    const s = l.sections.find((x) => x.id === sectionId);
    if (!s) throw new Error('Sezione inesistente');
    if (s.apps.includes(appId)) return l;
    if (index === undefined || index < 0 || index > s.apps.length) s.apps.push(appId);
    else s.apps.splice(index, 0, appId);
    return l;
  }

  function unassignApp(layout, appId, sectionId) {
    const l = clone(layout);
    const s = l.sections.find((x) => x.id === sectionId);
    if (s) s.apps = s.apps.filter((a) => a !== appId);
    return l;
  }

  function reorderApps(layout, sectionId, appIds) {
    const l = clone(layout);
    const s = l.sections.find((x) => x.id === sectionId);
    if (!s) throw new Error('Sezione inesistente');
    const out = appIds.filter((a) => s.apps.includes(a));
    s.apps.forEach((a) => { if (!out.includes(a)) out.push(a); });
    s.apps = out;
    return l;
  }

  /* Disinstallazione: toglie l'app da sezioni e preferiti (con keepUnknown non lo farebbe normalize). */
  function removeApp(layout, appId) {
    const l = clone(layout);
    l.sections.forEach((s) => { s.apps = s.apps.filter((a) => a !== appId); });
    l.pinned = (l.pinned || []).filter((a) => a !== appId);
    l.recent = (l.recent || []).filter((a) => a !== appId);
    return l;
  }

  function touchRecent(layout, appId) {
    const l = clone(layout);
    l.recent = [appId, ...(l.recent || []).filter((a) => a !== appId)].slice(0, 8);
    return l;
  }

  function togglePinned(layout, appId) {
    const l = clone(layout);
    l.pinned = l.pinned.includes(appId) ? l.pinned.filter((a) => a !== appId) : [...l.pinned, appId];
    return l;
  }

  /* Valida un manifest (vedi schemas/app-manifest.schema.json). Ritorna lista errori. */
  function validateManifest(m) {
    const err = [];
    if (!m || typeof m !== 'object') return ['Manifest non valido'];
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(m.id || '')) err.push('id: slug minuscolo con trattini');
    if (!m.name) err.push('name obbligatorio');
    if (!/^\d+\.\d+\.\d+$/.test(m.version || '')) err.push('version: formato x.y.z');
    if (!m.entry) err.push('entry obbligatorio');
    if (m.color && !/^#[0-9a-fA-F]{6}$/.test(m.color)) err.push('color: formato #RRGGBB');
    return err;
  }

  const api = { create, normalize, addSection, updateSection, reorderSections, removeSection,
    assignApp, unassignApp, reorderApps, removeApp, touchRecent, togglePinned, validateManifest, slug };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Layout = api;
})(typeof self !== 'undefined' ? self : this);
