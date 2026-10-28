/**
 * JARVIS — assistant vocal temps réel de la plateforme (OpenAI Realtime, WebRTC).
 *
 * Le navigateur parle DIRECTEMENT à OpenAI (clé éphémère créée ici, jamais la clé maître) ;
 * ce module fournit :
 *  - createSession()  : clé éphémère + configuration complète (persona, outils, voix) ;
 *  - runTool()        : exécution des outils côté serveur (web, Claude, Hermès, API Agent OS,
 *                       second cerveau, images, Telegram, contrôle de l'ordinateur) ;
 *  - jobs asynchrones (Claude, images) poussés au navigateur par SSE (/api/jarvis/events) ;
 *  - mémoire persistante (faits), programme du jour, journal des conversations.
 *
 * Clé OpenAI : coffre (`openai`) ou ../.env (`OpenAI=` / `OPENAI_API_KEY=`).
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { spawn } = require("child_process");
const vault = require("./vault");
const claude = require("./claude");
const hermes = require("./hermes");
const telegram = require("./telegram");
const tasks = require("./tasks");
const studio = require("./studio");
const { readJSON, writeJSON } = require("./store");

const PORT = 4200;
const PROJECT_ROOT = path.join(__dirname, "..", "..");
const VAULT_DIR = "D:\\Test formation";
const GRAPH_FILE = path.join(VAULT_DIR, "graphify-out", "graph.json");
const OUTPUT_DIR = path.join(__dirname, "..", "output", "jarvis");
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Modèles (surcharge possible via data/jarvis-config.json)
const DEFAULTS = {
  realtimeModel: "gpt-realtime-2.1",
  textModel: "gpt-5.4-mini", // recherche web + vision (Responses API)
  transcribeModel: "gpt-4o-mini-transcribe",
  voice: "cedar", // la plus naturelle des voix Realtime (avec marin) : posée, propre, sans emphase
  speed: 1.0,
  eagerness: "high", // réactif : répond dès la fin de la phrase
  style: "direct", // direct | normal | detaille
  address: "vous", // vous | tu
  persona: "", // instructions personnalisées d'Alex
  transport: "auto", // auto | webrtc | websocket — auto : WebRTC, bascule WebSocket si le réseau coupe
};
// Cedar et Marin sont les deux voix de nouvelle génération de l'API Realtime (les plus naturelles) ;
// les autres sont les voix historiques, plus marquées (coral/ballad chantantes, ash très grave).
const VOICES = ["cedar", "marin", "ash", "echo", "verse", "sage", "alloy", "shimmer", "coral", "ballad"];
const VOICE_LABELS = {
  cedar: "Cedar — masculine, naturelle et posée (recommandée)", marin: "Marin — féminine, claire et professionnelle (recommandée)",
  ash: "Ash — masculine très grave", echo: "Echo — masculine claire", verse: "Verse — masculine vive", sage: "Sage — féminine calme",
  alloy: "Alloy — neutre", shimmer: "Shimmer — féminine lumineuse", coral: "Coral — féminine chantante", ballad: "Ballad — douce, lente",
};
// Façon de parler imposée au modèle (et au TTS d'aperçu) : c'est ce qui enlève le côté « débile » d'une voix
const VOICE_STYLE =
  "Voix posée, grave et articulée, rythme régulier et assuré, intonation naturelle du français parlé (pas d'accent anglais sur les noms français). Ton d'un assistant brillant et calme : jamais d'enthousiasme forcé, jamais de ton publicitaire, pas de rires, pas de « hmm », pas d'hésitations jouées. Phrases nettes, fin de phrase descendante.";
const MODELS = ["gpt-realtime-2.1", "gpt-realtime-2.1-mini", "gpt-realtime"];
const STYLES = { direct: "Direct", normal: "Normal", detaille: "Détaillé" };

function config() {
  return { ...DEFAULTS, ...readJSON("jarvis-config.json", {}) };
}
function patchConfig(patch) {
  const cur = readJSON("jarvis-config.json", {});
  for (const k of ["realtimeModel", "textModel", "transcribeModel", "voice", "speed", "eagerness", "style", "address", "transport"]) {
    if (patch[k] !== undefined && patch[k] !== "") cur[k] = patch[k];
  }
  if (patch.persona !== undefined) cur.persona = String(patch.persona).slice(0, 4000);
  writeJSON("jarvis-config.json", cur);
  return config();
}
/** Configuration complète + listes de choix (pour les panneaux de réglages). */
function fullConfig() {
  return { ...config(), voices: VOICES, voiceLabels: VOICE_LABELS, models: MODELS, styles: STYLES };
}

/** Extrait audio (mp3) d'une voix pour l'essayer depuis les réglages — TTS gpt-4o-mini-tts, mêmes voix que Realtime. */
async function voicePreview(voice, text) {
  const k = openaiKey();
  if (!k) throw new Error("Clé OpenAI absente (coffre « OpenAI » ou .env)");
  const v = VOICES.includes(voice) ? voice : config().voice;
  const resp = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${k}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts", voice: v, response_format: "mp3", speed: Math.max(0.8, Math.min(1.4, Number(config().speed) || 1)),
      input: String(text || "").trim().slice(0, 300) || "Bonjour Alex. Je vous écoute. La machine POV a terminé son run de ce matin : quatorze minutes, trois dollars soixante-treize. Voulez-vous que je la publie ?",
      instructions: VOICE_STYLE,
    }),
  });
  if (!resp.ok) throw new Error(`OpenAI TTS ${resp.status} : ${(await resp.text()).slice(0, 200)}`);
  return Buffer.from(await resp.arrayBuffer());
}

// ---------- Clé OpenAI ----------
function openaiKey() {
  const k = vault.get("openai");
  if (k) return k;
  try {
    const txt = fs.readFileSync(path.join(PROJECT_ROOT, ".env"), "utf8");
    const m = /^(?:OpenAI|OPENAI_API_KEY|OPENAI)\s*=\s*(.+)$/m.exec(txt);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  } catch {}
  return null;
}
function configured() {
  return !!openaiKey();
}

/** POST JSON vers l'API OpenAI (node:https, délai d'inactivité maîtrisé). */
function openaiPost(apiPath, payload, { timeoutMs = 120000, key } = {}) {
  return new Promise((resolve, reject) => {
    const k = key || openaiKey();
    if (!k) return reject(new Error("Clé OpenAI absente (coffre « OpenAI » ou .env)"));
    const body = Buffer.from(JSON.stringify(payload));
    const req = https.request(
      {
        hostname: "api.openai.com",
        path: apiPath,
        method: "POST",
        headers: { Authorization: `Bearer ${k}`, "Content-Type": "application/json", "Content-Length": body.length },
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch {
            return reject(new Error(`OpenAI : réponse illisible (HTTP ${res.statusCode}) ${text.slice(0, 200)}`));
          }
          if (res.statusCode >= 400 || parsed.error) {
            return reject(new Error(`OpenAI ${res.statusCode} : ${(parsed.error && parsed.error.message) || text.slice(0, 200)}`));
          }
          resolve(parsed);
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("OpenAI : délai dépassé")));
    req.on("error", reject);
    req.end(body);
  });
}

// ---------- SSE : push vers le(s) navigateur(s) ----------
const sseClients = new Set();
function sseHandler(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  // `recent` : jobs terminés dans les 3 dernières minutes — rattrapage après une reconnexion du navigateur
  const recent = Object.values(jobs).filter((j) => j.status !== "running" && j.endedAt && Date.now() - j.endedAt < 180000).map((j) => ({ id: j.id, label: j.label, result: j.result, error: j.error }));
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, pendingJobs: Object.values(jobs).filter((j) => j.status === "running").length, recent })}\n\n`);
  sseClients.add(res);
  const hb = setInterval(() => {
    try { res.write(": hb\n\n"); } catch {}
  }, 25000);
  req.on("close", () => {
    clearInterval(hb);
    sseClients.delete(res);
  });
}
function push(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) {
    try { c.write(payload); } catch {}
  }
}

// ---------- Jobs asynchrones ----------
const jobs = {};
function startJob(label, fn) {
  const id = "j" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  jobs[id] = { id, label, status: "running", startedAt: Date.now(), result: null, error: null };
  push("job_started", { id, label });
  Promise.resolve()
    .then(fn)
    .then((result) => {
      Object.assign(jobs[id], { status: "done", result, endedAt: Date.now() });
      push("job_done", { id, label, result });
    })
    .catch((e) => {
      Object.assign(jobs[id], { status: "error", error: e.message, endedAt: Date.now() });
      push("job_done", { id, label, error: e.message });
    });
  for (const k of Object.keys(jobs)) if (Date.now() - jobs[k].startedAt > 6 * 3600e3) delete jobs[k];
  return jobs[id];
}
function jobStatus(id) {
  return jobs[id] || null;
}

// ---------- Mémoire, programme du jour, journal ----------
function memory() {
  return readJSON("jarvis-memory.json", []);
}
function remember(fact) {
  const list = memory();
  list.push({ fact: String(fact).trim(), ts: new Date().toISOString() });
  writeJSON("jarvis-memory.json", list.slice(-200));
  return list.length;
}
function forget(match) {
  const before = memory();
  const after = before.filter((m) => !m.fact.toLowerCase().includes(String(match).toLowerCase()));
  writeJSON("jarvis-memory.json", after);
  return before.length - after.length;
}

function todayISO() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}
function program(date) {
  const all = readJSON("jarvis-program.json", {});
  return { date: date || todayISO(), items: all[date || todayISO()] || [] };
}
function setProgram(date, items, { append = false } = {}) {
  const all = readJSON("jarvis-program.json", {});
  const d = date || todayISO();
  const norm = (items || []).map((it, i) => ({
    priority: String(it.priority || "P2").toUpperCase(),
    text: String(it.text || it).trim(),
    done: !!it.done,
    id: it.id || "p" + Date.now().toString(36) + i,
  }));
  all[d] = append ? [...(all[d] || []), ...norm] : norm;
  writeJSON("jarvis-program.json", all);
  return { date: d, items: all[d] };
}
function toggleProgramItem(date, match, done) {
  const all = readJSON("jarvis-program.json", {});
  const d = date || todayISO();
  const list = all[d] || [];
  const it = list.find((x) => x.id === match || x.text.toLowerCase().includes(String(match).toLowerCase()));
  if (!it) throw new Error("Élément du programme introuvable : " + match);
  it.done = done !== false;
  writeJSON("jarvis-program.json", all);
  return { date: d, items: list };
}

function log(role, text) {
  const list = readJSON("jarvis-log.json", []);
  list.push({ role, text: String(text).slice(0, 2000), ts: new Date().toISOString() });
  writeJSON("jarvis-log.json", list.slice(-600));
}
function recentLog(n = 16) {
  return readJSON("jarvis-log.json", []).slice(-n);
}

// ---------- Appels internes à l'API Agent OS ----------
function localApi(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: PORT,
        path: apiPath,
        method,
        headers: data ? { "Content-Type": "application/json", "Content-Length": data.length } : {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          const txt = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ status: res.statusCode, data: JSON.parse(txt) });
          } catch {
            resolve({ status: res.statusCode, data: txt.slice(0, 4000) });
          }
        });
      }
    );
    req.setTimeout(120000, () => req.destroy(new Error("API locale : délai dépassé")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

/** Tronque une valeur JSON pour ne pas noyer le modèle vocal. */
function compact(value, max = 7000) {
  let s = typeof value === "string" ? value : JSON.stringify(value);
  if (s.length > max) s = s.slice(0, max) + `… [tronqué, ${s.length} caractères au total]`;
  return s;
}

/**
 * Allège une réponse d'API pour le modèle vocal : décimales arrondies (un « 12.819499999 » est lu
 * « 12 819 ») et longues listes écourtées, en gardant un JSON valide plutôt qu'un texte coupé.
 */
function slim(value, maxItems) {
  if (typeof value === "number") {
    if (Number.isInteger(value)) return value;
    return Math.abs(value) >= 1 ? Math.round(value * 100) / 100 : Number(value.toPrecision(3));
  }
  if (Array.isArray(value)) {
    const out = value.slice(0, maxItems).map((v) => slim(v, maxItems));
    if (value.length > maxItems) out.push(`… ${value.length - maxItems} autres éléments non affichés (${value.length} au total)`);
    return out;
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = slim(v, maxItems);
    return out;
  }
  return typeof value === "string" && value.length > 1200 ? value.slice(0, 1200) + "…" : value;
}

function slimToFit(value, max = 7000) {
  for (const n of [40, 20, 10, 5, 3]) {
    const v = slim(value, n);
    if (JSON.stringify(v).length <= max) return v;
  }
  return { truncated: compact(slim(value, 3), max) };
}

// ---------- Veille concurrents (banque de niches + Scrap-o-matic) ----------
/** Niche visée par `machine` (celle reliée à la machine) ou `niche` (nom ou id). nicheId null si rien n'est précisé. */
function resolveNiche(args) {
  const niches = require("./bank").niches();
  if (args.machine) {
    const { id, lib: m } = machineOf(args.machine);
    const c = m.config();
    const nicheId = c.nicheId || ((c.styles || []).find((x) => x.nicheId) || {}).nicheId || null;
    if (!nicheId) throw new Error(`La machine ${id} n'est reliée à aucune niche de la banque. Niches existantes : ${niches.map((n) => n.name).join(", ")}`);
    return { nicheId, machineId: id, niches };
  }
  if (args.niche) {
    const q = String(args.niche).toLowerCase();
    const hit = niches.find((n) => n.id === args.niche) || niches.find((n) => n.name.toLowerCase() === q) || niches.find((n) => n.name.toLowerCase().includes(q));
    if (!hit) throw new Error(`Niche « ${args.niche} » introuvable. Niches : ${niches.map((n) => n.name).join(", ")}`);
    return { nicheId: hit.id, machineId: null, niches };
  }
  return { nicheId: null, machineId: null, niches };
}

const STALE_MS = 24 * 3600e3; // au-delà, la fiche d'une chaîne est rafraîchie avant le compte-rendu
const veilleRunning = new Set(); // niches dont la mise à jour tourne
let quietScrapes = 0; // scrapings lancés par un lot Jarvis : un seul compte-rendu, pas un événement par chaîne

/** Dernières vidéos de chaque chaîne concurrente d'une niche, d'après les fiches du Scrap-o-matic. */
function competitorReport(nicheId, machineId, perChannel = 3) {
  const scrap = require("./scrap");
  const n = require("./bank").niches().find((x) => x.id === nicheId);
  if (!n) throw new Error("Niche introuvable");
  const w = scrap.watchlist();
  const day = (v) => String(v.date || v.publishedAt || "").slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86400e3).toISOString().slice(0, 10);
  const all = [];
  const channels = n.channels.map((cid) => {
    const c = w.channels.find((x) => x.channelId === cid);
    const r = scrap.channelResult(cid);
    const title = (c && c.title) || (r && r.title) || cid;
    const vids = (r ? r.videos : [])
      .map((v) => ({ channel: title, title: String(v.title || "").trim().slice(0, 90), date: day(v), views: Number(v.viewCount ?? v.views ?? 0) }))
      .filter((v) => v.date)
      .sort((a, b) => b.date.localeCompare(a.date));
    all.push(...vids);
    return { channelId: cid, channel: title, subscribers: (c && c.subscribers) || 0, checkedAt: (r && r.scrapedAt) || null, latest: vids.slice(0, perChannel).map(({ title: t, date, views }) => ({ title: t, date, views })) };
  });
  all.sort((a, b) => b.date.localeCompare(a.date));
  const week = all.filter((v) => v.date >= weekAgo);
  const best = week.slice().sort((a, b) => b.views - a.views)[0];
  return {
    kind: "competitors", machine: machineId || undefined, nicheId, niche: n.name,
    summary: `${channels.length} chaînes concurrentes ; ${week.length} vidéos publiées ces 7 derniers jours${best ? ` ; la plus vue de la semaine : « ${best.title} » (${best.channel}, ${best.views} vues)` : ""}${all[0] ? ` ; la plus récente : « ${all[0].title} » (${all[0].channel}, ${all[0].date})` : ""}.`,
    newest: all.slice(0, 14),
    channels,
  };
}

/** Rescrape les dernières vidéos des chaînes données (3 de front, une relance par chaîne) puis renvoie le rapport à jour. */
async function refreshCompetitors(nicheId, machineId, targets, perChannel) {
  const scrap = require("./scrap");
  const queue = targets.slice();
  const failed = [];
  let ok = 0, added = 0, cost = 0;
  quietScrapes++;
  veilleRunning.add(nicheId);
  try {
    await Promise.all([0, 1, 2].map(async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const r = await scrap.scrapeChannel(c.channelId, { maxResults: Math.max(5, perChannel), quiet: true });
            ok++; added += r.added || 0; cost += r.cost || 0;
            break;
          } catch (e) {
            if (attempt === 2) failed.push(`${c.channel} (${e.message.slice(0, 80)})`);
            else await new Promise((res) => setTimeout(res, 3000));
          }
        }
      }
    }));
  } finally {
    veilleRunning.delete(nicheId);
    setTimeout(() => { quietScrapes--; }, 5000);
  }
  return { ...competitorReport(nicheId, machineId, perChannel), refreshed: ok, newVideos: added, failed: failed.length ? failed : undefined, costUsd: Math.round(cost * 1000) / 1000 };
}

// Suivi : pendant un appel, tout changement d'état d'une tâche de la plateforme (run terminé, en attente
// de validation, publié, en échec) est poussé au navigateur, qui le fait annoncer par Jarvis.
tasks.onEvent((event, p) => {
  if (!sseClients.size || !p) return;
  if (!["video_done", "video_published", "render_failed", "needs_validation"].includes(event)) return;
  if (p.kind === "scrap" && quietScrapes > 0) return;
  if (event === "render_failed" && /Annulée par l'utilisateur/.test(p.detail || "")) return; // Alex vient de l'annuler lui-même
  // Hors runs de machine : si un job Jarvis tourne (ou vient de finir), son propre résultat fait déjà l'annonce
  const jobActive = Object.values(jobs).some((j) => j.status === "running" || (j.endedAt && Date.now() - j.endedAt < 8000));
  if (!p.runId && jobActive) return;
  push("task_event", { event, title: p.title, machine: p.machine || null, machineId: p.machineId || null, runId: p.runId || null, kind: p.kind || null, detail: String(p.detail || "").slice(0, 200) });
});

// ---------- Contrôle de l'ordinateur ----------
// Deux moteurs, par nécessité :
//  - PowerShell : frappe clavier (SendKeys .NET), ouverture d'apps, commandes libres.
//  - Python/ctypes (scripts/jarvis-desktop.py) : capture d'écran, souris, fenêtres. Defender (AMSI)
//    bloque les scripts PowerShell qui déclarent plusieurs P/Invoke user32 (« contenu malveillant »),
//    et PIL donne une capture DPI-aware : clics et image dans le même repère (pixels physiques).
const DESKTOP_PY = path.join(__dirname, "..", "scripts", "jarvis-desktop.py");

function py(args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("python", [DESKTOP_PY, ...args.map(String)], { windowsHide: true, cwd: PROJECT_ROOT });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error("Script bureau : délai dépassé"));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", () => {
      clearTimeout(timer);
      const line = out.trim().split(/\r?\n/).pop();
      let parsed;
      try { parsed = JSON.parse(line); } catch { return reject(new Error("Script bureau : " + (err.trim().split(/\r?\n/).pop() || out.trim() || "réponse vide").slice(0, 300))); }
      if (parsed.error) return reject(new Error(parsed.error));
      resolve(parsed);
    });
  });
}

