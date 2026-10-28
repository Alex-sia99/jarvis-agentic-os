#!/usr/bin/env node
/**
 * Installe Jarvis dans une copie d'Agentic OS.
 *
 *   node install.js "C:\chemin\vers\agent-os"            installe (copie des fichiers + branchements)
 *   node install.js "C:\chemin\vers\agent-os" --dry-run  montre ce qui serait fait, sans rien écrire
 *   node install.js "C:\chemin\vers\agent-os" --remove   retire les branchements (les fichiers copiés restent)
 *
 * Ce que fait l'installation (idempotente : relancer ne change rien si tout est déjà en place) :
 *   1. copie jarvis/lib/*.js, jarvis/public/*, jarvis/scripts/*, jarvis/docs/* dans agent-os/ (sauvegarde
 *      *.bak-jarvis des fichiers remplacés qui différaient) ;
 *   2. server.js : ajoute `const jarvisRoutes = require("./lib/jarvis-routes");` et, dans le gestionnaire
 *      de requêtes, `if (await jarvisRoutes.handle({ req, res, url, p, json, readBody })) return;` juste
 *      avant la route /api/health ;
 *   3. public/index.html : feuille jarvis.css, bouton « Jarvis » dans la barre du haut, script js/jarvis.js
 *      et `Jarvis.boot()` après `AgentOS.boot()` ;
 *   4. vérifie public/js/core.js (événement `agentos:navigated` et mode `?embed=1`) et le signale s'il
 *      manque (voir docs/INSTALL.md).
 * Aucune dépendance npm. Node ≥ 18.
 */
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--"));
const DRY = args.includes("--dry-run");
const REMOVE = args.includes("--remove");
if (!target) {
  console.error('usage : node install.js "<dossier agent-os>" [--dry-run] [--remove]');
  process.exit(2);
}
const T = path.resolve(target);
const SRC = path.join(__dirname, "jarvis");
const log = (m) => console.log((DRY ? "[dry-run] " : "") + m);
const read = (f) => fs.readFileSync(f, "utf8");
const write = (f, s) => { if (!DRY) fs.writeFileSync(f, s); };

// ───────────────────────────── 0. vérifications
for (const must of ["server.js", "lib/vault.js", "lib/store.js", "lib/claude.js", "lib/telegram.js", "public/index.html", "public/js/core.js"]) {
  if (!fs.existsSync(path.join(T, must))) {
    console.error(`✗ ${must} introuvable dans ${T} : ce dossier n'est pas une installation d'Agentic OS compatible.`);
    process.exit(1);
  }
}
const serverFile = path.join(T, "server.js");
const htmlFile = path.join(T, "public", "index.html");
let server = read(serverFile);
let html = read(htmlFile);

// ───────────────────────────── --remove : retirer les branchements
if (REMOVE) {
  let n = 0;
  const s2 = server
    .replace(/^const jarvisRoutes = require\("\.\/lib\/jarvis-routes"\);\r?\n/m, () => { n++; return ""; })
    .replace(/^[ \t]*if \(await jarvisRoutes\.handle\(\{ req, res, url, p, json, readBody \}\)\) return;\r?\n/m, () => { n++; return ""; });
  const h2 = html
    .replace(/[ \t]*<link rel="stylesheet" href="jarvis\.css" \/>\r?\n/, () => { n++; return ""; })
    .replace(/[ \t]*<button class="btn btn-ghost btn-jarvis" id="btn-jarvis"[^\n]*\n/, () => { n++; return ""; })
    .replace(/[ \t]*<script src="js\/jarvis\.js"><\/script>\r?\n/, () => { n++; return ""; })
    .replace(/AgentOS\.boot\(\); Jarvis\.boot\(\);/, () => { n++; return "AgentOS.boot();"; });
  write(serverFile, s2);
  write(htmlFile, h2);
  log(`branchements retirés (${n} modifications). Les fichiers lib/jarvis*.js, public/jarvis.css, public/js/jarvis.js restent en place.`);
  process.exit(0);
}

// ───────────────────────────── 1. copie des fichiers
const FILES = [
  ["lib/jarvis.js", "lib/jarvis.js"],
  ["lib/routes.js", "lib/routes.js"],
  ["lib/jarvis-routes.js", "lib/jarvis-routes.js"],
  ["public/jarvis.css", "public/jarvis.css"],
  ["public/js/jarvis.js", "public/js/jarvis.js"],
  ["scripts/jarvis-desktop.py", "scripts/jarvis-desktop.py"],
  ["docs/JARVIS-ACCES.md", "docs/JARVIS-ACCES.md"],
];
for (const [from, to] of FILES) {
  const src = path.join(SRC, from);
  const dst = path.join(T, to);
  const same = fs.existsSync(dst) && read(dst) === read(src);
  if (same) { log(`= ${to} (identique)`); continue; }
  if (fs.existsSync(dst)) { if (!DRY) fs.copyFileSync(dst, dst + ".bak-jarvis"); log(`~ ${to} remplacé (sauvegarde ${to}.bak-jarvis)`); }
  else log(`+ ${to}`);
  if (!DRY) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); }
}

