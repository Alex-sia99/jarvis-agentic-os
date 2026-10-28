/**
 * Catalogue AUTOMATIQUE des routes de l'API locale, extrait du code de server.js (toujours à jour).
 * Sert à Jarvis (outil `api_routes`) pour découvrir n'importe quelle action de la plateforme,
 * puis l'appeler avec `agentos_api`. Chaque route porte la section (commentaire `// ===== … =====`)
 * sous laquelle elle est déclarée, et ses paramètres lus dans le code du gestionnaire :
 * `query` (url.searchParams.get("x")) et `body` (champs `b.x` du corps JSON).
 */
const fs = require("fs");
const path = require("path");

let cached = null;
const BLOCK_MAX = 45; // lignes de gestionnaire lues au plus pour en déduire les paramètres

function build() {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const lines = src.split(/\r?\n/);
  const routes = [];
  const seen = new Set();
  let section = "";
  let pending = null; // dernière regex `m = /^…$/.exec(p)` en attente de ses `if (m && req.method === …)`
  let at = 0;
  const add = (method, p) => {
    const key = method + " " + p;
    if (seen.has(key)) return;
    seen.add(key);
    routes.push({ method, path: p, section, line: at });
  };
  const flush = () => { if (pending && !pending.used) add("*", pending.path); pending = null; };
  for (at = 0; at < lines.length; at++) {
    const line = lines[at];
    const sec = /^\s*\/\/\s*=+\s*(.+?)\s*=+\s*$/.exec(line);
    if (sec) { section = sec[1]; continue; }
    const exact = /\bp === "(\/api\/[^"]+)"(?:\s*&&\s*req\.method === "(\w+)")?/.exec(line);
    if (exact) { add(exact[2] || "GET", exact[1]); continue; }
    const re = /\b(?:m|km)\s*=\s*\/\^(.+?)\$\/\.exec\(p\)/.exec(line);
    if (re) {
      flush();
      const p = re[1]
        .replace(/\\\//g, "/")
        .replace(/\(\[[^\]]*\]\+\)/g, ":id")
        .replace(/\\\./g, ".");
      pending = { path: p, used: false };
      const same = /if \((?:m|km)\s*&&\s*req\.method === "(\w+)"\)/.exec(line);
      if (same) { add(same[1], p); pending.used = true; }
      continue;
    }
    if (pending) {
      const m = /if \((?:m|km)\s*&&\s*req\.method === "(\w+)"\)/.exec(line);
      if (m) { add(m[1], pending.path); pending.used = true; continue; }
      if (/^\s*if \((?:m|km)\)/.test(line)) { add("GET", pending.path); pending.used = true; }
    }
  }
  flush();

  // Paramètres : on lit le bloc du gestionnaire, de sa ligne jusqu'à la route suivante
  const starts = [...new Set(routes.map((r) => r.line))].sort((a, b) => a - b);
  for (const r of routes) {
    const next = starts.find((l) => l > r.line);
    const end = Math.min(next === undefined ? lines.length : next, r.line + BLOCK_MAX);
    const block = lines.slice(r.line, end).join("\n");
    const query = [...new Set([...block.matchAll(/searchParams\.get\("(\w+)"\)/g)].map((x) => x[1]))];
    const body = [...new Set([...block.matchAll(/\b(?:b|filters|\(await readBody\(req\)\))\.([a-zA-Z_]\w*)/g)].map((x) => x[1]))];
    if (query.length) r.query = query;
    if (body.length) r.body = body;
    else if (/readBody\(req\)/.test(block)) r.body = ["…"]; // corps passé tel quel à la lib
    delete r.line;
  }
  return routes;
}

function all() {
  if (!cached) cached = build();
  return cached;
}

/** Signature lisible : `POST /api/x/:id {a, b} ?q  [Section]`. */
function describe(r) {
  return `${r.method} ${r.path}${r.query ? " ?" + r.query.join("&") : ""}${r.body ? " {" + r.body.join(", ") + "}" : ""}  [${r.section}]`;
}

/** Recherche par mots (chemin + section), tous les mots trouvés d'abord. */
function search(query, limit = 40) {
  const tokens = String(query || "").toLowerCase().split(/[^a-z0-9àâçéèêëîïôûùüÿœ/_-]+/i).filter((t) => t.length > 1);
  const list = all();
  if (!tokens.length) return list.slice(0, limit);
  return list
    .map((r) => { const hay = (r.method + " " + r.path + " " + r.section).toLowerCase(); return { r, s: tokens.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0) }; })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.r);
}

/** Résumé par domaine (premier segment après /api/). */
function domains() {
  const out = {};
  for (const r of all()) {
    const d = r.path.split("/")[2] || "?";
    out[d] = (out[d] || 0) + 1;
  }
  return out;
}

module.exports = { all, search, domains, describe };