/** Nettoie le stderr CLIXML de PowerShell (-NonInteractive) pour ne garder que les vraies erreurs. */
function psErrors(stderr) {
  const s = String(stderr || "");
  if (!s.startsWith("#< CLIXML")) return s.trim();
  const errs = [...s.matchAll(/<S S="Error">([^<]*)<\/S>/g)].map((m) => m[1].replace(/_x000D__x000A_/g, "\n").trim()).filter(Boolean);
  return errs.join("\n").trim();
}

function ps(script, { timeoutMs = 60000, forms = false } = {}) {
  return new Promise((resolve, reject) => {
    // Sortie en UTF-8 (sinon les accents arrivent cassés) ; System.Windows.Forms seulement si demandé (SendKeys)
    const full = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n" + (forms ? "Add-Type -AssemblyName System.Windows.Forms\n" : "") + "$ErrorActionPreference='Continue'\n" + script;
    const encoded = Buffer.from(full, "utf16le").toString("base64");
    const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
      windowsHide: true,
      cwd: PROJECT_ROOT,
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try { spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" }); } catch {}
      reject(new Error(`PowerShell : délai dépassé (${Math.round(timeoutMs / 1000)} s)`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: out.trim(), stderr: psErrors(err) });
    });
    child.stdin.end();
  });
}

/** Chaîne PowerShell entre guillemets simples (sûre). */
const q = (s) => "'" + String(s ?? "").replace(/'/g, "''") + "'";

async function screenshot({ screen = "primary", maxWidth = 1600 } = {}) {
  const file = path.join(OUTPUT_DIR, `shot-${Date.now()}.jpg`);
  const r = await py(["shot", file, screen === "all" ? "all" : "primary", maxWidth], { timeoutMs: 30000 });
  if (!fs.existsSync(file)) throw new Error("Capture d'écran impossible");
  // Purge : on ne garde que les 40 dernières captures
  try {
    const old = fs.readdirSync(OUTPUT_DIR).filter((f) => f.startsWith("shot-")).sort();
    for (const f of old.slice(0, -40)) fs.unlinkSync(path.join(OUTPUT_DIR, f));
  } catch {}
  return { file, rel: "agent-os/output/jarvis/" + path.basename(file), realSize: r.realSize, savedSize: r.savedSize, scale: r.scale };
}

/** Analyse d'image par le modèle texte (Responses API, image en data URL). */
async function describeImage(file, question) {
  const b64 = fs.readFileSync(file).toString("base64");
  const resp = await openaiPost("/v1/responses", {
    model: config().textModel,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: question || "Décris précisément ce que montre cet écran (fenêtres, application au premier plan, textes importants, boutons visibles). Réponds en français, de façon structurée et concise." },
          { type: "input_image", image_url: `data:image/jpeg;base64,${b64}`, detail: "high" },
        ],
      },
    ],
  }, { timeoutMs: 120000 });
  return extractText(resp);
}

function extractText(resp) {
  if (resp.output_text) return resp.output_text;
  const parts = [];
  for (const item of resp.output || []) {
    if (item.type !== "message") continue;
    for (const c of item.content || []) if (c.type === "output_text") parts.push(c.text);
  }
  return parts.join("\n").trim();
}
function extractCitations(resp) {
  const out = [];
  const seen = new Set();
  for (const item of resp.output || []) {
    if (item.type !== "message") continue;
    for (const c of item.content || []) {
      for (const a of c.annotations || []) {
        if (a.type === "url_citation" && a.url && !seen.has(a.url)) {
          seen.add(a.url);
          out.push({ title: a.title || a.url, url: a.url });
        }
      }
    }
  }
  return out.slice(0, 8);
}

// ---------- Recherche web ----------
async function webSearch(query, { depth = "medium" } = {}) {
  const resp = await openaiPost("/v1/responses", {
    model: config().textModel,
    tools: [{ type: "web_search", search_context_size: depth, user_location: { type: "approximate", country: "FR", timezone: "Europe/Paris" } }],
    instructions:
      "Tu es le moteur de recherche d'un assistant vocal français. Cherche sur le web et réponds en français, factuel et dense : 3 à 8 phrases maximum, avec les chiffres et dates clés. Pas de préambule, pas de liste de liens dans le texte (les sources sont extraites à part). Date du jour : " +
      new Date().toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" }) + ".",
    input: query,
  }, { timeoutMs: 120000 });
  return { answer: extractText(resp), sources: extractCitations(resp) };
}