// ───────────────────────────── 2. server.js
if (!/require\("\.\/lib\/jarvis-routes"\)/.test(server)) {
  // après la dernière ligne `const x = require("./lib/…")` du préambule
  const lines = server.split(/\r?\n/);
  let last = -1;
  lines.forEach((l, i) => { if (/^const \w+ = require\("\.\/lib\//.test(l)) last = i; });
  if (last < 0) { console.error("✗ server.js : impossible de trouver les require(\"./lib/…\") pour insérer jarvis-routes"); process.exit(1); }
  lines.splice(last + 1, 0, 'const jarvisRoutes = require("./lib/jarvis-routes");');
  server = lines.join("\n");
  log("+ server.js : require(\"./lib/jarvis-routes\")");
} else log("= server.js : require déjà présent");

if (!/jarvisRoutes\.handle\(/.test(server)) {
  const anchor = server.search(/^[ \t]*if \(p === "\/api\/health"\)/m);
  if (anchor < 0) { console.error("✗ server.js : route /api/health introuvable (point d'insertion des routes Jarvis). Voir docs/INSTALL.md."); process.exit(1); }
  const indent = (server.slice(0, anchor).match(/[ \t]*$/) || [""])[0];
  const lineStart = server.lastIndexOf("\n", anchor) + 1;
  const ind = server.slice(lineStart, anchor + indent.length).match(/^[ \t]*/)[0];
  server = server.slice(0, lineStart) + `${ind}// ===== JARVIS (routes dans lib/jarvis-routes.js) =====\n${ind}if (await jarvisRoutes.handle({ req, res, url, p, json, readBody })) return;\n` + server.slice(lineStart);
  log("+ server.js : hook des routes Jarvis avant /api/health");
} else log("= server.js : hook des routes déjà présent");
if (server !== read(serverFile)) write(serverFile, server);

// ───────────────────────────── 3. public/index.html
let changed = false;
if (!/href="jarvis\.css"/.test(html)) {
  html = html.replace(/<\/head>/, '  <link rel="stylesheet" href="jarvis.css" />\n</head>');
  changed = true; log("+ index.html : jarvis.css");
} else log("= index.html : jarvis.css déjà présent");
if (!/id="btn-jarvis"/.test(html)) {
  const btn = '<button class="btn btn-ghost btn-jarvis" id="btn-jarvis" title="Activer / désactiver Jarvis (Alt+J) — assistant vocal plein écran"><span class="hex">&#11041;</span>Jarvis</button>';
  const m = html.match(/^([ \t]*)<button[^\n]*id="btn-refresh"[^\n]*\n/m);
  if (m) { html = html.replace(m[0], m[0] + m[1] + btn + "\n"); changed = true; log("+ index.html : bouton Jarvis à côté d'Actualiser"); }
  else if (/<\/header>/.test(html)) { html = html.replace(/<\/header>/, "  " + btn + "\n</header>"); changed = true; log("+ index.html : bouton Jarvis en fin de barre"); }
  else console.warn("! index.html : barre du haut introuvable, ajoute le bouton à la main (voir docs/INSTALL.md)");
} else log("= index.html : bouton déjà présent");
if (!/src="js\/jarvis\.js"/.test(html)) {
  if (/<script src="js\/core\.js"><\/script>/.test(html)) html = html.replace(/<script src="js\/core\.js"><\/script>/, '<script src="js/core.js"></script>\n  <script src="js/jarvis.js"></script>');
  else html = html.replace(/<script>\s*AgentOS\.boot\(\)/, '<script src="js/jarvis.js"></script>\n  <script>AgentOS.boot()');
  changed = true; log("+ index.html : js/jarvis.js");
} else log("= index.html : js/jarvis.js déjà présent");
if (!/Jarvis\.boot\(\)/.test(html)) {
  if (/AgentOS\.boot\(\);/.test(html)) { html = html.replace(/AgentOS\.boot\(\);/, "AgentOS.boot(); Jarvis.boot();"); changed = true; log("+ index.html : Jarvis.boot()"); }
  else console.warn("! index.html : AgentOS.boot() introuvable, ajoute `Jarvis.boot();` après le démarrage (voir docs/INSTALL.md)");
} else log("= index.html : Jarvis.boot() déjà présent");
if (changed) write(htmlFile, html);

// ───────────────────────────── 4. core.js (signaux utilisés par Jarvis)
const core = read(path.join(T, "public", "js", "core.js"));
if (!/agentos:navigated/.test(core)) console.warn("! core.js : l'événement `agentos:navigated` manque — Jarvis ne saura pas quand une page est affichée (voir docs/INSTALL.md).");
if (!/embed/.test(core)) console.warn("! core.js : le mode `?embed=1` manque — les fenêtres de pages embarquées de l'appel seront moins propres (voir docs/INSTALL.md).");

// ───────────────────────────── 5. rappel configuration
console.log(`
✓ Jarvis installé dans ${T}
  Reste à faire :
  - clé OpenAI : dans le coffre Agentic OS (Paramètres → Connexions, champ OpenAI) ou dans le .env du projet (OpenAI=sk-…)
  - redémarrer le serveur (npm start) puis ouvrir http://localhost:4200 → bouton « Jarvis » ou Alt+J
  - optionnel : contrôle du PC Windows → Python 3 + \`pip install pillow\` (scripts/jarvis-desktop.py)
  - optionnel : Telegram (coffre : telegram_token + telegram_chat_id) pour l'envoi et la boîte de réception
`);
