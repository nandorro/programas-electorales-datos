// Gestión de programas electorales: descubrir PDF, detectar cambios, descargar, indexar y buscar.
// Todo queda en el móvil (archivo PDF + índice de texto en IndexedDB) y funciona sin conexión.
const PE = (() => {
  const UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36";
  const CAP = window.Capacitor;
  const NATIVE = !!(CAP && CAP.isNativePlatform && CAP.isNativePlatform());
  const plug = n => CAP && CAP.Plugins && CAP.Plugins[n];
  const STOPW = new Set("que como los las del con por para una uno unos unas sus sobre hacen hara haran piensa piensan opina quiere quieren van sera han hay esta este estos son".split(" "));

  const norm = s => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9ñ ]/g, " ");
  const stem = w => w.slice(0, w.length >= 10 ? 9 : 6);
  const tokensOf = q => [...new Set(norm(q).split(/\s+/).filter(w => w.length > 2 && !STOPW.has(w)).map(stem))];

  // ---------- almacenamiento (IndexedDB) ----------
  const openDB = () => new Promise((res, rej) => {
    const r = indexedDB.open("pe-db", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("prog", { keyPath: "id" });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  async function dbAll() {
    try {
      const db = await openDB();
      return await new Promise((res, rej) => { const q = db.transaction("prog").objectStore("prog").getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    } catch (e) { return []; }
  }
  async function dbPut(o) {
    const db = await openDB();
    const clean = Object.assign({}, o, { chunks: o.chunks.map(c => ({ p: c.p, t: c.t })) }); // sin la caché interna _n
    return new Promise((res, rej) => { const t = db.transaction("prog", "readwrite"); t.objectStore("prog").put(clean); t.oncomplete = res; t.onerror = () => rej(t.error); });
  }
  const PROGS = {}; // id -> {id,url,etag,lm,size,checked,updated,pages,chunks:[{p,t}]}
  async function load() { (await dbAll()).forEach(o => PROGS[o.id] = o); return PROGS; }

  // ---------- red ----------
  async function http(url, method = "GET") {
    if (NATIVE && plug("CapacitorHttp")) {
      const r = await plug("CapacitorHttp").request({ url, method, headers: { "User-Agent": UA, Accept: "*/*" }, responseType: "text", connectTimeout: 15000, readTimeout: 25000 });
      const h = {}; Object.keys(r.headers || {}).forEach(k => h[k.toLowerCase()] = r.headers[k]);
      return { status: r.status, headers: h, data: typeof r.data === "string" ? r.data : "" };
    }
    const ctl = new AbortController(); setTimeout(() => ctl.abort(), 20000);
    const r = await fetch(url, { method, signal: ctl.signal });
    const h = {}; r.headers.forEach((v, k) => h[k.toLowerCase()] = v);
    return { status: r.status, headers: h, data: method === "GET" ? await r.text() : "" };
  }

  // ---------- descubrimiento: busca el PDF del programa en la web del partido ----------
  function findProgramLink(html, pageUrl) {
    const cands = [];
    const re = /href\s*=\s*["']([^"']+?\.pdf[^"']*)["']/gi; let m;
    while ((m = re.exec(html))) {
      let u; try { u = new URL(m[1].replace(/&amp;/g, "&"), pageUrl).href; } catch (e) { continue; }
      const l = decodeURIComponent(u).toLowerCase();
      let sc = 0;
      if (/programa/.test(l)) sc += 3;
      if (/electoral/.test(l)) sc += 2;
      if (/2026|26-|29nov|generales/.test(l)) sc += 1;
      if (/\/uploads\/2026\/1[01]\//.test(l)) sc += 2;          // PDF subido en oct/nov de 2026 (p. ej. LA-RECONSTRUCCION-NACIONAL.pdf)
      if (/estatut|reglament|manifesto|memoria|cuentas|aviso|privacidad|cookies|transparencia|comunicado/.test(l)) sc -= 4;
      if (/resumen|accesible|lectura|facil|fácil/.test(l)) sc -= 1;
      if (sc >= 3) cands.push({ u, sc });
    }
    cands.sort((a, b) => b.sc - a.sc);
    return cands.length ? cands[0].u : null;
  }
  async function discover(pageUrl) {
    const r = await http(pageUrl);
    if (r.status >= 400 || !r.data) throw new Error("HTTP " + r.status);
    return findProgramLink(r.data, pageUrl);
  }

  // ---------- cambios ----------
  async function remoteInfo(url) {
    try {
      const r = await http(url, "HEAD");
      if (r.status >= 400) return {};
      return { etag: r.headers["etag"], lm: r.headers["last-modified"], size: +r.headers["content-length"] || 0 };
    } catch (e) { return {}; }
  }
  function changed(prev, url, info) {
    if (!prev || prev.url !== url) return true;
    if (info.etag && info.etag !== prev.etag) return true;
    if (info.lm && info.lm !== prev.lm) return true;
    if (info.size && info.size !== prev.size) return true;
    if (!info.etag && !info.lm && !info.size) return Date.now() - (prev.checked || 0) > 7 * 864e5;
    return false;
  }

  // ---------- extracción y troceado ----------
  function chunkPage(p, text) {
    const out = [], sents = text.replace(/(\p{L})-\s+(\p{Ll})/gu, "$1$2").replace(/\s+/g, " ").trim().match(/[^.;:!?]+[.;:!?]*\s*/g) || [];
    let cur = "";
    const push = () => { if (cur.trim().length > 40) out.push({ p, t: cur.trim() }); cur = ""; };
    for (let s of sents) { s = s.trim(); if (!s) continue; if ((cur + " " + s).length > 800 && cur) push(); cur += (cur ? " " : "") + s; if (cur.length >= 500) push(); }
    push();
    return out;
  }
  function loadPdfLib() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    return new Promise((res, rej) => { const s = document.createElement("script"); s.src = "lib/pdf.min.js"; s.onload = () => res(window.pdfjsLib); s.onerror = () => rej(new Error("pdf.js no disponible")); document.head.appendChild(s); });
  }
  async function extract(src, onProgress) {
    const lib = await loadPdfLib();
    lib.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.js";
    const doc = await lib.getDocument({ url: src, disableFontFace: true, isEvalSupported: false }).promise;
    const chunks = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      chunks.push(...chunkPage(i, tc.items.map(x => x.str).join(" ")));
      page.cleanup();
      if (onProgress && (i % 5 === 0 || i === doc.numPages)) onProgress(i, doc.numPages);
    }
    const n = doc.numPages; await doc.destroy();
    return { pages: n, chunks };
  }

  // ---------- descarga a disco ----------
  async function download(id, url, onBytes) {
    const FS = plug("Filesystem");
    if (NATIVE && FS) {
      const path = `programas/${id}.pdf`;
      let h; if (onBytes && FS.addListener) h = await FS.addListener("progress", e => { if (e.url === url) onBytes(e.bytes, e.contentLength); });
      try { await FS.downloadFile({ url, path, directory: "DATA", recursive: true, progress: !!onBytes, headers: { "User-Agent": UA } }); }
      finally { if (h && h.remove) h.remove(); }
      const { uri } = await FS.getUri({ path, directory: "DATA" });
      return CAP.convertFileSrc(uri);
    }
    return url; // navegador de pruebas: pdf.js lo pedirá directamente
  }

  // ---------- navegador / iPhone: el texto lo prepara un script en GitHub ----------
  async function syncFromSite(p, urls, log) {
    const id = p.id;
    const base = (typeof REMOTE_URL === "string" && REMOTE_URL ? REMOTE_URL : location.href).replace(/[^/]*$/, "");
    let r; try { r = await fetch(base + "programas/" + id + ".json?t=" + Date.now()); } catch (e) { throw new Error("sin conexión"); }
    if (r.status === 404) { log(`${id}: programa aún no publicado`); return "none"; }
    if (!r.ok) throw new Error("HTTP " + r.status);
    const rec = await r.json(); const prev = PROGS[id];
    if (rec.url) urls[id] = rec.url;
    if (prev && prev.etag === rec.etag && prev.updated === rec.updated && prev.size === rec.size) { log(`${id}: sin cambios`); return "same"; }
    rec.id = id; rec.checked = Date.now();
    await dbPut(rec); PROGS[id] = rec;
    log(`${id}: ✅ programa guardado (${rec.pages} páginas)`);
    return prev ? "updated" : "new";
  }

  // ---------- sincronizar un partido ----------
  async function syncParty(p, urls, pages, log) {
    if (!NATIVE) return syncFromSite(p, urls, log);
    const id = p.id; let url = urls[id];
    if (!url && pages[id]) {
      try { url = await discover(pages[id]); if (url) { urls[id] = url; log(`${id}: programa encontrado en su web`); } }
      catch (e) { log(`${id}: no pude consultar su web (${e.message})`); }
    }
    if (!url) { log(`${id}: programa aún no publicado`); return "none"; }
    const prev = PROGS[id], info = await remoteInfo(url);
    if (!changed(prev, url, info)) { prev.checked = Date.now(); await dbPut(prev); log(`${id}: sin cambios`); return "same"; }
    log(`${id}: descargando programa…`);
    const src = await download(id, url, (b, t) => log(`${id}: descargando ${(b / 1048576).toFixed(1)}${t ? " / " + (t / 1048576).toFixed(1) : ""} MB`, true));
    log(`${id}: leyendo el texto…`, true);
    const ex = await extract(src, (i, n) => log(`${id}: leyendo página ${i}/${n}`, true));
    if (!ex.chunks.length) throw new Error("el PDF no contiene texto legible");
    const rec = { id, url, etag: info.etag || "", lm: info.lm || "", size: info.size || 0, checked: Date.now(), updated: new Date().toISOString().slice(0, 10), pages: ex.pages, chunks: ex.chunks };
    await dbPut(rec); PROGS[id] = rec;
    log(`${id}: ✅ programa guardado (${ex.pages} páginas)`);
    return prev ? "updated" : "new";
  }

  // ---------- búsqueda en el texto del programa ----------
  // opts.need: nº mínimo de términos distintos; opts.minSc: puntuación mínima
  function search(prog, tokens, n = 3, opts = {}) {
    if (!prog || !tokens.length) return [];
    const need = opts.need || Math.max(1, Math.ceil(tokens.length * 0.4)), minSc = opts.minSc || 3;
    const res = [];
    for (const c of prog.chunks) {
      const t = c._n || (c._n = " " + norm(c.t));
      let sc = 0, dist = 0;
      for (const w of tokens) { const key = " " + w; let i = -1, k = 0; while (k < 3 && (i = t.indexOf(key, i + 1)) >= 0) k++; if (k) { dist++; sc += k; } }
      if (dist >= need) res.push({ p: c.p, t: c.t, sc: sc + dist * 2, dist });
    }
    res.sort((a, b) => b.sc - a.sc);
    const out = [], pagesUsed = new Set();
    for (const r of res) {
      if (r.sc < minSc || pagesUsed.has(r.p)) continue;
      pagesUsed.add(r.p); out.push(r); if (out.length >= n) break;
    }
    return out;
  }

  // ---------- importar PDFs ya descargados (carpeta Descargas / selector de archivos) ----------
  const NAME_FILTER = /program|electoral|manifiesto|propuest|eleccion|general|2026|\b26\b|29nov|cca|psoe|vox|sumar|podemos|junts|esquerra|bildu|pnv|eaj|bng|salf|popular/;
  const PARTY_PAT = {
    PP: /\b(partido popular|pp)\b/, PSOE: /\b(psoe|socialista obrero)\b/, VOX: /\bvox\b/, SMR: /\bsumar\b/,
    POD: /\bpodemos\b/, ERC: /\b(erc|esquerra)\b/, JXC: /\b(junts|jxcat)\b/, SALF: /\b(salf|se acabo la fiesta)\b/,
    BIL: /\b(bildu)\b/, PNV: /\b(pnv|eaj|partido nacionalista vasco)\b/, BNG: /\b(bng|bloque nacionalista galego)\b/,
    CC: /\b(coalicion canaria|cca|ccaa)\b/, MJ: /\b(por un mundo mas justo|mundo mas justo|mj|m j)\b/
  };
  // Devuelve {id} si hay un partido claro, o {id:null,cands:[...]} si hay que preguntar
  function detectParty(name, chunks) {
    const nm = norm(name), tx = norm(chunks.slice(0, 6).map(c => c.t).join(" ")).slice(0, 4000);
    const sc = Object.keys(PARTY_PAT).map(id => {
      const re = PARTY_PAT[id]; let s = re.test(nm) ? 4 : 0;
      const g = new RegExp(re.source, "g"); const m = tx.match(g); s += Math.min(m ? m.length : 0, 5);
      return { id, s };
    }).filter(x => x.s > 0).sort((a, b) => b.s - a.s);
    if (sc.length && sc[0].s >= 3 && (sc.length === 1 || sc[0].s - sc[1].s >= 2)) return { id: sc[0].id };
    return { id: null, cands: sc.map(x => x.id) };
  }
  // Abre el selector: en Chrome/Edge de escritorio busca en Descargas; en iPhone/Android usa el selector de archivos.
  async function pick() {
    if (!NATIVE && window.showDirectoryPicker) {
      try {
        const dir = await window.showDirectoryPicker({ id: "descargas", startIn: "downloads", mode: "read" });
        const files = [];
        for await (const [name, h] of dir.entries()) if (h.kind === "file" && /\.pdf$/i.test(name) && NAME_FILTER.test(norm(name))) files.push(await h.getFile());
        return { files, scanned: true };
      } catch (e) { if (e && e.name === "AbortError") return { files: [], cancel: true }; /* carpeta bloqueada: se prueba el selector de archivos */ }
      if (window.showOpenFilePicker) {
        try {
          const hs = await window.showOpenFilePicker({ id: "descargas", startIn: "downloads", multiple: true, types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }] });
          return { files: await Promise.all(hs.map(h => h.getFile())) };
        } catch (e) { if (e && e.name === "AbortError") return { files: [], cancel: true }; }
      }
    }
    return new Promise(res => {
      const i = document.createElement("input"); i.type = "file"; i.accept = ".pdf,application/pdf"; i.multiple = true; i.style.display = "none";
      i.onchange = () => { res({ files: [...i.files] }); i.remove(); };
      i.oncancel = () => { res({ files: [], cancel: true }); i.remove(); };
      document.body.appendChild(i); i.click();
    });
  }
  async function readFile(file, onProgress) {
    const url = URL.createObjectURL(file);
    try { return await extract(url, onProgress); } finally { URL.revokeObjectURL(url); }
  }
  async function saveImported(id, file, ex) {
    const rec = { id, url: "", source: "descargas", name: file.name, etag: "", lm: String(file.lastModified || ""), size: file.size, checked: Date.now(), updated: new Date().toISOString().slice(0, 10), pages: ex.pages, chunks: ex.chunks };
    await dbPut(rec); PROGS[id] = rec; return rec;
  }

  return { PROGS, pick, readFile, detectParty, saveImported, load, syncParty, search, tokensOf, norm, stem, chunkPage, findProgramLink, changed, NATIVE };
})();