// ---------- Second cerveau (coffre Obsidian + graphe) ----------
function walkMd(dir, out, depth = 6) {
  if (depth < 0) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "graphify-out" || e.name === "graphify" || e.name === "node_modules") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkMd(full, out, depth - 1);
    else if (e.name.toLowerCase().endsWith(".md")) out.push(full);
  }
}
function brainSearch(query, limit = 8) {
  const terms = String(query).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 2);
  if (!terms.length) throw new Error("Requête trop courte");
  const files = [];
  walkMd(VAULT_DIR, files);
  const hits = [];
  for (const f of files) {
    let txt;
    try { txt = fs.readFileSync(f, "utf8"); } catch { continue; }
    const low = txt.toLowerCase();
    const name = path.basename(f, ".md").toLowerCase();
    let score = 0;
    for (const t of terms) {
      const inName = name.includes(t) ? 5 : 0;
      const n = low.split(t).length - 1;
      score += inName + Math.min(n, 12);
    }
    if (!score) continue;
    const idx = low.indexOf(terms[0]);
    const body = txt.replace(/^---[\s\S]*?---\s*/, "");
    const snippet = (idx >= 0 ? txt.slice(Math.max(0, idx - 120), idx + 220) : body.slice(0, 300)).replace(/\s+/g, " ").trim();
    hits.push({ score, path: path.relative(VAULT_DIR, f).replace(/\\/g, "/"), title: path.basename(f, ".md"), snippet, modified: fs.statSync(f).mtime.toISOString().slice(0, 10) });
  }
  hits.sort((a, b) => b.score - a.score);
  return { total: hits.length, hits: hits.slice(0, limit) };
}
function brainRead(rel, maxChars = 6000) {
  const full = path.normalize(path.join(VAULT_DIR, rel.endsWith(".md") ? rel : rel + ".md"));
  if (!full.startsWith(path.normalize(VAULT_DIR))) throw new Error("Chemin hors du coffre");
  if (!fs.existsSync(full)) {
    // Recherche par titre (wikilink)
    const files = [];
    walkMd(VAULT_DIR, files);
    const want = path.basename(rel, ".md").toLowerCase();
    const found = files.find((f) => path.basename(f, ".md").toLowerCase() === want);
    if (!found) throw new Error("Note introuvable : " + rel);
    return { path: path.relative(VAULT_DIR, found).replace(/\\/g, "/"), content: compact(fs.readFileSync(found, "utf8"), maxChars) };
  }
  return { path: rel, content: compact(fs.readFileSync(full, "utf8"), maxChars) };
}
function brainWrite({ path: rel, title, content, tags = [], folder = "inbox", append = false }) {
  const name = (title || path.basename(rel || "note", ".md")).replace(/[\\/:*?"<>|]/g, "-").trim();
  const relPath = rel ? (rel.endsWith(".md") ? rel : rel + ".md") : `${folder}/${name}.md`;
  const full = path.normalize(path.join(VAULT_DIR, relPath));
  if (!full.startsWith(path.normalize(VAULT_DIR))) throw new Error("Chemin hors du coffre");
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const today = todayISO();
  if (append && fs.existsSync(full)) {
    fs.appendFileSync(full, "\n\n" + content.trim() + "\n");
    return { path: relPath, appended: true };
  }
  const fm = [
    "---",
    `title: ${name}`,
    `tags: [${["jarvis", ...tags].map((t) => String(t).replace(/[^\w-]/g, "")).filter(Boolean).join(", ")}]`,
    `created: ${today}`,
    `updated: ${today}`,
    "status: active",
    `type: ${folder === "permanent" ? "permanent" : "fleeting"}`,
    "source: Jarvis",
    "---",
    "",
  ].join("\n");
  const body = content.includes("[[") ? content.trim() : content.trim() + "\n\nLiens : [[Formation automatisation & contenu IA]] · [[Vue d'ensemble du projet]]\n";
  fs.writeFileSync(full, fm + body + "\n");
  return { path: relPath, created: true };
}
function brainGraph(query, limit = 12) {
  let g;
  try { g = JSON.parse(fs.readFileSync(GRAPH_FILE, "utf8")); } catch { throw new Error("Graphe introuvable : " + GRAPH_FILE); }
  const terms = String(query).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 2);
  const nodes = g.nodes || [];
  const links = g.links || g.edges || [];
  const scored = nodes
    .map((n) => {
      const hay = `${n.label || ""} ${n.id || ""} ${n.community_name || ""} ${n.description || ""}`.toLowerCase();
      const score = terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0);
      return { n, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  return {
    totalNodes: nodes.length,
    totalLinks: links.length,
    matches: scored.map(({ n }) => {
      const neigh = links
        .filter((l) => l.source === n.id || l.target === n.id)
        .slice(0, 8)
        .map((l) => {
          const other = byId[l.source === n.id ? l.target : l.source];
          return `${l.relation || "lié à"} → ${other ? other.label : l.target}`;
        });
      return { id: n.id, label: n.label, community: n.community_name, file: n.source_file, links: neigh };
    }),
  };
}

// ---------- Claude Code & Hermès (délégation) ----------
function jarvisChatId() {
  const st = readJSON("jarvis-state.json", {});
  if (st.claudeChatId && claude.getChat(st.claudeChatId)) return st.claudeChatId;
  const chat = claude.createChat("jarvis", "Jarvis → Claude Code");
  st.claudeChatId = chat.id;
  writeJSON("jarvis-state.json", st);
  return chat.id;
}
async function askClaude(task, { fresh = false } = {}) {
  if (fresh) {
    const st = readJSON("jarvis-state.json", {});
    delete st.claudeChatId;
    writeJSON("jarvis-state.json", st);
  }
  const prefix =
    "[DEMANDE TRANSMISE PAR JARVIS — assistant vocal de la plateforme]\n" +
    "Exécute la tâche ci-dessous de bout en bout (lecture/écriture de fichiers, commandes, APIs locales : tout est autorisé). " +
    "Ta réponse sera LUE À VOIX HAUTE et affichée dans une petite fenêtre : conclusion d'abord, 3 à 8 lignes, pas de blocs de code sauf nécessité, pas de markdown lourd.\n\n";
  const { reply } = await claude.sendMessage(jarvisChatId(), prefix + task);
  return reply;
}
function hermesChatId() {
  const st = readJSON("jarvis-state.json", {});
  if (st.hermesChatId && hermes.getChat(st.hermesChatId)) return st.hermesChatId;
  const chat = hermes.createChat("Jarvis → Hermès");
  st.hermesChatId = chat.id;
  writeJSON("jarvis-state.json", st);
  return chat.id;
}

// ---------- Génération d'image (Kie via Miniature Creator) ----------
async function generateImage({ prompt, tool = "nano", aspect = "16:9", sources }) {
  const payload = { tool, mode: sources && sources.length ? "i2i" : "t2i", prompt, aspect, count: 1 };
  if (sources && sources.length) payload.sources = sources.map((s) => (typeof s === "string" ? { rel: s } : s));
  // studio.generate renvoie la liste des jobs créés ({id, status, resultRel, error}) suivis dans /api/studio/jobs
  const created = await studio.generate(payload);
  const jobId = created[0] && created[0].id;
  if (!jobId) throw new Error("Le Miniature Creator n'a pas créé de job");
  const deadline = Date.now() + 6 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const j = studio.publicJobs().find((x) => x.id === jobId);
    if (!j) throw new Error("Job image introuvable");
    if (j.status === "failed") throw new Error(j.error || "Génération échouée");
    if (j.status === "done") return { image: "/media/" + j.resultRel, file: j.resultRel, rel: j.resultRel, tool: j.toolName, prompt: j.prompt };
  }
  throw new Error("Génération d'image : délai dépassé");
}

// ---------- Outils ----------
// `client: true` => exécuté dans le navigateur (fenêtres, navigation). Les autres ici.
const TOOLS = [
  // --- Interface Jarvis (navigateur) ---
  {
    type: "function",
    client: true,
    name: "show_window",
    description:
      "Ouvre (ou met à jour, si `id` existe déjà) une petite fenêtre déplaçable à l'écran pour MONTRER quelque chose à l'utilisateur : tableau, liste, chiffres clés, texte, image, liens. À utiliser dès que tu présentes des données, un résultat, un programme, une recherche. Les fenêtres restent ouvertes jusqu'à ce qu'on les ferme.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Identifiant court et stable (ex. 'programme', 'recherche-gemini'). Réutiliser le même id met la fenêtre à jour." },
        title: { type: "string", description: "Titre affiché (court)." },
        blocks: {
          type: "array",
          description: "Contenu, dans l'ordre. Chaque bloc a un `kind`.",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["kv", "table", "stats", "list", "text", "image", "video", "audio", "links", "checklist"] },
              rows: { type: "array", description: "kv: [[clé, valeur]] · table: [[cellules…]] · checklist: [[texte, fait(bool)]]", items: { type: "array", items: { type: ["string", "number", "boolean", "null"] } } },
              columns: { type: "array", items: { type: "string" }, description: "table : en-têtes." },
              items: { type: "array", items: { type: "string" }, description: "list : lignes." },
              stats: { type: "array", items: { type: "object", properties: { value: { type: "string" }, label: { type: "string" } } }, description: "stats : gros chiffres." },
              text: { type: "string", description: "text : paragraphe (markdown léger : **gras**, retours à la ligne)." },
              src: { type: "string", description: "image / video / audio : URL (ex. /media/…)." },
              caption: { type: "string" },
              links: { type: "array", items: { type: "object", properties: { title: { type: "string" }, url: { type: "string" } } } },
            },
            required: ["kind"],
          },
        },
        position: { type: "string", enum: ["auto", "top-left", "top-center", "top-right", "left", "right", "bottom-left", "bottom-right", "center"], description: "Emplacement initial (auto par défaut)." },
        width: { type: "number", description: "Largeur en px (240–520, défaut 320). Garde les fenêtres compactes." },
      },
      required: ["title", "blocks"],
    },
  },
  {
    type: "function",
    client: true,
    name: "close_window",
    description: "Ferme une fenêtre affichée (par id) ou toutes les fenêtres (`all`).",
    parameters: { type: "object", properties: { id: { type: "string", description: "id de la fenêtre, ou 'all'." } }, required: ["id"] },
  },
  {
    type: "function",
    client: true,
    name: "open_page",
    description:
      "Ouvre une PAGE ou un OUTIL de la plateforme Agentic OS DANS UNE FENÊTRE EMBARQUÉE de l'appel (déplaçable, redimensionnable, agrandissable) : Alex travaille dedans sans quitter Jarvis. Pages : dashboard (stats YouTube, dépenses, tâches) · tasks (Tâches & Cron) · calendar (calendrier de publication) · architecture · chat (Chat Claude Code) · hermes (Chat Hermès) · brain (Second Cerveau, graphe Rings + curateur) · niche (Niche Finder) · scrap (Scrap-o-matic) · bank (Banque de niches ; query 'niche=<id>') · machines (liste des machines) · timetravel, linguistique, musique, storyfamily, stickman, pov, wealth, datarank (wizard de chaque machine ; query 'run=<id>' ouvre un run précis) · channels (Chaînes YouTube ; query 'open=<channelId>') · miniature (Miniature Creator, images Kie) · kie (Kie Studio : 200+ modèles Kie.ai vidéo/image/musique/voix/chat avec leurs options) · files (Mes fichiers) · tiktok, ttbank, ttfruits (OS TikTok) · connections · settings (Paramètres, coffre).",
    parameters: {
      type: "object",
      properties: {
        page: { type: "string", description: "Identifiant de page (ex. 'pov', 'miniature', 'chat')." },
        query: { type: "string", description: "Paramètres optionnels, ex. 'run=xyz'." },
        title: { type: "string", description: "Titre de la fenêtre (sinon nom de la page)." },
        maximize: { type: "boolean", description: "true = plein cadre dès l'ouverture." },
      },
      required: ["page"],
    },
  },
  {
    type: "function",
    client: true,
    name: "window_control",
    description: "Agit sur une fenêtre de l'appel : minimize (vers le dock), restore, maximize, focus. `id` = id de la fenêtre (pages : 'page-<page>').",
    parameters: { type: "object", properties: { id: { type: "string" }, action: { type: "string", enum: ["minimize", "restore", "maximize", "focus"] } }, required: ["id", "action"] },
  },
  {
    type: "function",
    name: "set_voice",
    description: "Change la voix de Jarvis (appliquée à la PROCHAINE activation — impossible en cours de session). Voix : cedar (masculine naturelle, posée — recommandée), marin (féminine claire, professionnelle — recommandée), ash (très grave), echo, verse, sage, alloy, shimmer, coral, ballad.",
    parameters: { type: "object", properties: { voice: { type: "string", enum: ["cedar", "marin", "ash", "echo", "verse", "sage", "alloy", "shimmer", "coral", "ballad"] } }, required: ["voice"] },
  },

  // --- Connaissance & recherche ---
  {
    type: "function",
    name: "web_search",
    description: "Recherche sur Internet (actualités, faits, prix, documentation…) et renvoie une synthèse en français avec les sources. Utilise-la pour toute question d'actualité ou que tu ne connais pas avec certitude.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" }, depth: { type: "string", enum: ["low", "medium", "high"], description: "Profondeur (défaut medium)." } },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "brain_search",
    description: "Cherche dans le SECOND CERVEAU (coffre Obsidian « Test formation » : notes de projet, décisions, journaux, APIs, workflows n8n). Renvoie les notes les plus pertinentes avec un extrait.",
    parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
  },
  {
    type: "function",
    name: "brain_read",
    description: "Lit une note complète du second cerveau (chemin relatif renvoyé par brain_search, ou simple titre).",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    type: "function",
    name: "brain_write",
    description: "Crée une note dans le second cerveau (dossier inbox par défaut, frontmatter Obsidian automatique), ou ajoute du texte à une note existante (append=true).",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        content: { type: "string", description: "Markdown Obsidian (wikilinks [[…]] bienvenus)." },
        tags: { type: "array", items: { type: "string" } },
        folder: { type: "string", enum: ["inbox", "fleeting", "permanent", "logs"], description: "Dossier (défaut inbox)." },
        path: { type: "string", description: "Chemin exact d'une note existante (pour append)." },
        append: { type: "boolean" },
      },
      required: ["content"],
    },
  },
  {
    type: "function",
    name: "brain_graph",
    description: "Interroge le GRAPHE de connaissances (Graphify) du second cerveau : nœuds correspondant à la requête, leur communauté et leurs connexions.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },

  // --- Agents ---
  {
    type: "function",
    name: "ask_claude",
    description:
      "Délègue une tâche à CLAUDE CODE (agent de développement avec accès complet au projet : lire/modifier du code, lancer des scripts, piloter machines et APIs, écrire dans le second cerveau). Pour tout ce qui dépasse tes outils directs. Par défaut asynchrone : tu reçois un jobId, le résultat te sera transmis automatiquement quand il arrive (dis à l'utilisateur que Claude s'en occupe). Mets wait=true seulement pour une question rapide (< 45 s).",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "Consigne complète et précise, en français." },
        wait: { type: "boolean", description: "Attendre la réponse (questions courtes uniquement)." },
        fresh: { type: "boolean", description: "Repartir d'une conversation vierge (sans mémoire des échanges précédents)." },
      },
      required: ["task"],
    },
  },
  {
    type: "function",
    name: "ask_hermes",
    description: "Délègue une tâche à l'agent HERMÈS (agent local autonome, crons durables, Telegram). Asynchrone : résultat transmis automatiquement.",
    parameters: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
  },
  {
    type: "function",
    name: "job_status",
    description: "État d'un job asynchrone (Claude, Hermès, image) par son id.",
    parameters: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"] },
  },

  // --- Plateforme Agentic OS ---
  {
    type: "function",
    name: "platform_overview",
    description: "Vue d'ensemble instantanée de la plateforme : santé des services, chaînes YouTube connectées, tâches en cours / récentes, machines disponibles, événements récents.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "channel_stats",
    description:
      "RAPPORT / STATS D'UNE CHAÎNE YOUTUBE connectée (ou de toutes) : vues et abonnés nets sur la période (jour par jour, compteurs à jour à la minute), meilleure journée, compteurs actuels (abonnés, vues totales, nombre de vidéos, stock privé / non répertorié), dernière vidéo publiée (date, confidentialité, vues, likes, commentaires), vidéos récentes les plus vues. Le rapport s'affiche tout seul dans une fenêtre : dis les 3 chiffres clés et ce qui ressort. Impressions, CTR et durée de visionnage ne sont PAS disponibles (l'API Google ne les donne pas) : dis-le simplement si Alex les demande.",
    parameters: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Nom (même partiel) ou id de la chaîne ; absent ou 'all' = toutes les chaînes." },
        period: { type: "string", enum: ["7d", "28d", "90d", "all"], description: "Période (défaut 28d)." },
        refresh: { type: "boolean", description: "true = recharger depuis Google (Alex dit « à jour », « actualise ») ; sinon cache." },
      },
    },
  },
  {
    type: "function",
    name: "agentos_api",
    description:
      "Appelle N'IMPORTE QUELLE route de l'API locale Agentic OS (http://localhost:4200). Exemples : GET /api/tasks · GET /api/channels/overview · GET /api/stats/live · GET /api/machines/<id> · GET /api/machines/<id>/runs · POST /api/machines/<id>/runs {theme,…} · POST /api/machines/<id>/idea · GET /api/machines/<id>/stock · GET /api/bank/niches · GET /api/files?type=image · GET /api/spend · GET /api/crons · GET /api/schedule · POST /api/tasks {title,…} · PATCH /api/tasks/<id> {status}. Machines : timetravel, linguistique, musique, storyfamily, stickman, pov, wealth, datarank, ttfruits.",
    parameters: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["GET", "POST", "PATCH", "DELETE"] },
        path: { type: "string", description: "Chemin commençant par /api/…" },
        body: { type: "object", description: "Corps JSON (POST/PATCH)." },
      },
      required: ["method", "path"],
    },
  },
  {
    type: "function",
    name: "generate_image",
    description: "Génère une image (Kie.ai, Miniature Creator). Asynchrone (1 à 3 min) : jobId renvoyé, résultat transmis automatiquement avec l'URL à afficher via show_window (bloc image).",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Prompt détaillé en anglais." },
        tool: { type: "string", enum: ["nano", "gpt", "seedream", "grok2", "grok"], description: "Modèle (défaut nano = rapide/éco)." },
        aspect: { type: "string", description: "16:9, 9:16, 1:1… (défaut 16:9)" },
      },
      required: ["prompt"],
    },
  },
  // --- Lire et manipuler les fenêtres ouvertes (navigateur) ---
  {
    type: "function",
    client: true,
    name: "page_read",
    description:
      "LIT une fenêtre ouverte dans l'appel (page de la plateforme ou fenêtre de contenu) : son texte visible et la liste numérotée de ses éléments manipulables (boutons, onglets, liens, lignes cliquables, champs avec leur valeur, listes déroulantes avec leurs options). C'est ta façon de VOIR ce qu'Alex voit : appelle-la quand il dit « ici », « cette page », « ce bouton », « qu'est-ce qui est affiché ». Sans `id` : la fenêtre au premier plan.",
    parameters: { type: "object", properties: { id: { type: "string", description: "id de fenêtre (ex. 'page-pov'). Optionnel." } } },
  },
  {
    type: "function",
    client: true,
    name: "page_act",
    description:
      "AGIT dans une fenêtre ouverte comme le ferait Alex : click (bouton, onglet, ligne, lien, carte), fill (écrire dans un champ), select (choisir une option d'une liste), check (cocher/décocher). `target` = numéro d'élément renvoyé par page_read, ou son texte/libellé visible. Renvoie le nouvel état de la page. Sert pour TOUT ce qui n'a pas d'outil dédié : n'importe quel bouton, champ ou onglet de n'importe quelle page.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "id de fenêtre. Optionnel (fenêtre au premier plan)." },
        action: { type: "string", enum: ["click", "fill", "select", "check"] },
        target: { type: "string", description: "Numéro de l'élément (page_read) ou texte/libellé visible." },
        value: { type: "string", description: "fill : texte à écrire · select : option · check : 'true'/'false'." },
      },
      required: ["action", "target"],
    },
  },

  // --- Banque de niches & API complète ---
  {
    type: "function",
    name: "niche_bank",
    description:
      "BANQUE DE NICHES (niches DÉJÀ enregistrées) : les chaînes CONCURRENTES et leurs meilleures vidéos. Ce n'est PAS le Niche Finder (chercher de NOUVELLES niches ou vidéos sur YouTube : agentos_api POST /api/niche/search). Avec `machine` → la niche liée à cette machine (ex. 'pov') ; avec `niche` → par nom ou id ; sans rien → liste des niches. Renvoie chaînes (abonnés, vidéos scrappées), tags dominants, top vidéos (titre, vues). La fenêtre Banque s'ouvre automatiquement sur la niche.",
    parameters: {
      type: "object",
      properties: {
        machine: { type: "string", description: "timetravel, linguistique, musique, storyfamily, stickman, pov, wealth, datarank" },
        niche: { type: "string", description: "Nom ou id de niche." },
        channel: { type: "string", description: "Nom d'une chaîne de la niche pour le détail de ses vidéos (optionnel)." },
      },
    },
  },
  {
    type: "function",
    name: "competitor_videos",
    description:
      "VEILLE CONCURRENTS : les DERNIÈRES vidéos (par date de publication) de chaque chaîne concurrente d'une machine ou d'une niche — « dernières vidéos de mes concurrents », « quoi de neuf dans la niche », « compte-rendu des concurrents ». Sans `machine` ni `niche` : la machine de la fenêtre au premier plan. Les fiches de plus de 24 h sont rescrappées toutes seules (≈ 0,03 $ par chaîne, 1 à 2 min) : tu reçois tout de suite ce qui est en banque (annonce-le en disant que la mise à jour tourne), puis le rapport à jour t'arrive automatiquement en [RÉSULTAT JOB] et tu l'annonces sans qu'Alex te relance. `refresh: true` force la mise à jour de toutes les chaînes, `refresh: false` l'interdit. Le tableau s'affiche tout seul dans une fenêtre. N'utilise JAMAIS agentos_api /api/scrap/… pour cette demande.",
    parameters: {
      type: "object",
      properties: {
        machine: { type: "string", description: "timetravel, linguistique, musique, storyfamily, stickman, pov, wealth, datarank" },
        niche: { type: "string", description: "Nom ou id de niche (si pas de machine)." },
        perChannel: { type: "number", description: "Vidéos récentes par chaîne (défaut 3, max 10)." },
        refresh: { type: "boolean", description: "true = tout rescraper maintenant (Alex dit « revérifie », « mets à jour », « rescrape ») ; false = ne rien rescraper ; absent = seulement les fiches de plus de 24 h." },
      },
    },
  },
  {
    type: "function",
    name: "api_routes",
    description:
      "Cherche dans le catalogue COMPLET des routes de l'API de la plateforme (300+ : stats, chaînes, stock, publication, calendrier, scraping, niche finder, labo, machines, personnages, crons, coffre, TikTok…). Donne des mots-clés (ex. 'stock publish', 'schedule', 'scrap channel'). Appelle ensuite la route avec agentos_api.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    type: "function",
    name: "platform_lookup",
    description:
      "LEXIQUE D'AGENTIC OS : dis-lui ce qu'Alex vient de nommer (« la niche musique », « le scrap », « la banque », « le studio », « les chaînes », « le labo », « data ranking »…) et il te répond ce que c'est EXACTEMENT dans la plateforme : page (id pour open_page), machine, outils à utiliser, routes de l'API, et ce que ça fait. À appeler dès qu'un mot d'Alex ne correspond pas avec certitude à un outil que tu connais — AVANT d'agir, et JAMAIS deviner à la place. S'il ne trouve rien, pose une question à Alex.",
    parameters: { type: "object", properties: { query: { type: "string", description: "Les mots d'Alex, tels quels." } }, required: ["query"] },
  },

  // --- Machines (usines à vidéos) ---
  {
    type: "function",
    name: "machine_info",
    description: "Fiche d'une MACHINE (timetravel, linguistique, musique, storyfamily, stickman, pov, wealth, datarank) : la LISTE DE SES PARAMÈTRES (clé, type, bornes, défaut, description, requis ou non), valeurs du dernier run, réglages permanents, CHOIX disponibles avec leurs identifiants (personnages, styles, avatars, familles, voix) et runs récents. À appeler quand Alex demande « avec quels paramètres ? », « qu'est-ce que je peux régler ? », ou avant de changer des paramètres précis.",
    parameters: { type: "object", properties: { machine: { type: "string", enum: ["timetravel", "linguistique", "musique", "storyfamily", "stickman", "pov", "wealth", "datarank"] } }, required: ["machine"] },
  },
  {
    type: "function",
    name: "machine_idea",
    description: "Demande à une machine de proposer une ou plusieurs idées de vidéo (son bouton « idée » : tient compte de la niche et de ce qui est déjà produit). Renvoie le thème prêt à passer à machine_run.",
    parameters: { type: "object", properties: { machine: { type: "string", enum: ["timetravel", "linguistique", "musique", "storyfamily", "stickman", "pov", "wealth", "datarank"] }, count: { type: "number", description: "1 à 6 (défaut 1)." } }, required: ["machine"] },
  },
  {
    type: "function",
    name: "machine_run",
    description:
      "PRÉPARE puis LANCE une création (run) sur une machine — production complète d'une vidéo, PAYANTE. Fonctionne TOUJOURS en deux temps : (1) sans `confirm` → renvoie un PLAN (planId, sujet, paramètres résolus, devis en $, ce qui manque) et NE LANCE RIEN ; (2) avec `confirm:true` + `planId` → lance, et seulement si Alex a dit OUI au récapitulatif (le serveur refuse tout lancement sans plan préalable). Entre les deux tu ACCOMPAGNES Alex : tu demandes le sujet s'il manque (ou `pickIdea:true` s'il te laisse choisir), tu proposes les réglages principaux, tu ajustes avec `params` en rappelant l'outil avec le même planId, puis tu récapitules avec le devis et tu demandes « on lance ? ». N'invente JAMAIS un sujet. JAMAIS pour créer ou modifier un personnage, un avatar, un style, une miniature ou un réglage (ce sont des routes : voir api_routes). `params` = uniquement ce qu'Alex demande de changer (clés exactes de machine_info : durationMin, levels, characterId… ; un NOM est accepté pour un identifiant).",
    parameters: {
      type: "object",
      properties: {
        machine: { type: "string", enum: ["timetravel", "linguistique", "musique", "storyfamily", "stickman", "pov", "wealth", "datarank"] },
        theme: { type: "string", description: "Sujet/thème donné PAR ALEX, mot pour mot ou traduit en anglais pour pov/wealth/storyfamily/datarank. Absent tant qu'Alex n'a rien donné : ne l'invente pas." },
        pickIdea: { type: "boolean", description: "true = Alex laisse explicitement la machine choisir le sujet (« choisis », « propose », « ce que tu veux »)." },
        params: { type: "object", description: "Paramètres à changer, avec les clés exactes de machine_info (characterId, durationMin, levels, musicCount, instrumental…)." },
        mode: { type: "string", enum: ["semi", "auto"], description: "Seulement si Alex dit « automatique » (auto : aucune validation) ou « semi-manuel » (semi : validation à chaque étape). Sinon ne pas fournir." },
        planId: { type: "string", description: "Identifiant du plan reçu à l'appel précédent (pour l'ajuster ou le confirmer)." },
        confirm: { type: "boolean", description: "true = LANCER le plan `planId`. Uniquement après un oui explicite d'Alex au récapitulatif." },
      },
      required: ["machine"],
    },
  },
  {
    type: "function",
    name: "machine_settings",
    description: "Modifie les RÉGLAGES permanents d'une machine (ceux de son onglet Paramètres : niveaux par défaut, durée par défaut, langue de chaîne, etc. — voir `settings` dans machine_info).",
    parameters: { type: "object", properties: { machine: { type: "string", enum: ["timetravel", "linguistique", "musique", "storyfamily", "stickman", "pov", "wealth", "datarank"] }, settings: { type: "object" } }, required: ["machine", "settings"] },
  },
  {
    type: "function",
    name: "machine_runs",
    description: "Suivi et pilotage des runs d'une machine : list (runs récents), stock (vidéos TERMINÉES en stock : publiées ou non, archivées), status (détail d'un run : étape, erreur, coût), validate (valider l'étape en attente d'un run semi-manuel), cancel, resume.",
    parameters: {
      type: "object",
      properties: {
        machine: { type: "string", enum: ["timetravel", "linguistique", "musique", "storyfamily", "stickman", "pov", "wealth", "datarank"] },
        action: { type: "string", enum: ["list", "stock", "status", "validate", "cancel", "resume"] },
        runId: { type: "string", description: "Requis sauf pour list/stock. Absent pour status/validate = le run le plus récent." },
      },
      required: ["machine", "action"],
    },
  },
  {
    type: "function",
    name: "kie_catalog",
    description: "Catalogue Kie.ai (200+ modèles) : liste compacte (identifiant exact, nom, prix) filtrée par catégorie, par TÂCHE (ex. 'Image to Video' pour animer une image) et/ou mot-clé (marque : 'kling', 'suno', 'veo'…). Triée favoris d'abord puis du MOINS CHER au plus cher. À utiliser avant kie_generate pour choisir le modèle exact.",
    parameters: {
      type: "object",
      properties: {
        category: { type: "string", enum: ["video", "image", "music", "audio", "chat"] },
        task: { type: "string", enum: ["Text to Video", "Image to Video", "Video to Video", "Text to Image", "Image to Image", "Image Editing", "Text to Music", "Text to Speech", "Audio to Audio", "Lip Sync", "Video Editing", "Speech to Video", "Chat"], description: "Type de tâche exact." },
        query: { type: "string", description: "Mot-clé optionnel (nom de modèle ou de fournisseur, en anglais)." },
      },
    },
  },
  {
    type: "function",
    name: "kie_generate",
    description:
      "Lance une génération sur N'IMPORTE QUEL modèle Kie.ai (vidéo, image, musique, voix) par son identifiant exact (kie_catalog) avec ses options (`input` : prompt, aspect_ratio, duration, image_url…). Pour connaître les options d'un modèle : kie_schema. Asynchrone : jobId renvoyé, fichiers transmis automatiquement (image/vidéo/audio → bloc image ou lien dans show_window).",
    parameters: {
      type: "object",
      properties: { model: { type: "string" }, input: { type: "object", description: "Champs du schéma du modèle. Les fichiers sources locaux s'indiquent par {\"rel\": \"agent-os/output/…\"} (chemin Mes fichiers) ou par URL publique." } },
      required: ["model", "input"],
    },
  },
  {
    type: "function",
    name: "recent_files",
    description: "Derniers fichiers GÉNÉRÉS (Kie Studio, Miniature Creator, machines) avec leur chemin `rel` réutilisable comme source d'une autre génération (image → vidéo, extension audio…). À appeler quand Alex dit « l'image que je viens de faire », « la dernière vidéo »…",
    parameters: { type: "object", properties: { type: { type: "string", enum: ["image", "video", "audio"], description: "Filtre (optionnel)." }, limit: { type: "number" } } },
  },
  {
    type: "function",
    name: "kie_schema",
    description: "Options (champs, valeurs possibles, requis, prix) d'un modèle Kie.ai précis.",
    parameters: { type: "object", properties: { model: { type: "string" } }, required: ["model"] },
  },
  {
    type: "function",
    name: "notify_telegram",
    description: "Envoie sur le Telegram d'Alex un message texte ET/OU un fichier (image, vidéo, audio, document — 50 Mo max). `file` = chemin `rel` (donné par un résultat de job ou recent_files), une URL /media/…, ou 'dernier' pour le dernier fichier généré (filtrable par `type`). Uniquement quand Alex le demande.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Message, ou légende du fichier." },
        file: { type: "string", description: "rel, URL /media/…, ou 'dernier'." },
        type: { type: "string", enum: ["image", "video", "audio"], description: "Avec file='dernier' : type du fichier voulu." },
      },
    },
  },

  // --- Mémoire & programme ---
  {
    type: "function",
    name: "remember",
    description: "Mémorise durablement un fait, une préférence ou une consigne de l'utilisateur (réinjecté à chaque session).",
    parameters: { type: "object", properties: { fact: { type: "string" } }, required: ["fact"] },
  },
  {
    type: "function",
    name: "forget",
    description: "Oublie les souvenirs contenant ce texte.",
    parameters: { type: "object", properties: { match: { type: "string" } }, required: ["match"] },
  },
  {
    type: "function",
    name: "program_get",
    description: "To-do personnelle d'Alex pour une journée (priorités P1/P2/P3). Sans date = aujourd'hui. Ce n'est PAS le calendrier de publication YouTube (vidéos programmées : agentos_api GET /api/schedule).",
    parameters: { type: "object", properties: { date: { type: "string", description: "AAAA-MM-JJ" } } },
  },
  {
    type: "function",
    name: "program_set",
    description: "Définit ou complète le programme d'une journée.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string" },
        items: { type: "array", items: { type: "object", properties: { priority: { type: "string", enum: ["P1", "P2", "P3"] }, text: { type: "string" } }, required: ["text"] } },
        append: { type: "boolean", description: "true = ajouter aux éléments existants." },
      },
      required: ["items"],
    },
  },
  {
    type: "function",
    name: "program_done",
    description: "Coche (ou décoche) un élément du programme du jour.",
    parameters: { type: "object", properties: { match: { type: "string", description: "id ou bout de texte." }, done: { type: "boolean" }, date: { type: "string" } }, required: ["match"] },
  },

  // --- Ordinateur ---
  {
    type: "function",
    name: "computer_open",
    description: "Ouvre une application, un fichier, un dossier ou une URL sur l'ordinateur (Windows). Exemples : 'notepad', 'brave', 'https://youtube.com', 'C:\\Users\\…\\Documents', 'code' (VS Code), 'explorer', 'calc', 'spotify', 'discord'.",
    parameters: { type: "object", properties: { target: { type: "string" }, args: { type: "string", description: "Arguments optionnels." } }, required: ["target"] },
  },
  {
    type: "function",
    name: "computer_windows",
    description: "Gère les fenêtres ouvertes : list (toutes les fenêtres visibles), focus, minimize, maximize, close (par morceau de titre ou nom de processus).",
    parameters: {
      type: "object",
      properties: { action: { type: "string", enum: ["list", "focus", "minimize", "maximize", "close"] }, title: { type: "string", description: "Morceau du titre ou nom du processus (insensible à la casse)." } },
      required: ["action"],
    },
  },
  {
    type: "function",
    name: "computer_screenshot",
    description: "Capture l'écran et le DÉCRIT (vision). Utile pour voir ce que fait l'utilisateur, lire une erreur, vérifier qu'une action a réussi, ou trouver où cliquer (coordonnées en pixels de l'image renvoyée). L'image peut ensuite être montrée via show_window (bloc image, src renvoyé).",
    parameters: { type: "object", properties: { question: { type: "string", description: "Ce qu'il faut regarder/chercher précisément." }, screen: { type: "string", enum: ["primary", "all"] } } },
  },
  {
    type: "function",
    name: "computer_type",
    description: "Tape du texte au clavier dans la fenêtre active (comme si l'utilisateur tapait).",
    parameters: { type: "object", properties: { text: { type: "string" }, enter: { type: "boolean", description: "Appuyer sur Entrée à la fin." } }, required: ["text"] },
  },
  {
    type: "function",
    name: "computer_keys",
    description: "Envoie des raccourcis clavier (syntaxe SendKeys) : ^ = Ctrl, % = Alt, + = Shift. Ex. '^s' (Ctrl+S), '%{F4}' (Alt+F4), '{ENTER}', '{TAB}', '^{TAB}', '{ESC}', '^c', '^v', '{F5}', '#' n'est pas supporté (touche Windows : utiliser computer_open).",
    parameters: { type: "object", properties: { keys: { type: "string" } }, required: ["keys"] },
  },
  {
    type: "function",
    name: "computer_click",
    description: "Clique à une position de l'écran (coordonnées en pixels réels ; fais d'abord computer_screenshot pour les repérer — l'échelle entre l'image et l'écran est renvoyée).",
    parameters: {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" }, button: { type: "string", enum: ["left", "right"] }, double: { type: "boolean" } },
      required: ["x", "y"],
    },
  },
  {
    type: "function",
    name: "computer_run",
    description: "Exécute une commande PowerShell sur l'ordinateur et renvoie la sortie (fichiers, processus, réseau, réglages, volume, etc.). Puissant : à utiliser avec discernement, jamais pour supprimer en masse sans confirmation explicite.",
    parameters: { type: "object", properties: { command: { type: "string" }, timeoutSec: { type: "number" } }, required: ["command"] },
  },
  {
    type: "function",
    name: "read_file",
    description: "Lit un fichier texte du disque (chemin absolu ou relatif au projet « Agentic OS d'Alex »).",
    parameters: { type: "object", properties: { path: { type: "string" }, maxChars: { type: "number" } }, required: ["path"] },
  },
  {
    type: "function",
    name: "list_dir",
    description: "Liste le contenu d'un dossier (nom, type, taille).",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
];

