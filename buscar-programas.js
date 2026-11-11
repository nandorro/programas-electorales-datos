// Busca los programas electorales en las webs de los partidos, los descarga, extrae el texto
// y escribe programas/<ID>.json (+ programas/index.json) para que la versión web/iPhone los lea.
// Uso:  node buscar-programas.js [carpeta-del-sitio]     (por defecto, la carpeta actual)
// Requiere Node 18+ y:  npm i pdfjs-dist@3.11.174
const fs = require("fs"), path = require("path"), vm = require("vm");
const SITE = path.resolve(process.argv[2] || ".");
const here = fs.existsSync(path.join(SITE, "programas.js")) ? SITE : path.join(__dirname, "www");

// Reutiliza la lógica de la app (descubrir enlace, trocear, detectar cambios)
const ctx = { window: {}, console, URL, setTimeout, AbortController, fetch };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(here, "programas.js"), "utf8") + ";this.PE=PE", ctx);
const PE = ctx.PE;
const pdfjs = require("pdfjs-dist/legacy/build/pdf.js");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36";
const data = JSON.parse(fs.readFileSync(path.join(SITE, "data.json"), "utf8"));
const OUT = path.join(SITE, "programas"); fs.mkdirSync(OUT, { recursive: true });
const MAXMB = 150;
const RFILE = path.join(OUT, "rechazados.json");
const rechazados = fs.existsSync(RFILE) ? JSON.parse(fs.readFileSync(RFILE, "utf8")) : [];

async function get(url, method = "GET", ms = 60000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { method, headers: { "User-Agent": UA, Accept: "*/*" }, redirect: "follow", signal: ctl.signal }); }
  finally { clearTimeout(t); }
}
async function extract(buf) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), disableFontFace: true, isEvalSupported: false }).promise;
  const chunks = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i), tc = await page.getTextContent();
    chunks.push(...PE.chunkPage(i, tc.items.map(x => x.str).join(" ")));
    page.cleanup();
  }
  const pages = doc.numPages; await doc.destroy(); return { pages, chunks };
}

(async () => {
  const index = [], resumen = [];
  for (const p of data.parties) {
    const id = p.id, file = path.join(OUT, id + ".json");
    const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    try {
      let url = (data.programUrls || {})[id];
      if (!url && (data.programPages || {})[id]) {
        const r = await get(data.programPages[id], "GET", 30000);
        if (!r.ok) throw new Error("web del partido: HTTP " + r.status);
        url = PE.findProgramLink(await r.text(), data.programPages[id]);
      }
      if (url && rechazados.includes(url)) { resumen.push(`${id}: PDF descartado antes (no es el programa de 2026)`); continue; }
      if (!url) { resumen.push(`${id}: ${(data.programPages || {})[id] ? "programa aún no publicado" : "sin web oficial configurada"}`); if (prev) index.push(meta(id, prev)); continue; }
      const h = await get(url, "HEAD", 30000).catch(() => null);
      const info = h && h.ok ? { etag: h.headers.get("etag") || "", lm: h.headers.get("last-modified") || "", size: +h.headers.get("content-length") || 0 } : {};
      if (prev && !PE.changed({ url: prev.url, etag: prev.etag, lm: prev.lm, size: prev.size, checked: Date.now() }, url, info)) {
        resumen.push(`${id}: sin cambios`); index.push(meta(id, prev)); continue;
      }
      if (info.size && info.size > MAXMB * 1048576) throw new Error(`PDF demasiado grande (${(info.size / 1048576).toFixed(0)} MB)`);
      const r = await get(url, "GET", 300000);
      if (!r.ok) throw new Error("descarga: HTTP " + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.slice(0, 5).toString() !== "%PDF-") throw new Error("el archivo no es un PDF");
      const ex = await extract(buf);
      if (!ex.chunks.length) throw new Error("el PDF no tiene texto legible (imagen escaneada)");
      if (!PE.looksLikeProgram(ex.chunks, ex.pages)) { if (prev && prev.url === url) fs.unlinkSync(file); rechazados.push(url); fs.writeFileSync(RFILE, JSON.stringify(rechazados, null, 1)); throw new Error("el PDF no parece el programa del 29-N 2026 (descartado): " + url); }
      const rec = { url, etag: r.headers.get("etag") || info.etag || "", lm: r.headers.get("last-modified") || info.lm || "", size: buf.length, pages: ex.pages, updated: new Date().toISOString().slice(0, 10), chunks: ex.chunks };
      fs.writeFileSync(file, JSON.stringify(rec));
      index.push(meta(id, rec)); resumen.push(`${id}: ✅ ${prev ? "actualizado" : "nuevo"} (${ex.pages} págs., ${(buf.length / 1048576).toFixed(1)} MB)`);
    } catch (e) {
      resumen.push(`${id}: ⚠️ ${e.message}`); if (prev) index.push(meta(id, prev));
    }
  }
  function meta(id, r) { return { id, url: r.url, pages: r.pages, updated: r.updated, size: r.size }; }
  fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify(index, null, 1));
  console.log(resumen.join("\n"));
})();
