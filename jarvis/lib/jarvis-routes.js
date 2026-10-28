/**
 * Routes HTTP de Jarvis (assistant vocal temps réel) + boîte Telegram, isolées de server.js pour que
 * l'installation tienne en une ligne :
 *
 *   const jarvisRoutes = require("./lib/jarvis-routes");
 *   …dans le gestionnaire de requêtes, avant les autres routes /api :
 *   if (await jarvisRoutes.handle({ req, res, url, p, json, readBody })) return;
 *
 * `json(res, status, obj)` et `readBody(req)` sont les helpers de server.js d'Agentic OS.
 * Retourne true si la requête a été servie.
 */
const jarvis = require("./jarvis");

let telegram = null;
try { telegram = require("./telegram"); } catch { telegram = null; }

async function handle({ req, res, url, p, json, readBody }) {
  // ===== JARVIS (assistant vocal temps réel) =====
  if (p === "/api/jarvis/status") { json(res, 200, jarvis.status()); return true; }
  if (p === "/api/jarvis/config" && req.method === "GET") { json(res, 200, jarvis.fullConfig()); return true; }
  if (p === "/api/jarvis/config" && req.method === "PATCH") { jarvis.patchConfig(await readBody(req)); json(res, 200, jarvis.fullConfig()); return true; }
  if (p === "/api/jarvis/session" && req.method === "POST") {
    const b = await readBody(req).catch(() => ({}));
    try {
      json(res, 200, await jarvis.createSession(b));
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return true;
  }
  if (p === "/api/jarvis/tool" && req.method === "POST") {
    const b = await readBody(req);
    const t0 = Date.now();
    try {
      const result = await jarvis.runTool(b.name, b.args || {});
      console.log(`[jarvis] ${b.name} ok (${Date.now() - t0} ms)`);
      json(res, 200, { ok: true, result });
    } catch (e) {
      console.log(`[jarvis] ${b.name} ERREUR : ${e.message}`);
      json(res, 200, { ok: false, error: e.message });
    }
    return true;
  }
  if (p === "/api/jarvis/events") { jarvis.sseHandler(req, res); return true; }
  if (p === "/api/jarvis/log" && req.method === "POST") {
    const b = await readBody(req);
    if (b.text) jarvis.log(b.role || "assistant", b.text);
    json(res, 200, { ok: true });
    return true;
  }
  if (p === "/api/jarvis/log" && req.method === "GET") { json(res, 200, jarvis.recentLog(Number(url.searchParams.get("n")) || 40)); return true; }
  if (p === "/api/jarvis/job" && req.method === "GET") {
    const j = jarvis.jobStatus(url.searchParams.get("id"));
    if (j) json(res, 200, j); else json(res, 404, { error: "Job inconnu" });
    return true;
  }
  if (p === "/api/jarvis/memory") { json(res, 200, jarvis.memory()); return true; }
  if (p === "/api/jarvis/program") { json(res, 200, jarvis.program(url.searchParams.get("date"))); return true; }
  // Extrait audio d'une voix (mp3) pour l'essayer depuis les réglages avant de l'adopter
  if (p === "/api/jarvis/voice-preview") {
    try {
      const buf = await jarvis.voicePreview(url.searchParams.get("voice"), url.searchParams.get("text"));
      res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": buf.length, "Cache-Control": "no-store" });
      res.end(buf);
    } catch (e) {
      json(res, 500, { error: e.message });
    }
    return true;
  }

  // ===== Telegram (envoi + boîte de réception des réponses) — si lib/telegram.js les expose =====
  if (telegram && typeof telegram.inbox === "function" && p === "/api/telegram/inbox") {
    json(res, 200, { messages: telegram.inbox(url.searchParams.get("since") || null) });
    return true;
  }
  if (telegram && typeof telegram.send === "function" && p === "/api/telegram/send" && req.method === "POST") {
    const b = await readBody(req);
    json(res, 200, await telegram.send(String(b.text || "").slice(0, 3800)));
    return true;
  }
  return false;
}

module.exports = { handle };