const CLIENT_TOOLS = TOOLS.filter((t) => t.client).map((t) => t.name);

// ---------- Machines : adaptateurs (chaque machine a sa clé de thème, sa forme d'idée et ses identifiants requis) ----------
// `params` : la fiche de chaque paramètre (clé, type, bornes, défaut, description, requis). C'est ce que Jarvis
// lit pour expliquer « avec quels paramètres » et savoir quoi demander quand il manque quelque chose.
const P = (key, type, desc, extra = {}) => ({ key, type, desc, ...extra });
const MACHINE_SPEC = {
  pov: {
    name: "POV", themeKey: "subject", defaultMode: "semi",
    params: [
      P("subject", "string", "Organisation ou hiérarchie à gravir, en anglais (ex. 'a Michelin-starred kitchen')", { required: true }),
      P("durationMin", "number", "Durée de la vidéo en minutes", { range: "3–35", default: 25 }),
      P("levels", "number", "Nombre de rangs / niveaux de la pyramide", { range: "4–12", default: "réglage de la machine (10)" }),
      P("language", "string", "Langue de la voix off et des textes", { default: "langue de la chaîne (English)" }),
      P("voice", "string", "Voix Inworld (voir choices.voices)", { default: "1re voix de la langue" }),
      P("subtitles", "boolean", "Sous-titres incrustés", { default: true }),
    ],
    ideaValue: (i) => i.subject, defaults: (c) => ({ durationMin: 25, levels: (c.settings && c.settings.levels) || 10, language: (c.settings && c.settings.chainLanguage) || "English", subtitles: true }),
  },
  wealth: {
    name: "Wealth", themeKey: "subject", defaultMode: "semi",
    params: [
      P("subject", "string", "Cas + lieu + angle, en anglais (ex. 'the $40M Malibu mansions swallowed by the Palisades fire')", { required: true }),
      P("durationMin", "number", "Durée en minutes", { range: "2–30", default: "réglage de la machine (8)" }),
      P("language", "string", "Langue", { default: "langue de la chaîne (English)" }),
      P("voiceProvider", "string", "Fournisseur de voix", { enum: ["inworld", "elevenlabs"], default: "inworld" }),
      P("voice", "string", "Voix (choices.voices ou choices.elevenVoices)"),
      P("avatarId", "string", "Avatar présentateur : id ou nom (choices.avatars), ou 'none' pour aucun", { default: "1er avatar" }),
      P("avatarIntro", "boolean", "Intro face caméra par l'avatar", { default: true }),
      P("avatarCount", "number", "Apparitions de l'avatar dans la vidéo", { range: "0–6", default: "réglage de la machine" }),
      P("mixBroll", "number", "Part de b-roll Pexels en % (le reste = rendus IA)", { range: "0–100", default: "réglage de la machine" }),
      P("motionPct", "number", "Part de plans motion design en %", { range: "0–40", default: "réglage de la machine" }),
      P("subtitles", "boolean", "Sous-titres", { default: false }),
      P("music", "boolean", "Musique de fond", { default: "réglage de la machine" }),
    ],
    ideaValue: (i) => i.subject, defaults: (c) => ({ durationMin: (c.settings && c.settings.durationMin) || 8, language: (c.settings && c.settings.chainLanguage) || "English" }), ids: { avatarId: "avatars" },
  },
  stickman: {
    name: "Stickman", themeKey: "subject", defaultMode: "semi",
    params: [
      P("subject", "string", "Sujet du documentaire", { required: true }),
      P("characters", "string", "Personnages / figurants souhaités (texte libre, optionnel)"),
      P("durationMin", "number", "Durée en minutes", { range: "1–30", default: 5 }),
      P("language", "string", "Langue", { default: "English" }),
      P("voice", "string", "Voix Inworld (choices.voices)"),
      P("subtitles", "boolean", "Sous-titres", { default: true }),
    ],
    ideaValue: (i) => i.subject, defaults: () => ({ durationMin: 5, language: "English" }),
  },
  timetravel: {
    name: "Time Travel", themeKey: "theme", defaultMode: "semi",
    params: [
      P("characterId", "string", "Personnage voyageur : id ou nom (choices.characters)", { required: true }),
      P("theme", "string", "Époque + lieu du voyage (ex. 'Paris, 1889, Exposition universelle')"),
      P("durationSec", "number", "Durée en secondes (≈ 10 s par scène)", { default: 60 }),
    ],
    ideaValue: (i) => i, defaults: () => ({ durationSec: 60 }), ids: { characterId: "characters" }, required: ["characterId"],
  },
  linguistique: {
    name: "Linguistique", themeKey: "theme", defaultMode: "semi",
    params: [
      P("presenterId", "string", "Présentateur·rice : id ou nom (choices.characters)", { required: true }),
      P("protagonistIds", "array", "Les 2 protagonistes des dialogues : ids ou noms", { required: true }),
      P("theme", "string", "Situation / thème des dialogues"),
      P("language", "string", "Langue apprise", { default: "English" }),
      P("chainLanguage", "string", "Langue de la chaîne (explications)"),
      P("level", "string", "Niveau CECRL", { enum: ["A1", "A2", "B1", "B2", "C1"] }),
      P("sceneCount", "number", "Nombre de dialogues", { range: "1–100", default: 6 }),
      P("lipsync", "boolean", "Lipsync des personnages"),
      P("subtitles", "boolean", "Sous-titres"),
    ],
    ideaValue: (i) => i, ideaArgs: (b) => [b.sceneCount], defaults: () => ({ language: "English", sceneCount: 6 }), ids: { presenterId: "characters", protagonistIds: "characters" }, required: ["presenterId", "protagonistIds"],
  },
  storyfamily: {
    name: "Story Family", themeKey: "theme", defaultMode: "semi",
    params: [
      P("familyId", "string", "Famille : id ou nom (choices.families)", { default: "1re famille" }),
      P("theme", "string", "Pitch-titre de l'histoire, en anglais"),
      P("durationMin", "number", "Durée en minutes", { range: "2–12", default: 6 }),
      P("recycleCount", "number", "Scènes recyclées d'anciens runs", { range: "0–5", default: 0 }),
    ],
    ideaValue: (i) => i, defaults: () => ({ durationMin: 6 }), ids: { familyId: "families" },
  },
  musique: {
    name: "Musique", themeKey: "theme", defaultMode: "semi",
    params: [
      P("styleId", "string", "Style musical : id ou nom (choices.styles)", { required: true }),
      P("theme", "string", "Ambiance / thème de la playlist"),
      P("musicCount", "number", "Nombre de titres (pair : Suno en génère 2 par appel)", { range: "2–30", default: 2 }),
      P("instrumental", "boolean", "Sans paroles"),
      P("waveform", "boolean", "Visualiseur d'onde"),
      P("cta", "boolean", "Appel à l'action en fin de vidéo"),
    ],
    ideaValue: (i) => i, ideaArgs: (b) => [b.styleId], defaults: () => ({ musicCount: 2 }), ids: { styleId: "styles" }, required: ["styleId"],
  },
  datarank: {
    name: "Data Ranking", themeKey: "topic", defaultMode: "auto",
    params: [
      P("topic", "string", "Sujet du classement (ex. 'the biggest stadiums in the world')", { required: true }),
      P("durationMin", "number", "Durée en minutes (ou durationSec)", { default: "réglage de la machine (5)" }),
      P("voice", "string", "Voix Inworld"),
      P("imageModel", "string", "Modèle d'image", { enum: ["gpt25", "qwen21"] }),
      P("language", "string", "Langue"),
      P("music", "boolean", "Musique de fond"),
    ],
    idea: async (m) => (await m.suggestThemes(1))[0], ideaValue: (i) => i.text || i.title || i, defaults: (c) => ({ durationMin: (c.settings && c.settings.durationMin) || 5 }),
  },
};
for (const s of Object.values(MACHINE_SPEC)) s.doc = s.params.map((p) => `${p.key}${p.required ? "*" : ""}${p.range ? " " + p.range : ""}${p.enum ? " (" + p.enum.join("|") + ")" : ""}`).join(", ");

// ---------- Lexique de la plateforme (outil platform_lookup) ----------
// Ce qu'Alex nomme → ce que c'est dans Agentic OS. Jarvis le consulte au lieu de deviner.
const L = (name, kind, aliases, what, how, extra = {}) => ({ name, kind, aliases, what, how, ...extra });
const LEXICON = [
  L("Dashboard", "page", ["tableau de bord", "accueil", "stats", "statistiques", "dépenses", "depenses", "vues", "abonnés", "abonnes"], "Stats YouTube par chaîne et période (vues, abonnés), dépenses par API/machine, tâches en cours.", "channel_stats pour un rapport ; open_page 'dashboard' pour montrer ; agentos_api GET /api/stats/series, GET /api/spend.", { page: "dashboard" }),
  L("Tâches & Cron", "page", ["tâches", "taches", "tâche", "tache", "cron", "crons", "planification", "jobs"], "Tâches de la plateforme (runs, scrapings, publications) et crons Telegram / Hermès.", "agentos_api GET /api/tasks, GET /api/crons, GET /api/hermes/crons ; open_page 'tasks'.", { page: "tasks" }),
  L("Calendrier de publication", "page", ["calendrier", "programmation", "planning", "publications programmées", "planifier"], "Plans récurrents et événements de publication YouTube datés.", "agentos_api GET /api/schedule, POST /api/schedule/plans, POST /api/schedule/events ; open_page 'calendar'.", { page: "calendar" }),
  L("Architecture", "page", ["architecture", "schéma", "schema"], "Vue d'architecture de la plateforme.", "open_page 'architecture'.", { page: "architecture" }),
  L("Chat Claude Code", "page", ["claude", "claude code", "développeur", "developpeur", "code", "dev"], "Agent de développement : code, fichiers, analyses longues.", "ask_claude (asynchrone) ; open_page 'chat'.", { page: "chat" }),
  L("Chat Hermès", "page", ["hermès", "hermes", "agent local"], "Agent local autonome (crons durables, Telegram).", "ask_hermes ; open_page 'hermes'.", { page: "hermes" }),
  L("Second Cerveau", "page", ["second cerveau", "cerveau", "obsidian", "notes", "note", "coffre obsidian", "graphe", "rings", "mémoire du projet"], "Coffre Obsidian « Test formation » : notes, décisions, journaux + graphe Graphify.", "brain_search / brain_read / brain_write / brain_graph ; open_page 'brain'.", { page: "brain" }),
  L("Niche Finder", "page", ["niche finder", "trouver une niche", "nouvelles niches", "outliers", "recherche de niche", "chercher des niches"], "Recherche de vidéos/chaînes YouTube qui surperforment (nouvelles niches).", "agentos_api POST /api/niche/search {keywords, minViews, maxSubs, publishedAfter} → job, GET /api/niche/job/<id> ; open_page 'niche'.", { page: "niche" }),
  L("Scrap-o-matic", "page", ["scrap", "scraper", "scraping", "scrapomatic", "scrap-o-matic", "transcript", "transcripts", "analyse vision", "chaîne scrappée"], "Scraping de chaînes/vidéos YouTube (Apify) : vidéos, transcripts, analyses vision.", "agentos_api GET /api/scrap/list, GET /api/scrap/search-channels ?q, POST /api/scrap/add, POST /api/scrap/channel/<id>/scrape ; open_page 'scrap'.", { page: "scrap" }),
  L("Banque de niches", "page", ["banque", "banque de niches", "la banque", "concurrents", "chaînes concurrentes", "veille", "niche de la machine"], "Niches enregistrées : chaînes concurrentes par niche, reliées aux machines (inspiration des idées).", "niche_bank {machine|niche} ; competitor_videos {machine} pour les dernières vidéos des concurrents ; open_page 'bank'.", { page: "bank" }),
  L("Labo de niche", "page", ["labo", "labo de niche", "niche lab", "scan de chaîne", "décorticage"], "Scan complet de chaînes (yt-dlp + Qwen) : analyse plan par plan, digest.", "agentos_api GET/POST /api/lab/* ; résultats dans la Banque.", { page: "bank" }),
  L("Machines", "page", ["machines", "usines", "liste des machines", "hub"], "Hub des 8 machines de production vidéo.", "open_page 'machines' ; chaque machine a son id (voir machines).", { page: "machines" }),
  L("Time Travel", "machine", ["time travel", "timetravel", "voyage dans le temps", "vlog", "vlogs"], "Vlogs de voyage dans le temps (personnage de référence → images → vidéo Grok → Remotion).", "machine_info/machine_idea/machine_run {machine:'timetravel'} ; open_page 'timetravel'.", { page: "timetravel", machine: "timetravel" }),
  L("Linguistique", "machine", ["linguistique", "langue", "langues", "apprentissage de langue", "dialogues", "french speaker"], "Apprentissage de langue par dialogues (présentateur + 2 protagonistes, ElevenLabs, sous-titres).", "machine_* {machine:'linguistique'} ; open_page 'linguistique'.", { page: "linguistique", machine: "linguistique" }),
  L("Musique", "machine", ["musique", "music", "niche musique", "machine musique", "mix", "playlist", "suno", "ambiance musicale", "style musical"], "Vidéos musicales longues (styles musicaux → Suno → waveform/CTA). Ses idées sont des AMBIANCES pour un style musical donné (onglet Style).", "machine_idea {machine:'musique'} (idées pour le style courant), machine_info (styles disponibles), machine_run ; niche_bank {machine:'musique'} pour sa niche ; open_page 'musique'.", { page: "musique", machine: "musique" }),
  L("Story Family", "machine", ["story family", "storyfamily", "famille", "histoires familiales", "histoire de famille"], "Histoires familiales animées 3D (famille de personnages → images i2i → Grok → montage).", "machine_* {machine:'storyfamily'} ; open_page 'storyfamily'.", { page: "storyfamily", machine: "storyfamily" }),
  L("Stickman", "machine", ["stickman", "stickmen", "documentaire stickman", "documentaires"], "Documentaires anthropologiques en stickman (script → voix Inworld → casting → images → montage).", "machine_* {machine:'stickman'} ; open_page 'stickman'.", { page: "stickman", machine: "stickman" }),
  L("POV", "machine", ["pov", "rank", "every rank", "your life as every rank", "hiérarchie", "pyramide"], "« Your Life as Every Rank in… » : gravir une hiérarchie, niveaux en pyramide (Inworld + images + Remotion).", "machine_* {machine:'pov'} ; open_page 'pov'.", { page: "pov", machine: "pov" }),
  L("Wealth", "machine", ["wealth", "fortune", "fortunes", "mansions", "luxe", "riches", "catastrophes"], "Fortunes, mansions et luxe face aux catastrophes (b-roll Pexels + rendus IA + motion + avatar).", "machine_* {machine:'wealth'} ; open_page 'wealth'.", { page: "wealth", machine: "wealth" }),
  L("Data Ranking", "machine", ["data ranking", "datarank", "data rank", "classement", "classements", "carrousel", "carrousels", "ranking"], "Carrousels data en ordre croissant (Wikipédia/Wikidata vérifiés → script → voix → images → Remotion).", "machine_* {machine:'datarank'} ; open_page 'datarank'.", { page: "datarank", machine: "datarank" }),
  L("Machine Fruits (TikTok)", "machine", ["fruits", "machine fruits", "ttfruits", "tiktok fruits"], "Machine de l'OS TikTok (histoires de fruits).", "agentos_api /api/ttfruits/* ; open_page 'ttfruits'.", { page: "ttfruits" }),
  L("Chaînes", "page", ["chaîne", "chaînes", "chaine", "chaines", "youtube", "mes chaînes", "stock", "restock", "publier", "publication", "stock privé"], "Chaînes YouTube connectées : chiffres, stock de vidéos privées, restock par la machine associée, publication, plannings.", "channel_stats {channel} pour un rapport ; agentos_api GET /api/channels/overview, POST /api/channels/<id>/restock, machine_runs {action:'stock'} ; open_page 'channels'.", { page: "channels" }),
  L("Miniature Creator", "page", ["miniature", "miniatures", "thumbnail", "vignette", "image rapide"], "Génération d'images Kie (miniatures YouTube, t2i / i2i).", "generate_image ; miniature d'un run : POST /api/machines/<machine>/runs/<runId>/thumbnail ; open_page 'miniature'.", { page: "miniature" }),
  L("Kie Studio", "page", ["kie", "kie studio", "le studio", "studio", "génération", "generation", "modèle", "modeles", "modèles", "kling", "veo", "image ia", "vidéo ia", "voix ia"], "Catalogue complet Kie.ai (218 modèles : vidéo, image, musique, voix, chat) avec leurs options.", "kie_catalog → kie_schema → kie_generate ; recent_files pour réutiliser un fichier ; open_page 'kie'.", { page: "kie" }),
  L("Mes fichiers", "page", ["fichiers", "mes fichiers", "fichier", "drive", "google drive", "dernière vidéo", "dernière image"], "Fichiers générés (local) + Google Drive.", "recent_files ; agentos_api GET /api/files ; open_page 'files'.", { page: "files" }),
  L("Scrap-o-matic TikTok", "page", ["tiktok", "scrap tiktok", "os tiktok"], "OS TikTok : scraper et analyses TikTok.", "agentos_api /api/tiktok/* ; open_page 'tiktok'.", { page: "tiktok" }),
  L("Banque d'histoires (TikTok)", "page", ["banque d'histoires", "histoires tiktok", "ttbank"], "Banque d'histoires de l'OS TikTok.", "open_page 'ttbank'.", { page: "ttbank" }),
  L("Connexions", "page", ["connexions", "connexion", "santé", "sante", "services", "oauth", "connecté", "connecte"], "Santé des services (Claude, Hermès, Kie, Drive, Telegram, quota YouTube).", "platform_overview ; open_page 'connections'.", { page: "connections" }),
  L("Paramètres", "page", ["paramètres", "parametres", "réglages", "reglages", "coffre", "clés", "cles", "credentials", "clé api", "voix de jarvis", "ta voix"], "Coffre de credentials (aperçus masqués), clés YouTube/Apify, Google OAuth, réglages Jarvis (voix, style).", "set_voice pour ta voix ; agentos_api /api/vault/* ; open_page 'settings'.", { page: "settings" }),
  L("Telegram", "tool", ["telegram", "envoie-moi", "envoie sur telegram", "notification"], "Envoi de messages et fichiers sur le Telegram d'Alex.", "notify_telegram {text, file}."),
  L("Programme du jour", "tool", ["programme", "programme du jour", "to-do", "todo", "priorités", "priorites", "ma journée"], "To-do personnelle d'Alex (P1/P2/P3).", "program_get / program_set / program_done."),
  L("Mémoire de Jarvis", "tool", ["mémoire", "memoire", "retiens", "souviens-toi", "oublie"], "Faits durables réinjectés à chaque appel.", "remember / forget."),
  L("Ordinateur", "tool", ["ordinateur", "pc", "écran", "ecran", "fenêtre windows", "application", "appli", "capture d'écran"], "Contrôle du PC d'Alex (apps, fenêtres, écran, clavier, souris, PowerShell).", "computer_open / computer_windows / computer_screenshot / computer_type / computer_keys / computer_click / computer_run."),
  L("Internet", "tool", ["internet", "web", "recherche web", "actualité", "actualite", "google"], "Recherche sur Internet.", "web_search."),
  L("Idée de vidéo", "concept", ["idée", "idee", "idées", "idees", "thème", "theme", "thèmes", "sujet", "sujets", "propose", "proposition"], "Une idée vient TOUJOURS de la machine concernée (elle tient compte de sa niche et de ce qui est déjà produit).", "machine_idea {machine, count} ; rapporte les idées telles quelles ; machine_run avec `theme` = l'idée choisie."),
  L("Run / création", "concept", ["run", "runs", "création", "creation", "lancer", "produire", "générer une vidéo", "generer une video", "créer une vidéo"], "Production d'une vidéo par une machine : plan → questions → récapitulatif → confirmation d'Alex → lancement, puis validation à chaque étape (semi-manuel).", "machine_run (plan puis confirm:true + planId) ; machine_runs {action:'status'|'validate'|'cancel'|'resume'}."),
];
// ---------- Création accompagnée : plan → questions → « on lance ? » → confirmation ----------
// Un run ne part JAMAIS au premier appel. machine_run renvoie un PLAN (paramètres résolus, ce qui manque, devis)
// que Jarvis complète avec Alex ; le lancement exige confirm:true + le planId du dernier plan montré (moins de
// 15 min). Le modèle vocal ne peut donc pas court-circuiter l'accompagnement, quoi qu'il décide de lui-même.
const pendingPlans = new Map(); // planId -> { machine, body, createdAt }
const PLAN_TTL = 15 * 60e3;

/** Devis ($) d'un run à partir du corps de requête, quand la machine sait estimer (pov, stickman, wealth, datarank). */
function estimateFor(id, m, body) {
  try {
    if (typeof m.estimate !== "function") return undefined;
    const b = id === "datarank" ? { ...body, durationSec: body.durationSec || (Number(body.durationMin) || 0) * 60 || undefined } : body;
    const e = m.estimate(b);
    const usd = e && (e.total !== undefined ? e.total : e.usd);
    return usd !== undefined && usd !== null ? +Number(usd).toFixed(2) : undefined;
  } catch { return undefined; }
}
function machineOf(id) {
  const key = String(id || "").toLowerCase().replace(/[\s_-]+/g, "");
  const alias = { timetravel: "timetravel", voyagedansletemps: "timetravel", linguistique: "linguistique", musique: "musique", music: "musique", storyfamily: "storyfamily", stickman: "stickman", pov: "pov", wealth: "wealth", datarank: "datarank", dataranking: "datarank" }[key];
  if (!alias) throw new Error("Machine inconnue : " + id + ". Machines : " + Object.keys(MACHINE_SPEC).join(", "));
  return { id: alias, spec: MACHINE_SPEC[alias], lib: require("./machines/" + alias) };
}
/** Choix disponibles d'une machine, avec leurs identifiants (pour convertir un nom en id et choisir par défaut). */
function machineChoices(m) {
  const c = m.config();
  const out = {};
  for (const k of ["characters", "styles", "avatars"]) if (Array.isArray(c[k]) && c[k].length) out[k] = c[k].map((x) => ({ id: x.id, name: x.name || x.id }));
  if (typeof m.families === "function") { try { const f = m.families(); if (f.length) out.families = f.map((x) => ({ id: x.familyId, name: x.name || x.familyId })); } catch {} }
  if (m.VOICES) out.voices = m.VOICES;
  if (m.ELEVEN_VOICES) out.elevenVoices = m.ELEVEN_VOICES;
  return out;
}
function lastRunParams(m) {
  try {
    const last = (m.listRuns() || []).slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    if (!last) return {};
    return last.params || (m.getRun(last.id) || {}).params || {};
  } catch { return {}; }
}
/** Nom → id (insensible à la casse, correspondance partielle) pour les champs d'identifiant. */
function resolveIds(spec, params, choices) {
  for (const [k, pool] of Object.entries(spec.ids || {})) {
    if (params[k] === undefined || params[k] === null) continue;
    const list = choices[pool] || [];
    const one = (v) => {
      if (v === "none") return v;
      const s = String(v).toLowerCase();
      const hit = list.find((x) => x.id === v) || list.find((x) => String(x.name).toLowerCase() === s) || list.find((x) => String(x.name).toLowerCase().includes(s));
      if (!hit) throw new Error(`${k} « ${v} » introuvable. Disponibles : ${list.map((x) => x.name).join(", ") || "aucun"}`);
      return hit.id;
    };
    params[k] = Array.isArray(params[k]) ? params[k].map(one) : one(params[k]);
  }
  return params;
}
const ideaText = (i) => (typeof i === "string" ? i : i.subject || i.theme || i.text || (i.era ? `${i.era} — ${i.place}` : "") || i.title || JSON.stringify(i));
function runSummary(r) {
  if (!r) return null;
  const cost = r.cost && typeof r.cost === "object" ? +Object.values(r.cost).reduce((a, b) => a + (Number(b) || 0), 0).toFixed(2) : undefined;
  return { id: r.id, title: r.title || (r.params && (r.params.subject || r.params.topic)) || ideaText(r.theme || (r.params && r.params.theme) || ""), status: r.status, mode: r.mode || (r.params && r.params.mode), error: r.error || undefined, createdAt: r.createdAt, costUsd: cost };
}

async function runTool(name, args = {}) {
  switch (name) {
    case "web_search":
      return webSearch(args.query, { depth: args.depth || "medium" });
    case "brain_search":
      return brainSearch(args.query, args.limit || 8);
    case "brain_read":
      return brainRead(args.path);
    case "brain_write":
      return brainWrite(args);
    case "brain_graph":
      return brainGraph(args.query);

    case "ask_claude": {
      if (args.wait) {
        const reply = await Promise.race([
          askClaude(args.task, { fresh: !!args.fresh }),
          new Promise((_, rej) => setTimeout(() => rej(new Error("Claude met plus de 45 s : relance sans wait, le résultat arrivera en asynchrone")), 45000)),
        ]).catch((e) => {
          if (/45 s/.test(e.message)) {
            const job = startJob("Claude Code : " + args.task.slice(0, 60), () => askClaude(args.task));
            return `Trop long pour attendre — job ${job.id} lancé, résultat transmis automatiquement.`;
          }
          throw e;
        });
        return { reply };
      }
      const job = startJob("Claude Code : " + args.task.slice(0, 60), () => askClaude(args.task, { fresh: !!args.fresh }));
      return { jobId: job.id, status: "running", note: "Claude Code travaille ; le résultat te sera transmis automatiquement (message [RÉSULTAT JOB]). Préviens l'utilisateur et continue." };
    }
    case "ask_hermes": {
      if (!hermes.status().connected) throw new Error("Hermès n'est pas connecté");
      const job = startJob("Hermès : " + args.task.slice(0, 60), async () => (await hermes.sendMessage(hermesChatId(), args.task)).reply);
      return { jobId: job.id, status: "running" };
    }
    case "job_status": {
      const j = jobStatus(args.jobId);
      if (!j) throw new Error("Job inconnu");
      return { ...j, result: j.result ? compact(j.result, 3000) : null };
    }

    case "platform_overview": {
      const [health, tasks, channels, events, program_] = await Promise.all([
        localApi("GET", "/api/health").then((r) => r.data).catch((e) => ({ error: e.message })),
        localApi("GET", "/api/tasks").then((r) => r.data).catch(() => ({})),
        localApi("GET", "/api/channels").then((r) => r.data).catch(() => []),
        localApi("GET", "/api/events").then((r) => (r.data || []).slice(0, 8)).catch(() => []),
        Promise.resolve(program()),
      ]);
      const short = (t) => ({ id: t.id, title: t.title, machine: t.machine, step: t.step, progress: t.progress, status: t.status });
      return {
        health: { claude: health.claude && health.claude.connected, hermes: health.hermes && health.hermes.connected, kie: health.kie && health.kie.configured, drive: health.drive && health.drive.connected, telegram: health.telegram && health.telegram.configured, quota: health.quota },
        channels: (channels || []).map((c) => ({ id: c.channelId, title: c.title, machine: c.machine })),
        tasks: { running: (tasks.running || []).map(short), queued: (tasks.queued || []).map(short), recent: (tasks.recent || []).slice(0, 6).map(short) },
        events: events.map((e) => ({ ts: e.ts, event: e.event, title: e.payload && e.payload.title })),
        machines: ["timetravel", "linguistique", "musique", "storyfamily", "stickman", "pov", "wealth", "datarank", "ttfruits"],
        programToday: program_,
      };
    }
    case "channel_stats": {
      const chans = require("./google").channels();
      if (!chans.length) throw new Error("Aucune chaîne YouTube connectée (Paramètres → Chaînes YouTube).");
      let target = "all";
      if (args.channel && !/^(all|toutes?(\s+les\s+cha[iî]nes)?)$/i.test(String(args.channel).trim())) {
        const q = String(args.channel).toLowerCase().trim();
        const hit = chans.find((c) => c.channelId === args.channel) || chans.find((c) => c.title.toLowerCase() === q) || chans.find((c) => c.title.toLowerCase().includes(q)) || chans.find((c) => q.includes(c.title.toLowerCase()));
        if (!hit) throw new Error(`Chaîne « ${args.channel} » inconnue. Chaînes connectées : ${chans.map((c) => c.title).join(", ")}`);
        target = hit.channelId;
      }
      const period = ["7d", "28d", "90d", "all"].includes(args.period) ? args.period : "28d";
      const rf = args.refresh ? "?refresh=1" : "";
      // Sources existantes du dashboard : aperçu des chaînes (compteurs, stock, dernière vidéo), série hybride
      // vues/abonnés (à jour à la minute grâce aux snapshots), dernières vidéos avec leurs compteurs (Data API).
      const [ovR, serR, liveR] = await Promise.all([
        localApi("GET", "/api/channels/overview" + rf),
        localApi("GET", `/api/stats/series?channel=${target}&period=${period}${args.refresh ? "&refresh=1" : ""}`).catch(() => null),
        localApi("GET", "/api/stats/live" + rf).catch(() => null),
      ]);
      const overviews = (Array.isArray(ovR.data) ? ovR.data : []).filter((c) => target === "all" || c.channelId === target);
      const ok = overviews.filter((c) => !c.error);
      const errored = overviews.filter((c) => c.error);
      if (!ok.length) throw new Error("Stats indisponibles : " + ((errored[0] && errored[0].error) || "aucune donnée"));
      const rows = serR && serR.status < 400 && serR.data ? ((serR.data.value || serR.data).rows || []) : [];
      const liveList = liveR && liveR.data && Array.isArray(liveR.data.value) ? liveR.data.value : [];
      const live = liveList.filter((c) => !c.error && (target === "all" || c.channelId === target));
      const sum = (list, k) => list.reduce((s, x) => s + (Number(x[k]) || 0), 0);
      const PER = { "7d": "7 derniers jours", "28d": "28 derniers jours", "90d": "90 derniers jours", all: "toute la durée de vie" };
      const periodViews = sum(rows, "views"), periodSubs = sum(rows, "subs");
      const best = rows.slice().sort((a, b) => b.views - a.views)[0];
      const today = rows[rows.length - 1];
      const recentVideos = live.flatMap((c) => (c.videos || []).map((v) => ({ title: v.title, channel: c.title, publishedAt: v.publishedAt, views: v.views, likes: v.likes }))).sort((a, b) => b.views - a.views).slice(0, 8);
      const one = ok.length === 1 ? ok[0] : null;
      const title = one ? one.title : "Toutes les chaînes";
      const fr = (iso) => (iso ? new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "long" }) : "");
      const priv = (p) => (p === "public" ? "publique" : p === "private" ? "privée" : "non répertoriée");
      // L'aperçu des chaînes vient du cache manuel : on recalcule l'ancienneté de la dernière vidéo à l'instant
      // du rapport (le chiffre en cache date du relevé) et on signale l'âge des données si elles ont plus d'un jour.
      const daysSince = (c) => (c.lastVideoAt ? Math.floor((Date.now() - Date.parse(c.lastVideoAt)) / 86400e3) : null);
      const dataAt = ok.map((c) => c.fetchedAt).filter(Boolean).sort()[0] || null;
      const stale = dataAt && Date.now() - Date.parse(dataAt) > 86400e3;
      const summary =
        `${title} — ${PER[period]} : ${periodViews} vues, ${periodSubs >= 0 ? "+" : ""}${periodSubs} abonnés nets` +
        (today ? ` (aujourd'hui ${today.views})` : "") +
        (best && best.views ? ` ; meilleure journée le ${fr(best.date)} avec ${best.views} vues` : "") + ". " +
        `Compteurs actuels : ${sum(ok, "subscribers")} abonnés, ${sum(ok, "views")} vues au total, ${sum(ok, "videoCount")} vidéos, ${sum(ok, "stockPrivate")} en stock privé${sum(ok, "stockUnlisted") ? ` et ${sum(ok, "stockUnlisted")} non répertoriées` : ""}.` +
        (one && one.lastVideo ? ` Dernière vidéo : « ${one.lastVideo.title} » (${fr(one.lastVideo.publishedAt)}, ${priv(one.lastVideo.privacy)}, ${one.lastVideo.views} vues, ${one.lastVideo.likes} likes, ${one.lastVideo.comments} commentaires).` : "") +
        (one && daysSince(one) !== null ? ` Dernière publication publique il y a ${daysSince(one)} jour(s).` : "") +
        (recentVideos[0] ? ` Vidéo récente la plus vue : « ${recentVideos[0].title} » (${recentVideos[0].views} vues).` : "") +
        (errored.length ? ` Sans données : ${errored.map((c) => c.title).join(", ")}.` : "") +
        (stale ? ` (Compteurs et dernière vidéo relevés le ${fr(dataAt)} — refresh:true pour les rafraîchir.)` : "");
      return {
        kind: "channel_stats", channel: title, channelId: target, period, summary, dataAt, stale: !!stale,
        periodStats: { views: periodViews, subsNet: periodSubs, bestDay: best && best.views ? { date: best.date, views: best.views } : null, last7days: rows.slice(-7).map((r) => ({ date: r.date, views: r.views, subs: r.subs })) },
        channels: ok.map((c) => ({
          title: c.title, machine: c.machine, subscribers: c.subscribers, totalViews: c.views, videos: c.videoCount, stockPrivate: c.stockPrivate, stockUnlisted: c.stockUnlisted, last24h: c.last24h, daysSinceLastVideo: daysSince(c),
          lastVideo: c.lastVideo ? { title: c.lastVideo.title, publishedAt: c.lastVideo.publishedAt, privacy: c.lastVideo.privacy, views: c.lastVideo.views, likes: c.lastVideo.likes, comments: c.lastVideo.comments } : null,
        })),
        recentVideos,
        note: "Le rapport est DÉJÀ affiché dans une fenêtre : n'appelle pas show_window. Lis `summary` et dis l'essentiel en deux phrases. Impressions, CTR et durée de visionnage : non disponibles (API Google).",
      };
    }
    case "agentos_api": {
      if (!/^\/api\//.test(args.path || "")) throw new Error("Le chemin doit commencer par /api/");
      // GET : les paramètres donnés dans `body` deviennent une chaîne de requête (?a=1&b=2)
      let apiPath = args.path;
      let body = args.body;
      if ((args.method || "GET") === "GET" && body && typeof body === "object" && Object.keys(body).length) {
        const qs = new URLSearchParams(Object.entries(body).filter(([, v]) => v !== null && typeof v !== "object").map(([k, v]) => [k, String(v)])).toString();
        if (qs) apiPath += (apiPath.includes("?") ? "&" : "?") + qs;
        body = undefined;
      }
      const r = await localApi(args.method || "GET", apiPath, body);
      if (typeof r.data === "string") return { status: r.status, data: compact(r.data, 7000) };
      const data = slimToFit(r.data, 7000);
      // Dépenses : total calculé ici, le modèle vocal additionne mal
      if (/^\/api\/spend/.test(apiPath) && r.data && Array.isArray(r.data.byApi)) {
        const usd = (n) => "$" + (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
        const line = (list) => list.filter((x) => x.usd > 0).sort((a, b) => b.usd - a.usd).map((x) => `${x.key} ${usd(x.usd)}`).join(", ");
        const days = new URL(apiPath, "http://x").searchParams.get("days") || 30;
        // Résumé en tête : c'est lui que le modèle doit lire (count/units = nombre d'appels, pas de l'argent)
        return {
          status: r.status,
          data: {
            summary: `Dépenses des ${days} derniers jours : ${usd(r.data.byApi.reduce((s, x) => s + (Number(x.usd) || 0), 0))} au total. Par API (la plus chère d'abord) : ${line(r.data.byApi)}. Par machine : ${line(r.data.byMachine || [])}.`,
            ...data,
          },
        };
      }
      return { status: r.status, data };
    }
    case "generate_image": {
      const job = startJob("Image : " + String(args.prompt).slice(0, 50), () => generateImage(args));
      return { jobId: job.id, status: "running", note: "Génération lancée (1 à 3 min) ; l'URL arrivera automatiquement." };
    }
    case "platform_lookup": {
      const routes = require("./routes");
      const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
      const q = norm(args.query);
      const tokens = q.split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !["les", "des", "une", "pour", "dans", "sur", "avec", "mon", "mes", "machine", "page", "outil", "truc"].includes(t));
      const scored = LEXICON.map((e) => {
        const names = [e.name, ...(e.aliases || [])].map(norm);
        let score = 0;
        for (const n of names) { if (n === q) score += 10; else if (q.includes(n) && n.length > 3) score += 6; }
        for (const t of tokens) for (const n of names) if (n.split(/\W+/).includes(t)) score += 2; else if (n.includes(t)) score += 1;
        return { e, score };
      }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);
      const machines = Object.entries(MACHINE_SPEC).map(([id, s]) => `${id} = ${s.name}`).join(", ");
      return {
        query: args.query,
        matches: scored.map(({ e, score }) => ({ score, name: e.name, kind: e.kind, page: e.page || undefined, machine: e.machine || undefined, what: e.what, how: e.how })),
        apiRoutes: routes.search(args.query, 8).map(routes.describe),
        machines,
        note: scored.length
          ? "Utilise le premier résultat s'il est net ; si deux résultats se valent, demande à Alex lequel (une question courte). Ne fais rien d'autre que ce que `how` indique."
          : "RIEN ne correspond dans Agentic OS. Dis-le à Alex et demande-lui ce qu'il veut dire — n'invente ni fonctionnalité ni action.",
      };
    }
    case "api_routes": {
      const routes = require("./routes");
      const found = routes.search(args.query, 40);
      return { total: found.length, routes: found.map(routes.describe), note: "`:id` = identifiant à remplacer ; `?a&b` = paramètres de requête (passe-les dans body, ils vont dans l'URL) ; `{a, b}` = champs du corps JSON (`{…}` = objet libre). Appelle avec agentos_api {method, path, body}. GET pour lire, POST/PATCH/DELETE pour agir. En cas d'erreur 400, le message dit ce qui manque : corrige et rappelle." };
    }
    case "competitor_videos": {
      const { nicheId, machineId, niches } = resolveNiche(args);
      if (!nicheId) throw new Error("Précise `machine` ou `niche`. Niches : " + niches.map((n) => n.name).join(", "));
      const perChannel = Math.max(1, Math.min(10, Number(args.perChannel) || 3));
      const report = competitorReport(nicheId, machineId, perChannel);
      const stale = report.channels.filter((c) => !c.checkedAt || Date.now() - Date.parse(c.checkedAt) > STALE_MS);
      const targets = args.refresh === false ? [] : args.refresh === true ? report.channels : stale;
      if (veilleRunning.has(nicheId)) return { ...report, refreshing: true, note: "Une mise à jour de cette niche tourne déjà : le rapport à jour arrive tout seul ([RÉSULTAT JOB]). Ne relance rien." };
      if (!targets.length) return { ...report, upToDate: args.refresh !== false || !stale.length, note: stale.length ? `${stale.length} fiche(s) ont plus de 24 h et n'ont pas été rafraîchies (refresh: false).` : "Toutes les fiches ont moins de 24 h : ces données sont à jour. Le tableau est affiché." };
      const job = startJob(`Veille concurrents — ${report.niche}`, () => refreshCompetitors(nicheId, machineId, targets, perChannel));
      return {
        ...report, refreshing: true, jobId: job.id,
        note: `Données en banque affichées ; ${targets.length} chaîne(s) en cours de mise à jour (coût ≈ ${(targets.length * Math.max(5, perChannel) * 0.005).toFixed(2)} $, 1 à 2 min). Dis à Alex ce que montrent déjà ces données et que tu le préviens dès que la mise à jour est finie. Le rapport à jour arrivera tout seul : ne lui demande pas de te relancer.`,
      };
    }
    case "niche_bank": {
      const bank = require("./bank");
      const niches = bank.niches();
      let nicheId = null;
      let machineId = null;
      if (args.machine) {
        const { id, lib: m } = machineOf(args.machine);
        machineId = id;
        const c = m.config();
        nicheId = c.nicheId || ((c.styles || []).find((s) => s.nicheId) || {}).nicheId || null;
        if (!nicheId) throw new Error(`La machine ${id} n'est reliée à aucune niche de la banque. Niches existantes : ${niches.map((n) => n.name).join(", ")}`);
      } else if (args.niche) {
        const s = String(args.niche).toLowerCase();
        const hit = niches.find((n) => n.id === args.niche) || niches.find((n) => n.name.toLowerCase() === s) || niches.find((n) => n.name.toLowerCase().includes(s));
        if (!hit) throw new Error(`Niche « ${args.niche} » introuvable. Niches : ${niches.map((n) => n.name).join(", ")}`);
        nicheId = hit.id;
      }
      if (!nicheId) return { niches: niches.map((n) => ({ id: n.id, name: n.name, channels: n.channels.length })), note: "Précise `machine` ou `niche` pour le détail." };
      const s = bank.summary(nicheId);
      const chanTitle = Object.fromEntries(s.channels.map((c) => [c.channelId, c.title]));
      const out = {
        machine: machineId || undefined, nicheId, niche: s.name,
        channels: s.channels.map((c) => ({ channelId: c.channelId, title: c.title, subscribers: c.subscribers, videos: c.videoCount, scraped: c.scraped })).sort((a, b) => b.subscribers - a.subscribers),
        videoTotal: s.videoTotal, transcripts: s.transcripts, visions: s.visions,
        topTags: s.topTags.slice(0, 15),
        topVideos: s.topVideos.slice(0, 12).map((v) => ({ title: v.title, views: v.views, channel: chanTitle[v.channelId] || v.channelId })),
      };
      if (args.channel) {
        const q = String(args.channel).toLowerCase();
        const ch = s.channels.find((c) => c.title.toLowerCase().includes(q) || c.channelId === args.channel);
        if (ch) {
          out.channel = ch.channelId;
          try {
            const r = require("./scrap").channelResult(ch.channelId);
            out.channelVideos = (r ? r.videos : []).map((v) => ({ title: v.title, views: Number(v.viewCount ?? v.views ?? 0), date: v.date || "" })).sort((a, b) => b.views - a.views).slice(0, 15);
          } catch {}
        }
      }
      return out;
    }
    case "machine_info": {
      const { id, spec, lib: m } = machineOf(args.machine);
      const c = m.config();
      return {
        machine: id, name: spec.name, defaultMode: spec.defaultMode, themeKey: spec.themeKey,
        params: spec.params, runParams: spec.doc,
        lastRunParams: lastRunParams(m), settings: c.settings || {}, choices: machineChoices(m),
        recentRuns: (m.listRuns() || []).slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 5).map(runSummary),
        note: "Pour lancer : machine_run {machine, theme, params} renvoie un plan (planId) ; après le oui d'Alex au récapitulatif, machine_run {machine, planId, confirm:true}.",
      };
    }
    case "machine_idea": {
      const { id, spec, lib: m } = machineOf(args.machine);
      const n = Math.max(1, Math.min(6, Number(args.count) || 1));
      const choices = machineChoices(m);
      const base = { ...(spec.defaults ? spec.defaults(m.config()) : {}), ...lastRunParams(m) };
      // Identifiants (style, personnage, famille…) : ceux du dernier run, sinon le premier disponible, sinon on le dit
      for (const [k, pool] of Object.entries(spec.ids || {})) {
        if (base[k] !== undefined && base[k] !== null && !(Array.isArray(base[k]) && base[k].length < 2)) continue;
        const list = choices[pool] || [];
        if (!list.length) continue;
        base[k] = k === "protagonistIds" ? list.slice(0, 2).map((x) => x.id) : list[0].id;
      }
      const lacking = (spec.required || []).filter((k) => base[k] === undefined || base[k] === null || (Array.isArray(base[k]) && base[k].length < 2));
      if (lacking.length) throw new Error(`${spec.name} : aucun ${lacking.join(", ")} n'existe encore, la machine ne peut pas proposer d'idée. Propose à Alex de le créer dans la machine (open_page '${id}', onglet correspondant).`);
      const basedOn = {};
      for (const [k, pool] of Object.entries(spec.ids || {})) if (base[k] !== undefined) { const list = choices[pool] || []; const nm = (v) => (list.find((x) => x.id === v) || {}).name || v; basedOn[k] = Array.isArray(base[k]) ? base[k].map(nm) : nm(base[k]); }
      let ideas;
      if (n > 1 && typeof m.suggestThemes === "function") ideas = await m.suggestThemes(n, base);
      else ideas = [spec.idea ? await spec.idea(m, base) : await m.suggestTheme(...(spec.ideaArgs ? spec.ideaArgs(base) : []))];
      ideas = (ideas || []).filter(Boolean);
      if (!ideas.length) throw new Error(`${spec.name} n'a renvoyé aucune idée. Dis-le à Alex tel quel.`);
      return {
        machine: id, name: spec.name, basedOn: Object.keys(basedOn).length ? basedOn : undefined,
        ideas: ideas.map((i) => ({ theme: ideaText(i), pitch: i.pitch || i.why || i.myth || undefined, title: i.title || undefined })),
        note: "Rapporte ces idées TELLES QUELLES (ne les reformule pas, n'en ajoute pas, n'en invente pas)" + (basedOn.styleId ? ` — elles sont faites pour le style « ${basedOn.styleId} » ; pour un autre style, machine_info donne la liste.` : ".") + " Pour lancer : machine_run avec `theme` = l'idée choisie (plan, puis confirmation d'Alex).",
      };
    }
    case "machine_run": {
      const { id, spec, lib: m } = machineOf(args.machine);
      const c = m.config();
      const choices = machineChoices(m);
      // Tolérance au modèle vocal : paramètres posés hors de `params`, clés approximatives (character, durée, niveaux…)
      const loose = { ...(args.params || {}) };
      for (const [k, v] of Object.entries(args)) if (!["machine", "theme", "params", "mode", "dryRun", "preview", "pickIdea", "planId", "confirm"].includes(k) && loose[k] === undefined) loose[k] = v;
      const ALIAS = { character: "characterId", personnage: "characterId", perso: "characterId", presenter: "presenterId", presentateur: "presenterId", protagonists: "protagonistIds", protagonistes: "protagonistIds", style: "styleId", avatar: "avatarId", family: "familyId", famille: "familyId", duration: "durationMin", duree: "durationMin", minutes: "durationMin", niveaux: "levels", niveau: "levels", langue: "language", voix: "voice", titres: "musicCount", tracks: "musicCount", scenes: "sceneCount" };
      for (const [k, to] of Object.entries(ALIAS)) {
        if (loose[k] === undefined || loose[to] !== undefined) continue;
        if (k === "style" && id !== "musique") continue; // « style » n'est un identifiant que pour la machine Musique
        if (to === "durationMin" && (id === "timetravel")) { loose.durationSec = Number(loose[k]) * 60; delete loose[k]; continue; }
        loose[to] = loose[k];
        delete loose[k];
      }
      // Musique : « instrumental » glissé dans une clé inventée (genre, type…) → vrai paramètre
      if (id === "musique" && loose.instrumental === undefined && /instrumental/i.test(JSON.stringify(loose) + " " + (args.theme || ""))) loose.instrumental = true;
      const overrides = resolveIds(spec, loose, choices);
      // Un « thème » qui n'est que le nom de la machine n'en est pas un
      const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (args.theme && [id, norm(spec.name), "run", "machine"].includes(norm(args.theme))) args.theme = undefined;
      const base = { ...(spec.defaults ? spec.defaults(c) : {}), ...lastRunParams(m), ...overrides };
      // Jamais de publication héritée d'un ancien run : un run lancé à la voix va en stock sauf demande explicite
      for (const k of ["publishChannelId", "vpsPublish", "vpsChannel", "mode", "count", spec.themeKey]) if (overrides[k] === undefined) delete base[k];
      // Durée demandée dans une unité : l'autre unité héritée du dernier run ne doit pas l'écraser
      if (overrides.durationMin !== undefined && overrides.durationSec === undefined) delete base.durationSec;
      if (overrides.durationSec !== undefined && overrides.durationMin === undefined) delete base.durationMin;
      // Identifiants manquants : premier(s) disponible(s)
      for (const [k, pool] of Object.entries(spec.ids || {})) {
        if (base[k] !== undefined && base[k] !== null && !(Array.isArray(base[k]) && base[k].length < 2)) continue;
        const list = choices[pool] || [];
        if (k === "protagonistIds") {
          const others = list.filter((x) => x.id !== base.presenterId);
          if (others.length >= 2) base[k] = [others[0].id, others[1].id];
        } else if (list.length && (spec.required || []).includes(k) || (k === "avatarId" && list.length) || k === "familyId" && list.length) base[k] = list[0].id;
      }
      const missingIds = (spec.required || []).filter((k) => base[k] === undefined || base[k] === null || (Array.isArray(base[k]) && base[k].length < 2));
      if (missingIds.length) throw new Error(`Machine ${spec.name} : impossible de choisir ${missingIds.join(", ")} (rien de disponible). Crée-les d'abord dans la machine (open_page '${id}').`);
      // Confirmation : on repart du plan montré à Alex, complété par ce que cet appel apporte en plus
      let prior = null;
      if (args.confirm) {
        prior = args.planId ? pendingPlans.get(args.planId) : null;
        if (!prior || prior.machine !== id) throw new Error("Aucun plan à confirmer pour cette machine. Appelle d'abord machine_run SANS confirm : tu reçois un plan et un planId ; pose les questions, fais valider le récapitulatif par Alex, puis confirme avec ce planId.");
        if (Date.now() - prior.createdAt > PLAN_TTL) { pendingPlans.delete(args.planId); throw new Error("Plan expiré (15 min) : refais le plan et fais-le valider par Alex."); }
      } else if (args.planId && pendingPlans.get(args.planId) && pendingPlans.get(args.planId).machine === id) {
        prior = pendingPlans.get(args.planId); // ajustement d'un plan en cours
      }
      const planBody = prior ? { ...prior.body, ...overrides } : { ...base };
      let theme = args.theme || overrides[spec.themeKey] || (prior ? prior.body[spec.themeKey] : undefined) || undefined;
      let idea = null;
      const mode = args.mode === "auto" || args.mode === "semi" ? args.mode : prior && prior.body.mode ? prior.body.mode : spec.defaultMode;
      // Sujet laissé à la machine : l'idée est tirée MAINTENANT, pour qu'Alex la voie et l'accepte avant le lancement
      if (!theme && args.pickIdea && !args.dryRun) {
        idea = spec.idea ? await spec.idea(m, planBody) : await m.suggestTheme(...(spec.ideaArgs ? spec.ideaArgs(planBody) : []));
        theme = spec.ideaValue(idea);
      }
      // Plan lisible : paramètres résolus (noms à la place des identifiants) + devis + ce qui manque
      const shown = Object.fromEntries(Object.entries({ ...planBody, [spec.themeKey]: theme || undefined }).filter(([k, v]) => v !== undefined && v !== null && k !== "mode" && !/publish|vps|channelName|allowNoPublish/i.test(k)));
      for (const [k, pool] of Object.entries(spec.ids || {})) {
        if (shown[k] === undefined) continue;
        const list = choices[pool] || [];
        const nm = (v) => (list.find((x) => x.id === v) || {}).name || v;
        shown[k] = Array.isArray(shown[k]) ? shown[k].map(nm) : nm(shown[k]);
      }
      const estimateUsd = estimateFor(id, m, { ...planBody, [spec.themeKey]: theme || "x" });
      const missing = theme ? [] : [spec.themeKey];
      const label = { subject: "le sujet", topic: "le sujet du classement", theme: "le thème" }[spec.themeKey] || "le sujet";
      const optional = spec.params.filter((p) => !p.required && shown[p.key] !== undefined).map((p) => `${p.key} = ${Array.isArray(shown[p.key]) ? shown[p.key].join(", ") : shown[p.key]}`).join(" · ");
      const plan = { machine: id, name: spec.name, mode, theme: theme ? ideaText(theme) : null, ideaByMachine: !!idea, params: shown, estimateUsd, missing };

      if (args.confirm) {
        if (missing.length) throw new Error(`Il manque encore ${label} : demande-le à Alex avant de confirmer.`);
        const body = { ...planBody, [spec.themeKey]: theme, mode, publishChannelId: null, publishPrivacy: "private", allowNoPublish: true };
        if (args.dryRun) return { dryRun: true, wouldLaunch: true, machine: id, body };
        const run = m.createRun(body);
        if (id === "datarank") m.start(run.id);
        pendingPlans.delete(args.planId);
        const p = run.params || {};
        const est = run.estimate ? (run.estimate.total !== undefined ? run.estimate.total : run.estimate.usd) : estimateUsd;
        return {
          ok: true, launched: true, machine: id, runId: run.id, theme: ideaText(theme), mode,
          params: Object.fromEntries(Object.entries(p).filter(([k, v]) => v !== null && typeof v !== "object" && !/publish|vps|channelName/i.test(k))),
          estimateUsd: est !== undefined && est !== null ? +Number(est).toFixed(2) : undefined,
          note: `Run ${run.id} lancé sur ${spec.name} (${mode === "semi" ? "semi-manuel : chaque étape attend une validation — machine_runs validate, ou le bouton Valider dans la fenêtre" : "automatique, sans validation"}). La fenêtre du run s'ouvre TOUTE SEULE dans l'appel : n'appelle ni open_page ni show_window. Dis en une phrase que c'est lancé et que tu préviendras à chaque étape.`,
        };
      }

      // Plan : RIEN n'est lancé. Mémorisé pour la confirmation ; les anciens plans expirent.
      const planId = "pl" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      const stored = { ...planBody, [spec.themeKey]: theme || undefined, mode };
      if (!args.dryRun) pendingPlans.set(planId, { machine: id, body: stored, createdAt: Date.now() });
      for (const [k, v] of pendingPlans) if (Date.now() - v.createdAt > PLAN_TTL) pendingPlans.delete(k);
      return {
        step: "plan", launched: false, planId: args.dryRun ? null : planId, ...plan, readyToLaunch: !missing.length,
        optionalSettings: optional || undefined,
        ...(args.dryRun ? { dryRun: true, body: stored } : {}),
        ask: missing.length
          ? `Demande à Alex ${label} pour ${spec.name} (une phrase), ou propose-lui de laisser la machine choisir (pickIdea:true). Ne l'invente pas.`
          : `Récapitule en une phrase — sujet${optional ? ", réglages principaux" : ""}${estimateUsd !== undefined ? `, devis $${estimateUsd}` : ""} — et demande « on lance ? ». Lance avec confirm:true et planId ${planId} UNIQUEMENT après un oui explicite d'Alex.`,
        note: "RIEN n'est lancé. Le plan est affiché dans une fenêtre et se met à jour à chaque appel. Pour changer un réglage : rappelle machine_run avec le même planId et params. Jamais confirm:true sans le oui d'Alex.",
      };
    }
    case "machine_settings": {
      const { id, spec, lib: m } = machineOf(args.machine);
      const cur = m.config();
      const next = m.patchConfig({ settings: { ...(cur.settings || {}), ...(args.settings || {}) } });
      return { ok: true, machine: id, name: spec.name, settings: next.settings || {} };
    }
    case "machine_runs": {
      const { id, lib: m } = machineOf(args.machine);
      const sorted = (m.listRuns() || []).slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      if (args.action === "list") return { machine: id, runs: sorted.slice(0, 8).map(runSummary) };
      if (args.action === "stock") {
        if (typeof m.stock !== "function") throw new Error("Cette machine n'a pas de stock");
        const raw = m.stock();
        const list = Array.isArray(raw) ? raw : raw.videos || raw.items || raw.stock || [];
        const KEYS = ["id", "runId", "title", "theme", "subject", "topic", "posted", "archived", "publishedAt", "createdAt", "date", "durationSec", "duration", "youtubeUrl", "url", "channel"];
        const items = list.slice(0, 20).map((v) => Object.fromEntries(KEYS.filter((k) => v[k] !== undefined && v[k] !== null && typeof v[k] !== "object").map((k) => [k, typeof v[k] === "string" ? v[k].slice(0, 90) : v[k]])));
        return { machine: id, total: list.length, notPosted: list.filter((v) => !v.posted && !v.archived).length, stock: items };
      }
      const runId = args.runId || (sorted[0] && sorted[0].id);
      if (!runId) throw new Error("Aucun run sur cette machine");
      if (args.action === "status") {
        const r = m.getRun(runId);
        if (!r) throw new Error("Run introuvable : " + runId);
        const lastLog = (r.logs || r.log || []).slice(-1)[0];
        return { machine: id, ...runSummary(r), lastLog: lastLog ? (typeof lastLog === "string" ? lastLog : lastLog.msg || lastLog.text || JSON.stringify(lastLog)).slice(0, 200) : undefined, waitingValidation: /_ready$/.test(String(r.status)) };
      }
      const r = await localApi("POST", `/api/machines/${id}/runs/${runId}/${args.action}`, {});
      if (r.status >= 400) throw new Error((r.data && r.data.error) || `Action ${args.action} refusée (HTTP ${r.status})`);
      const after = m.getRun(runId);
      return { ok: true, machine: id, action: args.action, ...runSummary(after) };
    }
    case "kie_catalog": {
      const kieStudio = require("./kie");
      const cat = await kieStudio.catalog(false);
      // Recherche tolérante : jetons (n'importe lequel suffit, classés par nombre de jetons trouvés), mots vides ignorés ;
      // jamais de liste vide si la catégorie/tâche existe (on retombe sur le filtre sans mot-clé).
      const STOP = new Set(["the", "to", "a", "de", "le", "la", "les", "vers", "en", "un", "une", "model", "modele", "modèle", "cheapest", "cheap", "moins", "cher", "best", "meilleur"]);
      const tokens = String(args.query || "").toLowerCase().split(/[^a-z0-9.]+/).filter((t) => t.length > 1 && !STOP.has(t));
      const usd = (m) => { const x = /([\d\s]+(?:,\d+)?)\s*\$/.exec(m.priceShort || ""); return x ? Number(x[1].replace(/\s/g, "").replace(",", ".")) : 9999; };
      const base = cat.models.filter((m) => (!args.category || m.category === args.category) && (!args.task || m.taskType.includes(args.task)));
      const hay = (m) => `${m.model} ${m.title} ${m.name} ${m.provider} ${m.taskType.join(" ")}`.toLowerCase();
      let scored = base.map((m) => ({ m, s: tokens.reduce((n, t) => n + (hay(m).includes(t) ? 1 : 0), 0) }));
      const matched = scored.filter((x) => x.s > 0);
      const noMatch = tokens.length > 0 && !matched.length;
      if (tokens.length && matched.length) scored = matched;
      const list = scored
        .sort((a, b) => (b.m.favorite ? 1 : 0) - (a.m.favorite ? 1 : 0) || b.s - a.s || usd(a.m) - usd(b.m))
        .slice(0, 40)
        .map(({ m }) => ({ model: m.model, name: m.name, task: m.taskType[0], price: m.priceShort || m.price.slice(0, 60), ...(m.favorite ? { favorite: true } : {}) }));
      return { total: list.length, note: (noMatch ? "Aucun modèle ne contient ce mot-clé : voici la liste de la catégorie/tâche. " : "") + "Tri : favoris d'Alex, puis du moins cher au plus cher. Utilise l'identifiant `model` exact dans kie_generate.", models: list };
    }
    case "recent_files": {
      const kieStudio = require("./kie");
      const out = [];
      for (const g of kieStudio.gallery()) for (const f of g.files || []) if (f.rel) out.push({ type: f.type, rel: f.rel, url: "/media/" + f.rel, model: g.name || g.model, prompt: (g.prompt || "").slice(0, 80), date: g.date });
      for (const e of studio.readIndex().slice().reverse()) out.push({ type: "image", rel: "agent-os/output/miniatures/" + e.file, url: "/media/agent-os/output/miniatures/" + e.file, model: e.tool, prompt: (e.prompt || "").slice(0, 80), date: e.date });
      try {
        for (const f of require("./files").localFiles(args.type || null).slice(0, 40)) if (!out.some((o) => o.rel === f.rel)) out.push({ type: f.type, rel: f.rel, url: "/media/" + f.rel, model: f.folder, date: f.modified });
      } catch {}
      out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
      const list = out.filter((f) => !args.type || f.type === args.type).slice(0, Math.min(30, Number(args.limit) || 10));
      return { files: list, note: "Pour réutiliser un fichier : {\"rel\": \"<rel>\"} dans le champ fichier de kie_generate (image_url, video_url…)." };
    }
    case "kie_schema": {
      const kieStudio = require("./kie");
      const sch = await kieStudio.schema(args.model, false);
      const cat = await kieStudio.catalog(false);
      const m = cat.models.find((x) => x.model === args.model);
      const props = (sch.input && sch.input.properties) || {};
      return {
        model: args.model, sync: !!sch.sync, missing: !!sch.missing, price: m ? m.pricingDesc.slice(0, 300) : "",
        required: (sch.input && sch.input.required) || [],
        fields: Object.entries(props).map(([k, p]) => ({ name: k, type: p.type, enum: p.enum, default: p.default, min: p.minimum, max: p.maximum, desc: String(p.description || "").replace(/\s+/g, " ").slice(0, 140) })),
      };
    }
    case "kie_generate": {
      const kieStudio = require("./kie");
      // Validation AVANT de lancer : une erreur de paramètres revient tout de suite (avec la liste des champs), pas 20 s plus tard
      const sch = await kieStudio.schema(args.model, false);
      if (sch.missing) throw new Error("Modèle inconnu ou sans schéma : " + args.model + " — vérifie l'identifiant avec kie_catalog.");
      if (sch.sync) throw new Error("Ce modèle est un modèle de chat (synchrone), pas de génération média.");
      kieStudio.normalizeInput(sch, args.input || {});
      const job = startJob("Kie : " + args.model, async () => {
        const j = await kieStudio.createJob({ model: args.model, input: args.input || {} });
        const deadline = Date.now() + 40 * 60 * 1000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 5000));
          const cur = kieStudio.getJob(j.id);
          if (!cur) throw new Error("Job Kie introuvable");
          if (cur.status === "failed") throw new Error(cur.error || "Génération échouée");
          if (cur.status === "done") return { files: cur.files.map((f) => ({ type: f.type, url: f.rel ? "/media/" + f.rel : f.url, rel: f.rel, title: f.title, excerpt: f.excerpt })), credits: cur.credits, usd: cur.usd };
        }
        throw new Error("Délai dépassé");
      });
      return { jobId: job.id, status: "running", note: "Génération Kie lancée ; les fichiers arriveront automatiquement (aussi visibles dans Kie Studio et Mes fichiers)." };
    }
    case "notify_telegram": {
      if (!args.file) {
        if (!args.text) throw new Error("Rien à envoyer : donne `text` et/ou `file`");
        const r = await telegram.send(String(args.text).slice(0, 3800));
        if (!r.ok) throw new Error("Telegram : " + r.error);
        return { ok: true, sent: "texte" };
      }
      // Fichier : 'dernier' (dernier généré), URL /media/… ou chemin rel
      let rel = String(args.file);
      if (/^(dernier|derni[eè]re|last|latest)$/i.test(rel)) {
        const recent = await runTool("recent_files", { type: args.type, limit: 1 });
        if (!recent.files.length) throw new Error("Aucun fichier généré récent" + (args.type ? " de type " + args.type : ""));
        rel = recent.files[0].rel;
      }
      const m = /^(?:https?:\/\/(?:localhost|127\.0\.0\.1):\d+)?\/media\/(.+)$/i.exec(rel);
      if (m) rel = decodeURIComponent(m[1]);
      const full = require("./files").resolveLocal(rel);
      if (!full) throw new Error("Fichier introuvable : " + rel + " — utilise recent_files pour obtenir son chemin.");
      const ext = path.extname(full).toLowerCase();
      const kind = /\.(png|jpe?g|webp)$/.test(ext) ? "photo" : /\.(mp4|mov|webm)$/.test(ext) ? "video" : "document";
      const r = await telegram.sendFile(kind, full, args.text ? String(args.text).slice(0, 1000) : "");
      if (!r.ok) throw new Error("Telegram : " + r.error);
      return { ok: true, sent: kind, file: rel };
    }

    case "set_voice": {
      const cfg = patchConfig({ voice: args.voice });
      return { ok: true, voice: cfg.voice, label: VOICE_LABELS[cfg.voice] || cfg.voice, note: "Voix enregistrée : elle sera utilisée à la prochaine activation (désactiver puis réactiver Jarvis)." };
    }
    case "remember":
      return { ok: true, total: remember(args.fact) };
    case "forget":
      return { ok: true, removed: forget(args.match) };
    case "program_get":
      return program(args.date);
    case "program_set":
      return setProgram(args.date, args.items, { append: !!args.append });
    case "program_done":
      return toggleProgramItem(args.date, args.match, args.done);

    case "computer_open": {
      const target = String(args.target || "").trim();
      if (!target) throw new Error("Cible vide");
      const ALIAS = { vscode: "code", "vs code": "code", chrome: "chrome", navigateur: "brave", browser: "brave", explorateur: "explorer", bloc: "notepad", "bloc-notes": "notepad", calculatrice: "calc", terminal: "wt", powershell: "powershell", paramètres: "ms-settings:", settings: "ms-settings:" };
      // Telegram : application de bureau si installée, sinon la fenêtre Telegram déjà ouverte (Web), sinon Telegram Web
      if (/^telegram( desktop| web)?$/i.test(target)) {
        const exe = path.join(process.env.APPDATA || "", "Telegram Desktop", "Telegram.exe");
        if (fs.existsSync(exe)) { await ps(`Start-Process ${q(exe)}; Write-Output OK`, { timeoutMs: 20000 }); return { ok: true, opened: "Telegram Desktop" }; }
        try { const w = await py(["focus", "Telegram"]); return { ok: true, opened: "fenêtre existante", title: w.title }; } catch {}
        await ps(`Start-Process 'https://web.telegram.org/'; Write-Output OK`, { timeoutMs: 20000 });
        return { ok: true, opened: "Telegram Web" };
      }
      const t = ALIAS[target.toLowerCase()] || target;
      const r = await ps(
        `try { if (${q(args.args || "")} -ne '') { Start-Process -FilePath ${q(t)} -ArgumentList ${q(args.args || "")} } else { Start-Process ${q(t)} }; Write-Output 'OK' } catch { Write-Output ('ERR ' + $_.Exception.Message) }`,
        { timeoutMs: 20000 }
      );
      if (/^ERR/.test(r.stdout)) throw new Error("Impossible d'ouvrir « " + target + " » : " + r.stdout.slice(4));
      return { ok: true, opened: t };
    }
    case "computer_windows": {
      const action = args.action || "list";
      if (action === "list") {
        const r = await py(["windows"]);
        return { windows: r.windows.map(({ hwnd, ...w }) => w) };
      }
      if (!args.title) throw new Error("title requis");
      return py([action, args.title]);
    }
    case "computer_screenshot": {
      const shot = await screenshot({ screen: args.screen || "primary" });
      const description = await describeImage(shot.file, args.question ? `Question : ${args.question}\n\nRéponds en français, précisément. Si on te demande de localiser un élément, donne ses coordonnées approximatives (x, y) en pixels dans CETTE image (${shot.savedSize}).` : undefined);
      return { description, image: "/media/" + shot.rel, imageSize: shot.savedSize, screenSize: shot.realSize, scale: shot.scale, note: "Pour cliquer : x_écran = x_image × scale (idem y)." };
    }
    case "computer_type": {
      const text = String(args.text || "");
      const escaped = text.replace(/([+^%~(){}\[\]])/g, "{$1}");
      const r = await ps(`Start-Sleep -Milliseconds 150; [System.Windows.Forms.SendKeys]::SendWait(${q(escaped + (args.enter ? "{ENTER}" : ""))}); Write-Output OK`, { forms: true, timeoutMs: 30000 });
      if (r.stdout !== "OK") throw new Error("Frappe impossible : " + (r.stderr || r.stdout).slice(0, 200));
      return { ok: true, typed: text.length };
    }
    case "computer_keys": {
      const r = await ps(`Start-Sleep -Milliseconds 150; [System.Windows.Forms.SendKeys]::SendWait(${q(args.keys)}); Write-Output OK`, { forms: true, timeoutMs: 20000 });
      if (r.stdout !== "OK") throw new Error("Raccourci impossible : " + (r.stderr || r.stdout).slice(0, 200));
      return { ok: true, keys: args.keys };
    }
    case "computer_click": {
      const x = Math.round(Number(args.x)), y = Math.round(Number(args.y));
      return py(["click", x, y, ...(args.button === "right" ? ["right"] : []), ...(args.double ? ["double"] : [])]);
    }
    case "computer_run": {
      const r = await ps(String(args.command || ""), { timeoutMs: Math.min(600, Number(args.timeoutSec) || 90) * 1000 });
      return { code: r.code, stdout: compact(r.stdout, 6000), stderr: compact(r.stderr, 1500) };
    }
    case "read_file": {
      const p = path.isAbsolute(args.path) ? args.path : path.join(PROJECT_ROOT, args.path);
      if (!fs.existsSync(p)) throw new Error("Fichier introuvable : " + p);
      const st = fs.statSync(p);
      if (st.size > 5 * 1024 * 1024) throw new Error("Fichier trop volumineux");
      return { path: p, size: st.size, content: compact(fs.readFileSync(p, "utf8"), args.maxChars || 6000) };
    }
    case "list_dir": {
      const p = path.isAbsolute(args.path) ? args.path : path.join(PROJECT_ROOT, args.path);
      const entries = fs.readdirSync(p, { withFileTypes: true }).slice(0, 200).map((e) => {
        let size = null;
        try { if (e.isFile()) size = fs.statSync(path.join(p, e.name)).size; } catch {}
        return { name: e.name, type: e.isDirectory() ? "dir" : "file", size };
      });
      return { path: p, entries };
    }
    default:
      throw new Error("Outil inconnu : " + name);
  }
}

// ---------- Persona & contexte ----------
function buildInstructions(ctx = {}) {
  const now = new Date();
  const date = now.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const time = now.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  const mem = memory();
  const prog = program();
  // Chaque appel repart de ZÉRO. Seule exception : une reconnexion en plein appel (coupure réseau) reçoit
  // les échanges de CET appel (ctx.since = début de l'appel), pour ne pas perdre le fil.
  const recent = ctx.resume && ctx.since ? readJSON("jarvis-log.json", []).filter((l) => l.ts >= ctx.since).slice(-14) : [];
  let channels = [];
  try { channels = require("./google").channels().map((c) => c.title); } catch {}
  const cfg = config();
  const tu = cfg.address === "tu";
  const STYLE_RULES = {
    direct: [
      "- MODE DIRECT. Une phrase par réponse, deux au grand maximum. Va droit au but.",
      "- Zéro formule de politesse, zéro reformulation de la demande, zéro annonce du type « je m'en occupe » ou « laissez-moi… » : exécute l'outil TOUT DE SUITE, puis donne le résultat en une phrase.",
      "- Pas de « Monsieur » (au plus une fois par session, jamais systématique). Pas de commentaire sur ce que tu vas faire, pas de récapitulatif, pas de proposition de suite sauf si elle est vraiment utile.",
      "- Quand tu affiches une fenêtre, dis juste l'essentiel (« Affiché. » ou le chiffre clé) — la fenêtre parle d'elle-même.",
    ],
    normal: [
      "- Réponses COURTES (1 à 3 phrases) : c'est de la voix. Pas de listes lues à voix haute.",
      `- ${tu ? "Tutoie Alex" : "Vouvoie Alex et appelle-le « Monsieur » de temps en temps (pas à chaque phrase)"}. Ton calme et précis, une pointe d'humour pince-sans-rire.`,
    ],
    detaille: [
      "- Réponses développées quand c'est utile (3 à 5 phrases), toujours structurées, sans jamais lire de listes ni d'URL.",
      `- ${tu ? "Tutoie Alex" : "Vouvoie Alex, « Monsieur » avec parcimonie"}. Ton de majordome brillant, chaleureux et précis.`,
    ],
  };

  return [
    "# IDENTITÉ",
    `Tu es JARVIS, l'assistant personnel d'Alex (inspiré de l'IA de Tony Stark : calme, précis, loyal, efficace). Tu ${tu ? "tutoies" : "vouvoies"} Alex. Tu parles TOUJOURS en français, naturel — jamais robotique, jamais bavard.`,
    "Tu es intégré à Agentic OS (http://localhost:4200), la plateforme locale d'Alex : usines à contenu IA pour YouTube/TikTok (machines Time Travel, Linguistique, Musique, Story Family, Stickman, POV, Wealth, Data Ranking, Fruits), chaînes YouTube connectées, Miniature Creator et Kie Studio (Kie.ai), Niche Finder, Scrap-o-matic, Banque de niches, Tâches & Cron, Calendrier de publication, second cerveau Obsidian (coffre « Test formation » + graphe Graphify), Chat Claude Code, Chat Hermès, Telegram, Google Drive, coffre de credentials.",
    "Tu as les pleins pouvoirs sur cette plateforme — et sur rien d'autre : tu peux tout lire, tout afficher, tout lancer, tout piloter dans Agentic OS, avec ses outils. Tu connais le système par cœur et tu accompagnes Alex dans tout ce qu'il veut y faire.",
    "",
    "# OÙ TU VIS",
    "- Tu es l'OVERLAY plein écran d'Agentic OS : Alex te parle, et tout ce que tu montres s'ouvre dans des fenêtres de l'appel — show_window pour un résultat (tableau, chiffres, liste, image), open_page pour une page de la plateforme embarquée (machine, banque, chaînes, Kie Studio…). Alex travaille DEPUIS l'appel, il ne quitte jamais l'overlay. Ne lui dis jamais d'aller sur le site : ouvre-le-lui ici.",
    "- Tu VOIS une fenêtre ouverte avec page_read et tu AGIS dedans avec page_act (cliquer, remplir, changer d'onglet) exactement comme Alex le ferait à la souris.",
    "- Les rapports (stats de chaîne, concurrents, plan de run) s'affichent tout seuls dans une fenêtre dès que l'outil répond.",
    "",
    "# TU ES LE GARDIEN D'AGENTIC OS — RIEN D'AUTRE",
    "- Ton périmètre, c'est cette plateforme et ses outils. Pas de miracle, pas de promesse que tes outils ne tiennent pas, pas de connaissance générale déguisée en fonctionnalité.",
    "- JAMAIS D'INVENTION : pas de sujet, de thème, d'idée, de paramètre, de chiffre, de résultat ni de fonctionnalité sortis de ton imagination. Une idée de vidéo vient de machine_idea (tu la rapportes telle quelle) ; un chiffre vient d'un outil ; un paramètre vient de machine_info ; un fait du projet vient du second cerveau.",
    "- Quand Alex nomme un outil, une page, une machine, une niche ou un mot que tu ne rattaches pas AVEC CERTITUDE à un outil : platform_lookup {query: ses mots} — le lexique te dit ce que c'est et quoi faire. Si ça ne tranche pas, pose UNE question courte (« tu parles de la machine Musique ou de Kie Studio ? »). Tu ne devines pas, tu ne supposes pas.",
    "- Repères : « niche musique », « machine musique » = la machine Musique (ses idées = machine_idea {machine:'musique'}, sa niche en banque = niche_bank {machine:'musique'}) ; « niche POV » = la machine POV, etc. « La banque » = Banque de niches. « Le scrap » = Scrap-o-matic. « Les chaînes » = page Chaînes / channel_stats. « Le studio », « Kie » = Kie Studio. « Le cerveau » = Second Cerveau. « Le labo » = Labo de niche.",
    "- Si un outil échoue ou renvoie vide, dis-le tel quel (« la machine Musique n'a renvoyé aucune idée ») et propose la suite logique ; ne comble jamais avec une supposition.",
    "",
    "# VOIX",
    "- " + VOICE_STYLE,
    "",
    "# STYLE VOCAL",
    ...(STYLE_RULES[cfg.style] || STYLE_RULES.direct),
    "- Pas d'URL prononcées, pas de markdown dans ce que tu dis.",
    "- Tous les montants de la plateforme sont en DOLLARS US ($), jamais en euros.",
    "- Après open_page, page_act, niche_bank, channel_stats, competitor_videos ou machine_run, la fenêtre concernée montre déjà le résultat : n'ajoute PAS de fenêtre récapitulative (show_window), dis l'essentiel en une phrase.",
    "- Ouvrir une machine = open_page avec SON identifiant (pov, wealth, timetravel, linguistique, musique, storyfamily, stickman, datarank), jamais la page « machines ». Stock d'une machine = machine_runs {action:'stock'} ; runs = {action:'list'}.",
    "- Quand tu as des données, des chiffres, une recherche, un programme : AFFICHE-LES (show_window) et commente l'essentiel en une phrase. Les fenêtres sont le prolongement de ta voix.",
    "- Ne dis jamais à Alex d'aller quelque part lui-même : ouvre-le-lui (open_page), clique pour lui (page_act), prépare et lance pour lui (machine_run).",
    "- Enchaîne sans demander pour tout ce qui est réversible (naviguer, lire, afficher, chercher). Pour une action payante ou irréversible (créer une vidéo, publier, supprimer, fermer une application avec travail non sauvegardé) : questions utiles puis confirmation explicite.",
    "- Si un outil échoue, dis-le en une phrase et propose une alternative. Ne prétends jamais avoir fait quelque chose que tu n'as pas fait.",
    "- Tâche longue (Claude, image, vidéo) : lance-la, dis en quelques mots qu'elle tourne, et commente le résultat quand il arrive (message [RÉSULTAT JOB]) en l'affichant dans une fenêtre si utile.",
    "- Si Alex parle d'autre chose ou te coupe, suis-le.",
    cfg.persona ? "\n# CONSIGNES PERSONNALISÉES D'ALEX (prioritaires)\n" + cfg.persona.trim() : "",
    "",
    "# TU AS ACCÈS À TOUTE LA PLATEFORME — CARTE",
    "- Pilotage : Dashboard (stats YouTube par chaîne et période, dépenses par API/machine), Tâches & Cron (tâches, crons Telegram, crons Hermès), Calendrier de publication (plans, événements), Architecture.",
    "- Intelligence : Chat Claude Code, Chat Hermès, Second Cerveau (notes + graphe), Niche Finder (recherche d'outliers YouTube), Scrap-o-matic (chaînes/vidéos scrappées, transcripts, analyses vision), Banque de niches (chaînes concurrentes par niche, reliées aux machines), Labo de niche.",
    "- Production : 8 machines (runs, idées, réglages, personnages/avatars/styles/familles, stock, publication YouTube, miniatures, textes SEO), Chaînes YouTube (stock, restock, publication), Miniature Creator, Kie Studio (218 modèles), Mes fichiers (local + Drive). OS TikTok : scraper, banque d'histoires, machine Fruits.",
    "- Système : Connexions (santé des services), Paramètres (coffre de credentials : tu ne vois que des aperçus masqués, clés YouTube/Apify, Google OAuth).",
    "- Hors plateforme : Internet (web_search), l'ordinateur d'Alex (applications, fenêtres, écran, clavier, souris, PowerShell, fichiers), Telegram (texte et fichiers).",
    "",
    "# RÉPONSE À TOUT — ORDRE DE RECOURS (obligatoire)",
    "1. L'outil dédié s'il existe (machine_*, channel_stats, niche_bank, competitor_videos, kie_*, brain_*, recent_files, platform_overview…).",
    "2. Sinon : api_routes (trouve la route) puis agentos_api (appelle-la). Toute donnée et toute action de la plateforme passent par une route.",
    "3. Sinon, ou pour montrer : open_page, puis page_read (tu VOIS la page) et page_act (tu cliques, remplis, changes d'onglet comme Alex).",
    "4. Sinon : ask_claude (code, fichiers, analyses longues), web_search (Internet), computer_* (le PC).",
    "Avant 1 : si tu n'es pas sûr de ce qu'Alex désigne → platform_lookup, puis une question si besoin. INTERDIT de répondre « je ne peux pas », « je n'ai pas accès » ou « faites-le vous-même » sans avoir essayé 2 ET 3. Si une étape échoue, essaie la suivante, puis dis précisément ce qui bloque.",
    "Quand Alex travaille dans une fenêtre et dit « ici », « cette machine », « cette page » : c'est la fenêtre au premier plan (page_read sans id te dit laquelle).",
    "",
    "# OUTILS — RÈGLES",
    "- DERNIÈRES VIDÉOS / ACTUALITÉ DES CONCURRENTS (« regarde ce que sortent mes concurrents », « compte-rendu de la niche », « tu es à jour ? ») : competitor_videos {machine} — il rescrape seul ce qui est périmé et te renvoie le rapport. Pas de question préalable : « cette niche » = la machine ouverte.",
    "- SUIVI (obligatoire) : tu ne dis JAMAIS « relancez-moi », « revenez plus tard » ou « je ne surveille pas ». Les résultats des tâches longues t'arrivent tout seuls ([RÉSULTAT JOB] pour ce que tu lances, [SUIVI] pour les runs et tâches de la plateforme) : dis « je vous préviens dès que c'est prêt », puis annonce-les dès réception. Si Alex demande où ça en est : job_status ou machine_runs status.",
    "- Chaînes concurrentes / niche d'une machine : niche_bank {machine} (la fenêtre Banque s'ouvre sur la niche). Détail d'une chaîne : niche_bank {machine, channel}.",
    "- Questions d'actualité, faits récents, prix, docs : web_search (puis fenêtre avec le résumé + liens).",
    "- Projet, décisions passées, notes, workflows n8n, APIs : brain_search / brain_read / brain_graph ; prise de notes : brain_write.",
    "- État de la plateforme : platform_overview ; toute action sur la plateforme : agentos_api (GET pour lire, POST/PATCH pour agir). Les routes machines : /api/machines/<id>, /runs, /idea, /stock, /runs/<runId>/(validate|cancel|resume|publish).",
    "- ROUTES FRÉQUENTES (agentos_api direct, sans api_routes) : dépenses GET /api/spend (lis `summary`) ; chaînes YouTube et abonnés GET /api/channels/overview ; vidéos programmées / calendrier de publication GET /api/schedule (events = publications datées, plans = récurrences) ; tâches GET /api/tasks ; Scrap-o-matic GET /api/scrap/list ; chercher une chaîne YouTube GET /api/scrap/search-channels body {q:'nom'} puis POST /api/scrap/add {type:'channel', item:<résultat choisi>} puis POST /api/scrap/channel/<channelId>/scrape.",
    "- NICHE FINDER (trouver de nouvelles niches / vidéos qui surperforment sur YouTube) : agentos_api POST /api/niche/search body {keywords:['mot-clé 1','mot-clé 2'], minViews, maxSubs, publishedAfter:'AAAA-MM-JJ', minDurationMin} → renvoie un job ; résultat : GET /api/niche/job/<id>, puis open_page 'niche'. Historique : GET /api/niche/history.",
    "- PERSONNAGES, AVATARS, STYLES d'une machine : voir l'existant avec machine_info ; créer, régénérer ou supprimer = api_routes '<id de la machine>' (liste TOUTES ses routes : characters, cast pour Stickman, avatars pour Wealth, styles pour Musique, regen de scène, texts SEO…) puis agentos_api — ou open_page de la machine, onglet Paramètres, puis page_act. Ce n'est JAMAIS machine_run.",
    "- UN RUN EXISTANT (miniature, scène, textes SEO, publication) : c'est la route du run, jamais generate_image ni kie_generate. Miniature : POST /api/machines/<machine>/runs/<runId>/thumbnail {instructions}. Publication : …/runs/<runId>/publish (confirmation d'Alex avant). Le reste : api_routes '<machine> runs', ou open_page de la machine avec run=<runId> puis page_act sur le bouton.",
    "- Développement, modifications de code, enquêtes complexes, pipelines : ask_claude (asynchrone). Agent autonome / crons : ask_hermes.",
    "- MACHINES (Time Travel, Linguistique, Musique, Story Family, Stickman, POV, Wealth, Data Ranking) : dès qu'Alex parle d'une machine — idée, paramètres, lancer/suivre/valider un run — utilise UNIQUEMENT machine_idea / machine_run / machine_info / machine_settings / machine_runs. INTERDIT d'utiliser kie_generate, generate_image ou agentos_api pour produire une vidéo : c'est la machine qui la produit.",
    "- LANCER UNE CRÉATION = ACCOMPAGNEMENT OBLIGATOIRE, en trois temps, même si Alex dit « lance » : (1) machine_run {machine, theme?, params?} → tu reçois un PLAN (ce qui manque, réglages résolus, devis) ; rien n'est lancé. (2) Tu accompagnes, UNE question courte à la fois : s'il manque le sujet, demande-le (ou propose une idée avec machine_idea, ou pickIdea:true s'il te laisse choisir) ; puis propose les réglages principaux en une phrase (« 5 minutes, en anglais, voix Malcolm, sous-titres, semi-manuel : on garde ça ? ») et ajuste avec machine_run {planId, params} à chaque réponse. (3) Quand readyToLaunch : récapitule en une phrase avec le devis et demande « on lance ? ». SEULEMENT après un oui explicite d'Alex : machine_run {machine, planId, confirm:true}. INTERDIT d'inventer un sujet (« vidéo Stickman » n'est PAS un sujet), INTERDIT de confirmer sans le oui d'Alex : le serveur refuse de toute façon un lancement sans plan validé. Pour comprendre un paramètre : machine_info.",
    "- APRÈS LE LANCEMENT : la page du run s'affiche toute seule. En mode semi-manuel, chaque étape attend une validation : un message [SUIVI] te prévient (« attend la validation d'Alex ») → dis ce qu'il y a à vérifier et propose de valider (machine_runs validate). Tu suis le run sans qu'Alex te relance.",
    "- RÈGLE GÉNÉRALE D'ACCOMPAGNEMENT : tout ce qui coûte de l'argent ou n'est pas réversible (créer une vidéo, publier, scraper en masse, générer avec Kie, envoyer sur Telegram, supprimer) → tu poses les questions utiles et tu demandes confirmation avant d'agir. Tout ce qui est lecture, navigation, affichage → tu le fais immédiatement, sans demander.",
    "- STATS / RAPPORT D'UNE CHAÎNE (« comment va ma chaîne », « les stats de The French Speaker », « combien de vues cette semaine », « rapport du mois ») : channel_stats {channel, period} — le rapport s'affiche tout seul ; dis les 3 chiffres clés et ce qui ressort (vues, abonnés, dernière vidéo, tendance). Si Alex veut voir le détail : open_page 'dashboard' ou open_page 'channels' avec open=<channelId>. Impressions, CTR, durée de visionnage : l'API Google ne les donne pas, dis-le simplement.",
    "- GÉNÉRATION (règles strictes) : UN SEUL appel de génération par demande — generate_image pour une image simple ; kie_generate pour un modèle précis ou pour vidéo/musique/voix (kie_catalog puis kie_schema si tu ne connais pas les champs). Jamais generate_image ET kie_generate pour la même image.",
    "- Le média généré s'affiche AUTOMATIQUEMENT dans une fenêtre dès qu'il est prêt : n'appelle PAS show_window pour le montrer.",
    "- RÉUTILISER un fichier généré (« anime cette image », « l'image que je viens de faire » → vidéo, extension audio…) : prends son chemin `rel` (donné dans le résultat du job, sinon recent_files) et passe {\"rel\": \"<chemin>\"} dans le champ fichier du modèle (image_url, image_urls, video_url…). JAMAIS une URL /media/ (Kie ne lit pas localhost). Modèle image→vidéo économique : bytedance/v1-lite-image-to-video ; qualité : kling/v2-1-master-image-to-video.",
    "- open_page 'kie' si Alex veut choisir lui-même dans Kie Studio.",
    "- Ordinateur : computer_open (apps, URLs, dossiers), computer_windows (lister/focus/réduire/fermer), computer_screenshot (voir l'écran), computer_type / computer_keys / computer_click (agir), computer_run (PowerShell). Pour une action visuelle incertaine : capture d'écran AVANT et APRÈS.",
    "- Mémoire : remember pour toute préférence/instruction durable. Programme du jour : program_get / program_set / program_done (affiche-le avec un bloc 'table' colonnes Priorité / Tâche, ou 'checklist').",
    "- open_page pour toute page/outil/machine de la plateforme (fenêtre embarquée) ; window_control pour ranger (minimize), agrandir ou remettre une fenêtre ; close_window pour fermer. Si Alex veut changer ta voix : set_voice (effective au prochain appel, préviens-le ; conseille cedar ou marin).",
    "",
    "# CONTEXTE",
    `- Date : ${date}, ${time} (Europe/Paris).`,
    channels.length ? `- Chaînes YouTube connectées : ${channels.join(", ")}.` : "- Aucune chaîne YouTube connectée pour l'instant.",
    ctx.page ? `- Page du site ouverte derrière l'appel : ${ctx.page}.` : "",
    prog.items.length ? `- Programme du jour : ${prog.items.map((i) => `${i.priority} ${i.text}${i.done ? " (fait)" : ""}`).join(" · ")}.` : "- Aucun programme défini pour aujourd'hui.",
    mem.length ? "# MÉMOIRE (faits durables)\n" + mem.slice(-60).map((m) => "- " + m.fact).join("\n") : "",
    recent.length ? "# ÉCHANGES DE CET APPEL AVANT LA COUPURE RÉSEAU (contexte seulement : n'entreprends rien de toi-même)\n" + recent.map((l) => `${l.role === "user" ? "Alex" : l.role === "assistant" ? "Jarvis" : "Système"} : ${l.text.slice(0, 220)}`).join("\n") : "",
    "",
    "# OUVERTURE",
    cfg.style === "direct"
      ? "Au tout début de la session, dis seulement deux ou trois mots (« Je vous écoute. », « Oui ? », « Prêt. ») puis attends."
      : "Au tout début de la session, salue brièvement (une phrase, variée, naturelle) puis attends.",
  ].filter(Boolean).join("\n");
}

/** Clé éphémère + configuration de session (le navigateur se connecte en WebRTC). */
async function createSession(ctx = {}) {
  const cfg = config();
  const session = {
    type: "realtime",
    model: ctx.model || cfg.realtimeModel,
    instructions: buildInstructions(ctx),
    audio: {
      input: {
        transcription: { model: cfg.transcribeModel, language: "fr" },
        noise_reduction: { type: "near_field" },
        turn_detection: { type: "semantic_vad", eagerness: cfg.eagerness, create_response: true, interrupt_response: true },
      },
      output: { voice: ctx.voice || cfg.voice, speed: Number(cfg.speed) || 1 },
    },
    tools: TOOLS.map(({ client, ...t }) => t),
    tool_choice: "auto",
    max_output_tokens: "inf",
  };
  // Le réseau du poste coupe par moments (ECONNRESET, ENOTFOUND) : trois essais espacés avant d'abandonner
  let resp, last;
  for (let a = 1; a <= 3; a++) {
    try {
      resp = await openaiPost("/v1/realtime/client_secrets", { expires_after: { anchor: "created_at", seconds: 900 }, session }, { timeoutMs: 30000 });
      break;
    } catch (e) {
      last = e;
      if (!/ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|délai|socket|network/i.test(e.message) || a === 3) throw e;
      await new Promise((r) => setTimeout(r, a * 1500));
    }
  }
  if (!resp || !resp.value) throw last || new Error("OpenAI : pas de clé éphémère renvoyée");
  return {
    clientSecret: resp.value,
    expiresAt: resp.expires_at,
    model: session.model,
    voice: session.audio.output.voice,
    transport: cfg.transport || "auto",
    clientTools: CLIENT_TOOLS,
    toolNames: TOOLS.map((t) => t.name),
  };
}

function status() {
  const cfg = config();
  return {
    configured: configured(),
    model: cfg.realtimeModel,
    textModel: cfg.textModel,
    voice: cfg.voice,
    speed: cfg.speed,
    eagerness: cfg.eagerness,
    style: cfg.style,
    address: cfg.address,
    persona: cfg.persona,
    voices: VOICES,
    models: MODELS,
    memory: memory().length,
    runningJobs: Object.values(jobs).filter((j) => j.status === "running").length,
    sseClients: sseClients.size,
  };
}

module.exports = {
  configured,
  config,
  fullConfig,
  patchConfig,
  status,
  createSession,
  runTool,
  sseHandler,
  push,
  jobStatus,
  log,
  recentLog,
  memory,
  program,
  setProgram,
  TOOLS,
  CLIENT_TOOLS,
  voicePreview,
  VOICES,
  VOICE_LABELS,
  // exposés pour les tests
  webSearch,
  brainSearch,
  brainGraph,
  screenshot,
  describeImage,
  buildInstructions,
  MACHINE_SPEC,
};
