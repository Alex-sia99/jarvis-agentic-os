/**
 * JARVIS — client vocal temps réel (OpenAI Realtime, WebRTC).
 *
 * Flux :  bouton « Jarvis » → POST /api/jarvis/session (clé éphémère) → RTCPeerConnection vers
 *         OpenAI (audio bidirectionnel + canal « oai-events ») → événements JSON :
 *         sous-titres (transcriptions), appels d'outils (exécutés ici ou via /api/jarvis/tool),
 *         résultats de jobs asynchrones poussés par le serveur (SSE /api/jarvis/events).
 * UI :    overlay PLEIN ÉCRAN (cœur hexagonal animé par le niveau audio, style Rings du second cerveau),
 *         fenêtres flottantes (contenu OU pages de la plateforme embarquées en iframe `?embed=1`),
 *         dock des fenêtres réduites, liste des actions, sous-titres, saisie texte. Mode « mini » =
 *         widget réduit en bas à droite (bouton RÉDUIRE / Échap), le site reste visible.
 *         Alex travaille depuis l'appel : on ne quitte jamais l'overlay pour ouvrir une page.
 */
const Jarvis = (() => {
  const { api, toast, esc } = AgentOS;

  const S = {
    el: null, pc: null, dc: null, mic: null, audioEl: null, remote: null,
    state: "idle", // idle | connecting | live | listening | thinking | speaking
    mode: "full", // full (overlay) | mini (widget réduit)
    muted: false,
    connecting: false,
    connectSeq: 0,
    startedAt: 0,
    session: null,
    clientTools: new Set(),
    windows: new Map(),
    winCount: 0,
    tasks: [],
    responseActive: false,
    injectQueue: [],
    sse: null,
    jobTasks: new Map(),
    usage: { audioIn: 0, audioOut: 0, textIn: 0, textOut: 0, cachedIn: 0 },
    orb: null,
    sub: "",
    userHideTimer: null,
    ctx: null, anIn: null, anOut: null,
    textOpen: false,
    debug: false,
  };

  const PAGES = {
    dashboard: "Dashboard", tasks: "Tâches & Cron", calendar: "Calendrier", architecture: "Architecture",
    chat: "Chat Claude", hermes: "Chat Hermès", brain: "Second Cerveau", niche: "Niche Finder", scrap: "Scrap-o-matic",
    bank: "Banque de niches", machines: "Machines", timetravel: "Time Travel", linguistique: "Linguistique", musique: "Musique",
    storyfamily: "Story Family", stickman: "Stickman", pov: "POV", wealth: "Wealth", datarank: "Data Ranking",
    channels: "Chaînes", miniature: "Miniature Creator", kie: "Kie Studio", files: "Mes fichiers", tiktok: "Scrap-o-matic TikTok",
    ttbank: "Banque d'histoires", ttfruits: "Machine Fruits", connections: "Connexions", settings: "Paramètres",
  };

  // ────────────────────────────────────────────────────────────── DOM
  const ICON = {
    mic: `<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/></svg>`,
    kbd: `<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/></svg>`,
    hang: `<svg viewBox="0 0 24 24"><path d="M4 14c4-4 12-4 16 0l-2 3c-1 1-2 .6-3.2-.1l-.8-.6c-1.3-.8-2.7-.8-4 0l-.8.6C8 17.6 7 18 6 17l-2-3z"/></svg>`,
    expand: `<svg viewBox="0 0 24 24"><path d="M9 3H3v6M15 3h6v6M9 21H3v-6M15 21h6v-6"/></svg>`,
  };

  function build() {
    if (S.el) return;
    const el = document.createElement("div");
    el.id = "jarvis";
    el.hidden = true;
    el.dataset.mode = "full";
    el.dataset.state = "idle";
    el.innerHTML = `
      <div class="jv-bg"></div>
      <header class="jv-top">
        <div class="jv-brand">
          <div><div class="t"><span class="hx">&#11041;</span>JARVIS</div><div class="s">Agentic OS · assistant vocal</div></div>
        </div>
        <div class="jv-topright">
          <button class="jv-icon" id="jv-mini" title="Réduire en widget (le site reste visible)">⤡ RÉDUIRE</button>
          <button class="jv-icon" id="jv-gear" title="Ouvre Paramètres (voix, style, instructions) dans une fenêtre">⚙</button>
        </div>
      </header>
      <div class="jv-livebar"><span class="jv-live"><i></i>LIVE</span><span class="jv-timer" id="jv-timer">0:00</span><span class="jv-timer" id="jv-transport" title="Transport : RTC = WebRTC, WS = WebSocket"></span></div>
      <ol class="jv-tasks" id="jv-tasks"></ol>
      <div class="jv-stage" id="jv-stage"><canvas id="jv-orb"></canvas></div>
      <div class="jv-status" id="jv-status"></div>
      <div class="jv-windows" id="jv-windows"></div>
      <div class="jv-dock" id="jv-dock"></div>
      <div class="jv-captions" id="jv-captions"><div class="jv-user" id="jv-user"></div><div class="jv-sub" id="jv-sub"></div></div>
      <div class="jv-text" id="jv-text" hidden><input id="jv-input" placeholder="Écrire à Jarvis… (Entrée pour envoyer)" autocomplete="off"><button id="jv-send" title="Envoyer">➤</button></div>
      <div class="jv-controls" id="jv-controls">
        <button class="jv-ctl" id="jv-mic" title="Couper / réactiver le micro">${ICON.mic}</button>
        <button class="jv-ctl jv-ctl-acc" id="jv-kbd" title="Écrire au clavier">${ICON.kbd}</button>
        <button class="jv-ctl jv-ctl-red" id="jv-hang" title="Raccrocher">${ICON.hang}</button>
        <button class="jv-ctl" id="jv-expand" title="Plein écran">${ICON.expand}</button>
      </div>
      <audio id="jv-audio" autoplay></audio>`;
    document.body.appendChild(el);
    S.el = el;
    S.audioEl = el.querySelector("#jv-audio");

    el.querySelector("#jv-hang").addEventListener("click", () => close());
    el.querySelector("#jv-mic").addEventListener("click", toggleMic);
    el.querySelector("#jv-kbd").addEventListener("click", () => toggleText());
    el.querySelector("#jv-mini").addEventListener("click", () => setMode("mini"));
    el.querySelector("#jv-expand").addEventListener("click", () => setMode("full"));
    // Réglages : la page Paramètres (carte Jarvis) s'ouvre dans une fenêtre de l'appel — rien dans l'overlay lui-même
    el.querySelector("#jv-gear").addEventListener("click", () => openPage("settings", "", "Paramètres"));
    el.querySelector("#jv-send").addEventListener("click", sendTyped);
    el.querySelector("#jv-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); sendTyped(); }
      if (e.key === "Escape") toggleText(false);
    });
    S.orb = createOrb(el.querySelector("#jv-orb"));
  }

  // ────────────────────────────────────────────────────────────── Cœur (style Rings)
  function createOrb(canvas) {
    const g = canvas.getContext("2d");
    let raf = 0, level = 0, t0 = performance.now(), shift = 0.5;
    const rand = (() => { let s = 4242; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
    const COL = { orange: [232, 148, 74], violet: [167, 139, 250], teal: [82, 216, 200], grey: [122, 118, 144], ink: [232, 230, 240] };
    let cur = [...COL.orange];
    // 6 arcs de points (×2 rangées) autour du cœur : « égaliseur » piloté par la voix
    const arcs = [];
    for (let i = 0; i < 6; i++) {
      arcs.push({ a0: (i * Math.PI) / 3 + 0.12, span: Math.PI / 3 - 0.24, n: 12, r: 1.55, ph: rand() * 6, row: 0 });
      arcs.push({ a0: (i * Math.PI) / 3 + 0.16, span: Math.PI / 3 - 0.32, n: 10, r: 1.95, ph: rand() * 6, row: 1 });
    }
    const badges = Array.from({ length: 7 }, (_, i) => ({ a: (i / 7) * Math.PI * 2 + rand() * 0.3 }));
    const dots = Array.from({ length: 56 }, (_, i) => ({ a: (i / 56) * Math.PI * 2, s: 1 + rand() * 1.2 }));

    const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
    function hex(x, y, r, rot) {
      g.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (rot || 0) + (i * Math.PI) / 3;
        i ? g.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r) : g.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
      }
      g.closePath();
    }
    function resize() {
      const rect = canvas.parentElement.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const h = S.mode === "mini" ? 150 : rect.height;
      canvas.width = Math.max(1, rect.width * dpr);
      canvas.height = Math.max(1, h * dpr);
      canvas.style.height = h + "px";
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    function frame(now) {
      raf = requestAnimationFrame(frame);
      draw(now);
    }
    function draw(now) {
      const t = (now - t0) / 1000;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = canvas.width / dpr, H = canvas.height / dpr;
      const mini = S.mode === "mini";
      // Quand une page est ouverte en fenêtre (à droite), le cœur glisse vers la gauche pour rester visible
      const wantShift = !mini && hasPageWindow() ? 0.24 : 0.5;
      shift += (wantShift - shift) * 0.06;
      const cx = W * shift, cy = H / 2;
      const R = mini ? Math.min(W, H) * 0.14 : Math.max(20, Math.min(40, Math.min(W, H) * 0.045));
      const target = levelTarget();
      level += (target - level) * (target > level ? 0.4 : 0.09);
      const want = S.state === "listening" ? COL.violet : S.state === "thinking" ? COL.teal : S.state === "connecting" || S.state === "idle" ? COL.grey : COL.orange;
      for (let i = 0; i < 3; i++) cur[i] += (want[i] - cur[i]) * 0.07;
      const breathe = Math.sin(t * 1.5);

      g.clearRect(0, 0, W, H);
      // Halo central
      const halo = g.createRadialGradient(cx, cy, R * 0.4, cx, cy, R * 5.2);
      halo.addColorStop(0, rgba(cur, 0.16 + level * 0.3));
      halo.addColorStop(0.45, rgba(cur, 0.04));
      halo.addColorStop(1, rgba(cur, 0));
      g.fillStyle = halo;
      g.fillRect(0, 0, W, H);

      // Anneaux fins
      const rings = [
        { r: R * 2.45, c: rgba(cur, 0.16) },
        { r: R * 3.45, c: rgba(COL.violet, 0.11) },
        { r: R * 4.5, c: "rgba(255,255,255,0.06)" },
      ];
      g.lineWidth = 1;
      for (const rg of rings) { g.strokeStyle = rg.c; g.beginPath(); g.arc(cx, cy, rg.r, 0, Math.PI * 2); g.stroke(); }

      // Égaliseur : arcs de points lumineux
      for (const arc of arcs) {
        const rr = R * arc.r * (1 + level * 0.04);
        const wave = 0.6 + 0.4 * Math.sin(t * 2.6 + arc.ph);
        const lit = Math.round(arc.n * Math.min(1, 0.12 + level * 0.95 * wave));
        const col = arc.row ? COL.violet : cur;
        for (let i = 0; i < arc.n; i++) {
          const a = arc.a0 + (i / (arc.n - 1)) * arc.span + t * 0.05;
          const on = i < lit;
          g.fillStyle = on ? rgba(col, 0.92) : rgba(COL.ink, 0.1);
          g.beginPath();
          g.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, on ? 2.3 : 1.6, 0, Math.PI * 2);
          g.fill();
        }
      }

      // Anneau 1 : 12 nœuds hexagonaux, un nœud actif tourne
      const rot1 = t * 0.06;
      const active = Math.floor((t * 2.2) % 12);
      for (let i = 0; i < 12; i++) {
        const a = rot1 + (i / 12) * Math.PI * 2;
        const x = cx + Math.cos(a) * rings[0].r, y = cy + Math.sin(a) * rings[0].r;
        hex(x, y, i === active ? 5.5 + level * 2 : 4.2, a);
        g.fillStyle = i === active ? rgba(cur, 0.55) : "rgba(5,4,9,0.9)";
        g.fill();
        g.strokeStyle = i === active ? rgba(cur, 1) : rgba(COL.ink, 0.28);
        g.lineWidth = i === active ? 1.4 : 1;
        g.stroke();
      }
      // Anneau 2 : points + comète
      const rot2 = -t * 0.035;
      const comet = t * 0.7;
      for (const d of dots) {
        const a = d.a + rot2;
        const dist = ((a - comet) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
        const glow = dist < 0.9 ? (1 - dist / 0.9) : 0;
        g.fillStyle = rgba(glow ? cur : COL.ink, 0.14 + glow * 0.8);
        g.beginPath();
        g.arc(cx + Math.cos(a) * rings[1].r, cy + Math.sin(a) * rings[1].r, d.s * (1 + glow * 0.8), 0, Math.PI * 2);
        g.fill();
      }
      // Anneau 3 : badges hexagonaux
      const rot3 = t * 0.018;
      for (const b of badges) {
        const a = b.a + rot3;
        const x = cx + Math.cos(a) * rings[2].r, y = cy + Math.sin(a) * rings[2].r;
        hex(x, y, 7, 0);
        g.fillStyle = "rgba(5,4,9,0.95)";
        g.fill();
        g.strokeStyle = rgba(COL.ink, 0.22);
        g.lineWidth = 1;
        g.stroke();
        g.fillStyle = rgba(COL.ink, 0.3);
        g.beginPath();
        g.arc(x, y, 1.4, 0, Math.PI * 2);
        g.fill();
      }

      // Cœur hexagonal
      const core = R * (1 + 0.14 * level + 0.025 * breathe);
      g.save();
      g.shadowBlur = 26 + level * 48;
      g.shadowColor = rgba(cur, 0.95);
      hex(cx, cy, core, Math.PI / 6);
      g.fillStyle = "rgba(13,12,20,0.97)";
      g.fill();
      g.lineWidth = 1.6;
      g.strokeStyle = rgba(cur, 1);
      g.stroke();
      g.restore();
      hex(cx, cy, core * 1.28, -t * 0.25);
      g.lineWidth = 1;
      g.strokeStyle = rgba(cur, 0.25 + level * 0.3);
      g.stroke();
      const inner = g.createRadialGradient(cx - core * 0.15, cy - core * 0.15, 1, cx, cy, core * 0.5);
      inner.addColorStop(0, rgba(COL.ink, 0.95));
      inner.addColorStop(1, rgba(cur, 0.9));
      hex(cx, cy, core * (0.36 + level * 0.14), Math.PI / 6);
      g.fillStyle = inner;
      g.fill();

      // Libellé d'état (entre les anneaux 1 et 2) — overlay seulement
      const label = { connecting: "CONNEXION", listening: "ÉCOUTE", thinking: "RÉFLEXION", speaking: "PAROLE", live: "EN LIGNE", idle: "" }[S.state] || "";
      if (label && !mini) {
        g.font = "700 9px " + getComputedStyle(S.el).getPropertyValue("--jv-mono");
        g.letterSpacing = "4px";
        g.textAlign = "center";
        g.fillStyle = rgba(cur, 0.85);
        g.fillText(label, cx + 2, cy - R * 2.95);
      }
    }
    function levelTarget() {
      const rms = (an) => {
        if (!an) return 0;
        const buf = new Uint8Array(an.fftSize);
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        return Math.sqrt(sum / buf.length);
      };
      if (S.state === "speaking") return Math.min(1, rms(S.anOut) * 4.5);
      if (S.state === "listening") return Math.min(1, rms(S.anIn) * 3.5);
      if (S.state === "thinking") return 0.22 + 0.12 * Math.sin(performance.now() / 160);
      if (S.state === "connecting") return 0.12 + 0.08 * Math.sin(performance.now() / 300);
      return Math.min(0.3, rms(S.anIn) * 2);
    }
    return {
      start() { resize(); cancelAnimationFrame(raf); raf = requestAnimationFrame(frame); },
      stop() { cancelAnimationFrame(raf); raf = 0; },
      resize,
    };
  }
  window.addEventListener("resize", () => S.orb && S.el && !S.el.hidden && S.orb.resize());

  // ────────────────────────────────────────────────────────────── Session
  function setState(st) {
    S.state = st;
    if (S.el) S.el.dataset.state = st;
  }
  function setStatus(html) {
    const el = S.el && S.el.querySelector("#jv-status");
    if (el) el.innerHTML = html || "";
  }

  async function open() {
    build();
    if (connected() || S.connecting) { S.el.hidden = false; setMode("full"); return; }
    S.el.hidden = false;
    setMode("full");
    setState("connecting");
    S.sub = "";
    renderSub("");
    renderUser("");
    S.orb.start();
    S.connecting = true;
    S.reconnects = 0;
    const seq = ++S.connectSeq;
    try {
      await connect(seq);
    } catch (e) {
      if (seq !== S.connectSeq) return; // connexion abandonnée (raccroché pendant la négociation)
      console.error("[jarvis]", e);
      teardown();
      setState("idle");
      setStatus(`<span class="err">${esc(humanError(e))}</span><button id="jv-retry">Réessayer</button>`);
      S.el.querySelector("#jv-retry").addEventListener("click", () => { setStatus(""); open(); });
    } finally {
      if (seq === S.connectSeq) S.connecting = false;
    }
  }

  function humanError(e) {
    const m = String(e && e.message || e);
    if (/NotAllowedError|Permission denied|denied/i.test(m)) return "Micro refusé : autorise le micro pour localhost:4200 dans le navigateur (icône à gauche de l'adresse), puis réessaie.";
    if (/NotFoundError|Requested device not found/i.test(m)) return "Aucun micro détecté.";
    if (/Failed to fetch|NetworkError|aborted|délai/i.test(m)) return "OpenAI injoignable (réseau, bloqueur ou délai dépassé) : " + m;
    return m;
  }

  async function connect(seq) {
    const alive = () => seq === S.connectSeq && !!S.el;
    const deadline = (ms, label) => new Promise((_, rej) => setTimeout(() => rej(new Error("délai dépassé : " + label)), ms));

    setStatus("clé de session…");
    let session;
    for (let a = 1; a <= 3; a++) {
      try {
        session = await Promise.race([api("/api/jarvis/session", { method: "POST", body: { page: AgentOS.state.page, resume: S.reconnects > 0, since: S.reconnects > 0 && S.startedAt ? new Date(S.startedAt).toISOString() : null } }), deadline(25000, "clé de session")]);
        break;
      } catch (e) {
        if (!alive()) return;
        if (a === 3 || !/ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|délai|socket|network|Failed to fetch/i.test(e.message)) throw e;
        setStatus(`clé de session… (réseau, essai ${a + 1}/3)`);
        await new Promise((r) => setTimeout(r, a * 2000));
      }
    }
    if (!alive()) return;
    S.session = session;
    S.clientTools = new Set(session.clientTools || []);

    setStatus("micro…");
    const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (!alive()) { mic.getTracks().forEach((t) => t.stop()); return; }
    S.mic = mic;

    const transport = chooseTransport(session.transport);
    S.transport = transport;
    if (transport === "websocket") {
      await connectWS(seq, session, mic);
    } else {
      await connectRTC(seq, session, mic);
    }
    if (!alive()) return;
    afterConnect(session);
  }

  /** Choix du transport : réglage explicite, sinon WebRTC — ou WebSocket si le réseau s'est montré instable récemment. */
  function chooseTransport(pref) {
    if (pref === "webrtc" || pref === "websocket") return pref;
    try {
      const hint = JSON.parse(localStorage.getItem("jv-transport-hint") || "null");
      if (hint && hint.t === "websocket" && Date.now() - hint.ts < 7 * 86400e3) return "websocket";
    } catch {}
    return "webrtc";
  }
  function markUnstable(reason) {
    S.dropCount = (S.dropCount || 0) + 1;
    if (S.dropCount >= 3 && S.transport === "webrtc") {
      try { localStorage.setItem("jv-transport-hint", JSON.stringify({ t: "websocket", ts: Date.now(), reason })); } catch {}
      if (!S.unstableNotified) { S.unstableNotified = true; toast("Réseau instable : Jarvis passera en WebSocket (plus tolérant) au prochain appel", "ok"); }
    }
  }

  function afterConnect(session) {
    setStatus("");
    const recall = S.el.querySelector("#jv-recall");
    if (recall) recall.hidden = true;
    const resumed = S.reconnects > 0;
    S.lastConnectAt = Date.now();
    S.resumedSession = resumed;
    if (!resumed) { S.startedAt = Date.now(); S.usage = { audioIn: 0, audioOut: 0, textIn: 0, textOut: 0, cachedIn: 0 }; S.seenJobs = new Set(); }
    const tr = S.el.querySelector("#jv-transport");
    if (tr) tr.textContent = S.transport === "websocket" ? "WS" : "RTC";
    setState("live");
    startTimer();
    openSSE();
    // Ouverture : salutation SEULE, sans outil — jamais de reprise spontanée d'une tâche passée
    if (resumed) {
      send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text: "[SYSTÈME] Connexion rétablie après une coupure réseau (nouvelle session). Dis seulement, en quelques mots, que tu es de retour et que tu écoutes." }] } });
      send({ type: "response.create", response: { tool_choice: "none" } });
    } else {
      send({ type: "response.create", response: { tool_choice: "none", instructions: "Ouverture de session : dis UNIQUEMENT une très courte salutation (ex. « Je vous écoute. »), sans rien faire d'autre et sans reprendre un sujet passé." } });
    }
    S.responseActive = true;
  }

  // ── Transport WebRTC (UDP, latence minimale) ──
  async function connectRTC(seq, session, mic) {
    const alive = () => seq === S.connectSeq && !!S.el;
    const deadline = (ms, label) => new Promise((_, rej) => setTimeout(() => rej(new Error("délai dépassé : " + label)), ms));
    setStatus("négociation webrtc…");
    const pc = new RTCPeerConnection();
    S.pc = pc;
    pc.ontrack = (ev) => {
      S.remote = ev.streams[0];
      S.audioEl.srcObject = S.remote;
      S.audioEl.play().catch(() => {});
      setupAnalysers();
    };
    pc.addTrack(mic.getAudioTracks()[0], mic);
    // « disconnected » est un état TRANSITOIRE (perte de paquets passagère) qui revient souvent à
    // « connected » en quelques secondes : on ne raccroche que si ça ne revient pas, ou sur « failed ».
    let dropTimer = 0;
    pc.onconnectionstatechange = () => {
      if (S.debug) console.log("[jarvis] pc", pc.connectionState);
      if (S.pc !== pc) return;
      const st = pc.connectionState;
      if (st === "connected") { clearTimeout(dropTimer); dropTimer = 0; setStatus(""); return; }
      if (st === "failed") { reconnect("échec WebRTC"); return; }
      if (st === "disconnected" && !dropTimer) {
        markUnstable("webrtc disconnected");
        // L'étiquette n'apparaît que si ça dure (les micro-coupures de 1-2 s sont fréquentes et sans effet)
        setTimeout(() => { if (S.pc === pc && pc.connectionState === "disconnected") setStatus("connexion instable…"); }, 4000);
        dropTimer = setTimeout(() => {
          dropTimer = 0;
          if (S.pc === pc && pc.connectionState !== "connected") reconnect("connexion perdue");
        }, 10000);
      }
    };
    const dc = pc.createDataChannel("oai-events");
    S.dc = dc;
    dc.onclose = () => { if (S.debug) console.log("[jarvis] dc closed"); };
    dc.onerror = (e) => console.warn("[jarvis] dc error", e);
    dc.onmessage = (e) => { try { handleEvent(JSON.parse(e.data)); } catch (err) { console.warn("[jarvis] event", err); } };
    const opened = new Promise((res) => (dc.onopen = res));

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    let resp;
    try {
      resp = await fetch(`https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(session.model)}`, {
        method: "POST",
        body: offer.sdp,
        headers: { Authorization: `Bearer ${session.clientSecret}`, "Content-Type": "application/sdp" },
        signal: ctrl.signal,
      });
    } finally { clearTimeout(timer); }
    if (!resp.ok) throw new Error(`OpenAI ${resp.status} : ${(await resp.text()).slice(0, 200)}`);
    const answer = await resp.text();
    if (!alive() || S.pc !== pc || pc.signalingState === "closed") return;
    await pc.setRemoteDescription({ type: "answer", sdp: answer });

    setStatus("connexion…");
    await Promise.race([opened, deadline(20000, "canal de données")]);
  }

  // ── Transport WebSocket (TCP : tolère les pertes de paquets ; audio PCM16 24 kHz en base64) ──
  async function connectWS(seq, session, mic) {
    const alive = () => seq === S.connectSeq && !!S.el;
    setStatus("connexion websocket…");
    const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(session.model)}`, ["realtime", "openai-insecure-api-key." + session.clientSecret]);
    S.ws = ws;
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("délai dépassé : websocket")), 20000);
      ws.onopen = () => { clearTimeout(t); res(); };
      ws.onerror = () => { clearTimeout(t); rej(new Error("WebSocket OpenAI impossible (réseau ou clé)")); };
    });
    if (!alive()) { ws.close(); return; }
    ws.onmessage = (e) => { try { handleEvent(JSON.parse(e.data)); } catch (err) { console.warn("[jarvis] event", err); } };
    ws.onerror = (e) => console.warn("[jarvis] ws error", e);
    ws.onclose = (e) => {
      if (S.debug) console.log("[jarvis] ws closed", e.code, e.reason);
      if (S.ws === ws && !S.closingByUser) reconnect("websocket fermé (" + e.code + ")");
    };
    await startAudioPipeline(mic);
  }

  /** Capture micro → PCM16 24 kHz (AudioWorklet) ; lecture des deltas audio ; analyseurs pour le cœur. */
  async function startAudioPipeline(mic) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
    S.ctx = ctx;
    await ctx.resume();
    const code = `class PCMCapture extends AudioWorkletProcessor {
      constructor() { super(); this.buf = []; this.n = 0; }
      process(inputs) { const ch = inputs[0] && inputs[0][0]; if (!ch) return true;
        this.buf.push(new Float32Array(ch)); this.n += ch.length;
        if (this.n >= 1200) { const out = new Float32Array(this.n); let o = 0; for (const b of this.buf) { out.set(b, o); o += b.length; }
          this.port.postMessage(out, [out.buffer]); this.buf = []; this.n = 0; }
        return true; } }
      registerProcessor("pcm-capture", PCMCapture);`;
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: "application/javascript" })));
    const src = ctx.createMediaStreamSource(mic);
    const node = new AudioWorkletNode(ctx, "pcm-capture");
    const sink = ctx.createGain();
    sink.gain.value = 0;
    S.anIn = ctx.createAnalyser(); S.anIn.fftSize = 512;
    src.connect(S.anIn);
    src.connect(node);
    node.connect(sink);
    sink.connect(ctx.destination);
    node.port.onmessage = (e) => {
      if (S.muted || !S.ws || S.ws.readyState !== 1) return;
      S.ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: floatToB64(e.data) }));
    };
    S.anOut = ctx.createAnalyser(); S.anOut.fftSize = 512;
    S.anOut.connect(ctx.destination);
    S.playHead = 0;
    S.playing = [];
    S.worklet = node;
  }
  function floatToB64(f32) {
    const i16 = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) { const s = Math.max(-1, Math.min(1, f32[i])); i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
    const bytes = new Uint8Array(i16.buffer);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function playDelta(b64) {
    if (!S.ctx || !S.anOut) return;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const i16 = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
    const f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 0x8000;
    const buf = S.ctx.createBuffer(1, f32.length, 24000);
    buf.copyToChannel(f32, 0);
    const node = S.ctx.createBufferSource();
    node.buffer = buf;
    node.connect(S.anOut);
    const start = Math.max(S.ctx.currentTime + 0.03, S.playHead || 0);
    node.start(start);
    S.playHead = start + buf.duration;
    S.playing.push(node);
    node.onended = () => {
      S.playing = S.playing.filter((x) => x !== node);
      if (!S.playing.length && S.state === "speaking") {
        setState("live");
        clearTimeout(S.subFadeTimer);
        S.subFadeTimer = setTimeout(() => S.el && S.el.querySelector("#jv-sub").classList.add("fade"), 8000);
      }
    };
    if (S.state !== "speaking") setState("speaking");
  }
  function stopPlayback() {
    for (const n of S.playing || []) { try { n.stop(); } catch {} }
    S.playing = [];
    S.playHead = 0;
    if (S.state === "speaking") setState("live");
  }

  /**
   * Coupure réseau : nouvelle session sans toucher aux fenêtres ni aux actions affichées.
   * 5 essais avec attente croissante (le réseau met souvent 10-30 s à revenir : DNS, Wi-Fi…).
   */
  const RECONNECT_DELAYS = [2000, 5000, 10000, 15000, 20000];
  async function reconnect(reason) {
    if (!connected() && !S.connecting) return;
    // WebRTC qui lâche : on bascule tout de suite sur WebSocket (et pour les prochains appels, 7 jours)
    if (S.transport === "webrtc") { S.dropCount = 3; markUnstable(reason); }
    if (S.reconnects >= RECONNECT_DELAYS.length) {
      teardown();
      setState("idle");
      setStatus(`<span class="err">Connexion perdue (${esc(reason)}). Vérifiez le réseau puis réessayez.</span><button id="jv-retry">Réessayer</button>`);
      S.el.querySelector("#jv-retry").addEventListener("click", () => { S.reconnects = 0; setStatus(""); open(); });
      return;
    }
    const delay = RECONNECT_DELAYS[S.reconnects];
    S.reconnects++;
    teardown();
    setState("connecting");
    setStatus(`reconnexion… (${S.reconnects}/${RECONNECT_DELAYS.length})`);
    S.orb.start();
    S.connecting = true;
    const seq = ++S.connectSeq;
    await new Promise((r) => setTimeout(r, delay));
    if (seq !== S.connectSeq) return; // raccroché entre-temps
    try {
      await connect(seq);
      toast("Jarvis : connexion rétablie", "ok");
    } catch (e) {
      if (seq !== S.connectSeq) return;
      console.error("[jarvis] reconnexion", e);
      if (S.reconnects < RECONNECT_DELAYS.length) return reconnect(e.message);
      teardown();
      setState("idle");
      setStatus(`<span class="err">${esc(humanError(e))}</span><button id="jv-retry">Réessayer</button>`);
      S.el.querySelector("#jv-retry").addEventListener("click", () => { S.reconnects = 0; setStatus(""); open(); });
    } finally {
      if (seq === S.connectSeq) S.connecting = false;
    }
  }

  function setupAnalysers() {
    try {
      S.ctx = S.ctx || new (window.AudioContext || window.webkitAudioContext)();
      if (S.remote && !S.anOut) {
        S.anOut = S.ctx.createAnalyser();
        S.anOut.fftSize = 512;
        S.ctx.createMediaStreamSource(S.remote).connect(S.anOut);
      }
      if (S.mic && !S.anIn) {
        S.anIn = S.ctx.createAnalyser();
        S.anIn.fftSize = 512;
        S.ctx.createMediaStreamSource(S.mic).connect(S.anIn);
      }
      if (S.ctx.state === "suspended") S.ctx.resume();
    } catch (e) { console.warn("[jarvis] analyser", e); }
  }

  function send(ev) {
    if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(ev));
    else if (S.dc && S.dc.readyState === "open") S.dc.send(JSON.stringify(ev));
  }
  const isLive = () => (S.ws && S.ws.readyState === 1) || (S.dc && S.dc.readyState === "open");
  /** Session en cours (quel que soit le transport). */
  const connected = () => !!(S.pc || S.ws);
  const transportOk = () => (S.ws ? S.ws.readyState === 1 : !!(S.pc && S.pc.connectionState === "connected"));

  /** Coupe la connexion sans toucher à l'interface (erreur de connexion, raccrochage). */
  function teardown() {
    S.connectSeq++;
    S.connecting = false;
    S.closingByUser = true;
    try { S.dc && S.dc.close(); } catch {}
    try { S.pc && S.pc.close(); } catch {}
    try { S.ws && S.ws.close(); } catch {}
    try { stopPlayback(); } catch {}
    try { S.mic && S.mic.getTracks().forEach((t) => t.stop()); } catch {}
    if (S.sse) { S.sse.close(); S.sse = null; }
    S.pc = null; S.dc = null; S.ws = null; S.mic = null; S.remote = null; S.anIn = null; S.anOut = null; S.worklet = null;
    if (S.ctx) { try { S.ctx.close(); } catch {} S.ctx = null; }
    stopTimer();
    S.responseActive = false;
    S.needResponse = false;
    S.injectQueue = [];
    S.closingByUser = false;
  }

  /** Raccroche : l'overlay disparaît, le site est intact. */
  function close() {
    if (S.debug) console.log("[jarvis] close()", new Error().stack.split("\n").slice(1, 4).join(" ← "));
    teardown();
    S.orb && S.orb.stop();
    setState("idle");
    if (S.el) {
      S.el.hidden = true;
      S.el.querySelector("#jv-tasks").innerHTML = "";
      S.el.querySelector("#jv-dock").innerHTML = "";
      S.tasks = [];
      for (const id of [...S.windows.keys()]) closeWindow(id, true);
      setStatus("");
      toggleText(false);
      renderSub("");
      renderUser("");
      S.muted = false;
      S.el.querySelector("#jv-mic").classList.remove("off");
    }
  }
  /** Alt+J : appelle ou raccroche. */
  function toggle() {
    if (connected() || S.connecting) close();
    else open();
  }

  function toggleMic() {
    if (!S.mic) return;
    S.muted = !S.muted;
    S.mic.getAudioTracks().forEach((t) => (t.enabled = !S.muted));
    S.el.querySelector("#jv-mic").classList.toggle("off", S.muted);
    renderUser(S.muted ? "micro coupé" : "");
  }

  function setMode(mode) {
    if (mode === "dock") mode = "mini";
    S.mode = mode;
    S.el.dataset.mode = mode;
    S.orb && S.orb.resize();
  }

  function toggleText(force) {
    const box = S.el.querySelector("#jv-text");
    S.textOpen = force === undefined ? box.hidden : !!force;
    box.hidden = !S.textOpen;
    S.el.classList.toggle("has-text", S.textOpen); // les sous-titres remontent au-dessus de la saisie
    S.el.querySelector("#jv-kbd").classList.toggle("active", S.textOpen);
    if (S.textOpen) S.el.querySelector("#jv-input").focus();
  }
  function sendTyped() {
    const input = S.el.querySelector("#jv-input");
    const text = input.value.trim();
    if (!text || !isLive()) return;
    input.value = "";
    renderUser(text);
    logLine("user", text);
    send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
    // Une réponse encore en cours ? On ne crée pas la nôtre maintenant (erreur « active response ») : elle partira à response.done
    if (S.responseActive) { S.needResponse = true; return; }
    send({ type: "response.create" });
    S.responseActive = true;
  }

  // ────────────────────────────────────────────────────────────── Minuteur & infos
  let timerId = 0;
  function startTimer() {
    stopTimer();
    timerId = setInterval(() => {
      const s = Math.floor((Date.now() - S.startedAt) / 1000);
      const el = S.el.querySelector("#jv-timer");
      if (el) el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
      // Une connexion stable depuis 90 s remet le compteur de reconnexions à zéro
      if (S.reconnects && transportOk() && Date.now() - (S.lastConnectAt || 0) > 90000) S.reconnects = 0;
      renderSessionInfo();
    }, 1000);
  }
  function stopTimer() { clearInterval(timerId); timerId = 0; }

  function estimateCost() {
    const mini = /mini/.test(S.session?.model || "");
    const p = mini ? { ai: 10, ao: 20, ti: 0.6, to: 2.4, ci: 0.3 } : { ai: 32, ao: 64, ti: 4, to: 16, ci: 0.4 };
    const u = S.usage;
    return ((u.audioIn - u.cachedIn) * p.ai + u.cachedIn * p.ci + u.audioOut * p.ao + u.textIn * p.ti + u.textOut * p.to) / 1e6;
  }
  // ────────────────────────────────────────────────────────────── Réglages (voix, style, instructions)
  const VOICE_LABELS = { cedar: "Cedar — masculine, naturelle et posée (recommandée)", marin: "Marin — féminine, claire et professionnelle (recommandée)", ash: "Ash — masculine très grave", echo: "Echo — masculine claire", verse: "Verse — masculine vive", sage: "Sage — féminine calme", alloy: "Alloy — neutre", shimmer: "Shimmer — féminine lumineuse", coral: "Coral — féminine chantante", ballad: "Ballad — douce, lente" };
  const MODEL_LABELS = { "gpt-realtime-2.1": "gpt-realtime-2.1 — qualité", "gpt-realtime-2.1-mini": "gpt-realtime-2.1-mini — économique (÷3)", "gpt-realtime": "gpt-realtime — génération précédente" };
  const EAGER_LABELS = { low: "Patiente", medium: "Normale", high: "Vive" };

  /**
   * Formulaire de réglages partagé : panneau ⚙ de l'appel et carte « Jarvis » de la page Paramètres.
   * Chaque changement est enregistré immédiatement (PATCH /api/jarvis/config) ; effectif au prochain appel.
   */
  async function settingsForm(container, { inCall = false } = {}) {
    let cfg;
    try { cfg = await api("/api/jarvis/config"); } catch (e) { container.innerHTML = `<div class="small" style="color:var(--jv-red,var(--err))">${esc(e.message)}</div>`; return; }
    container.innerHTML = `
      <div class="jv-set">
        ${inCall ? `<h4>Réglages Jarvis</h4>` : ""}
        <div class="jv-set-row"><label>Voix</label><select data-k="voice">${cfg.voices.map((v) => `<option value="${v}" ${v === cfg.voice ? "selected" : ""}>${(cfg.voiceLabels || VOICE_LABELS)[v] || v}</option>`).join("")}</select><button class="jv-recall" id="jv-voice-try" title="Écouter un extrait de la voix sélectionnée (TTS OpenAI, même voix que Jarvis)">▶ Écouter</button></div>
        <div class="jv-set-row"><label>Style</label><div class="jv-seg" data-k="style">${Object.entries(cfg.styles).map(([k, l]) => `<button data-v="${k}" class="${k === cfg.style ? "active" : ""}">${l}</button>`).join("")}</div></div>
        <div class="jv-set-row"><label>Adresse</label><div class="jv-seg" data-k="address"><button data-v="vous" class="${cfg.address === "vous" ? "active" : ""}">Vous</button><button data-v="tu" class="${cfg.address === "tu" ? "active" : ""}">Tu</button></div></div>
        <div class="jv-set-row"><label>Réactivité</label><div class="jv-seg" data-k="eagerness">${["low", "medium", "high"].map((k) => `<button data-v="${k}" class="${k === cfg.eagerness ? "active" : ""}">${EAGER_LABELS[k]}</button>`).join("")}</div></div>
        <div class="jv-set-row"><label>Vitesse</label><input type="range" data-k="speed" min="0.8" max="1.4" step="0.05" value="${Number(cfg.speed) || 1}"><span class="v">${(Number(cfg.speed) || 1).toFixed(2)}×</span></div>
        <div class="jv-set-row"><label>Modèle</label><select data-k="realtimeModel">${cfg.models.map((m) => `<option value="${m}" ${m === cfg.realtimeModel ? "selected" : ""}>${MODEL_LABELS[m] || m}</option>`).join("")}</select></div>
        <div class="jv-set-row"><label>Transport</label><div class="jv-seg" data-k="transport"><button data-v="auto" class="${(cfg.transport || "auto") === "auto" ? "active" : ""}" title="WebRTC, puis WebSocket si le réseau coupe">Auto</button><button data-v="webrtc" class="${cfg.transport === "webrtc" ? "active" : ""}" title="UDP, latence minimale">WebRTC</button><button data-v="websocket" class="${cfg.transport === "websocket" ? "active" : ""}" title="TCP, tolère les coupures">WebSocket</button></div></div>
        <div class="jv-set-col"><label>Instructions personnalisées</label><textarea data-k="persona" rows="4" placeholder="Ex. : une phrase max, jamais de « Monsieur », tutoie-moi, sois cash, pas de commentaire avant d'agir.">${esc(cfg.persona || "")}</textarea></div>
        <div class="jv-set-foot"><span class="hint">Enregistré automatiquement · appliqué au prochain appel</span>${inCall ? `<button class="jv-recall" id="jv-recall" hidden>↻ Rappeler maintenant</button>` : ""}</div>
        ${inCall ? `<div class="jv-session" id="jv-session-info"></div>` : ""}
      </div>`;
    const save = async (patch) => {
      try { await api("/api/jarvis/config", { method: "PATCH", body: patch }); } catch (e) { return toast(e.message, "err"); }
      const recall = container.querySelector("#jv-recall");
      if (inCall && connected() && recall) recall.hidden = false;
      else if (!inCall) toast("Réglage Jarvis enregistré — appliqué au prochain appel", "ok");
    };
    container.querySelectorAll("select[data-k]").forEach((s) => s.addEventListener("change", () => save({ [s.dataset.k]: s.value })));
    container.querySelectorAll(".jv-seg").forEach((seg) =>
      seg.querySelectorAll("button").forEach((b) =>
        b.addEventListener("click", () => {
          seg.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
          save({ [seg.dataset.k]: b.dataset.v });
        })
      )
    );
    const range = container.querySelector("input[data-k=speed]");
    range.addEventListener("input", () => (container.querySelector(".jv-set .v").textContent = Number(range.value).toFixed(2) + "×"));
    range.addEventListener("change", () => save({ speed: Number(range.value) }));
    const ta = container.querySelector("textarea[data-k=persona]");
    let t = 0;
    ta.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => save({ persona: ta.value }), 700); });
    container.querySelector("#jv-recall")?.addEventListener("click", () => { close(); setTimeout(open, 300); });
    // Aperçu d'une voix : extrait mp3 généré côté serveur (gpt-4o-mini-tts, voix et consigne de ton identiques)
    const tryBtn = container.querySelector("#jv-voice-try");
    tryBtn?.addEventListener("click", async () => {
      const voice = container.querySelector("select[data-k=voice]").value;
      tryBtn.disabled = true;
      tryBtn.textContent = "…";
      try {
        if (S.previewAudio) { S.previewAudio.pause(); S.previewAudio = null; }
        const resp = await fetch("/api/jarvis/voice-preview?voice=" + encodeURIComponent(voice));
        if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).error || "Aperçu indisponible");
        const audio = new Audio(URL.createObjectURL(await resp.blob()));
        S.previewAudio = audio;
        audio.onended = () => { tryBtn.disabled = false; tryBtn.textContent = "▶ Écouter"; };
        await audio.play();
      } catch (e) {
        toast("Aperçu de la voix : " + e.message, "err");
        tryBtn.disabled = false;
        tryBtn.textContent = "▶ Écouter";
      }
    });
    if (inCall) renderSessionInfo();
  }
  function renderSessionInfo() {
    const el = S.el && S.el.querySelector("#jv-session-info");
    if (!el) return;
    const mins = S.startedAt ? ((Date.now() - S.startedAt) / 60000).toFixed(1) : "0";
    el.innerHTML = `<span>${esc(S.session?.model || "—")} · ${esc(S.session?.voice || "")} · ${S.transport || ""}</span><span>${mins} min · ~${estimateCost().toFixed(3)} $ · ${transportOk() ? "connecté" : "—"}</span>`;
  }

  // ────────────────────────────────────────────────────────────── Événements Realtime
  function handleEvent(ev) {
    if (S.debug && !/\.delta$/.test(ev.type)) console.log("[jarvis]", ev.type, ev.type === "error" ? JSON.stringify(ev.error) : ev.transcript || ev.text || "");
    switch (ev.type) {
      case "input_audio_buffer.speech_started":
        if (S.ws) stopPlayback(); // barge-in : on coupe la lecture locale (le serveur annule la réponse)
        setState("listening");
        break;
      case "response.output_audio.delta":
        if (S.ws && ev.delta) playDelta(ev.delta);
        break;
      case "response.cancelled":
        if (S.ws) stopPlayback();
        break;
      case "input_audio_buffer.speech_stopped":
        setState("thinking");
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (ev.transcript && ev.transcript.trim()) { renderUser(ev.transcript.trim()); logLine("user", ev.transcript.trim()); }
        break;
      case "response.created":
        S.responseActive = true;
        if (S.state !== "speaking") setState("thinking");
        S.sub = "";
        break;
      case "output_audio_buffer.started":
        setState("speaking");
        break;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        if (S.state === "speaking") setState("live");
        clearTimeout(S.subFadeTimer);
        S.subFadeTimer = setTimeout(() => S.el && S.el.querySelector("#jv-sub").classList.add("fade"), 8000);
        break;
      case "response.output_audio_transcript.delta":
        S.sub += ev.delta || "";
        renderSub(S.sub);
        break;
      case "response.output_audio_transcript.done":
        if (ev.transcript) { S.sub = ev.transcript; renderSub(S.sub); logLine("assistant", ev.transcript); }
        break;
      case "response.output_text.done":
        if (ev.text) { S.sub = ev.text; renderSub(S.sub); logLine("assistant", ev.text); }
        break;
      case "response.done": {
        const r = ev.response || {};
        if (r.usage) {
          const d = r.usage.input_token_details || {}, o = r.usage.output_token_details || {};
          S.usage.audioIn += d.audio_tokens || 0;
          S.usage.textIn += d.text_tokens || 0;
          S.usage.cachedIn += (d.cached_tokens_details && d.cached_tokens_details.audio_tokens) || 0;
          S.usage.audioOut += o.audio_tokens || 0;
          S.usage.textOut += o.text_tokens || 0;
        }
        const calls = (r.output || []).filter((it) => it.type === "function_call");
        if (calls.length) {
          // La réponse « continue » après les outils : verrou maintenu pour que les résultats de
          // jobs (SSE) n'injectent pas un response.create concurrent entre-temps.
          S.responseActive = true;
          runToolCalls(calls);
        } else {
          S.responseActive = false;
          if (S.state === "thinking") setState("live");
          if (S.needResponse) { S.needResponse = false; send({ type: "response.create" }); S.responseActive = true; }
          else flushInjectQueue();
        }
        if (r.status === "failed") {
          const msg = r.status_details?.error?.message || "réponse échouée";
          console.warn("[jarvis] response failed", r.status_details);
          renderSub("(" + msg + ")", true);
        }
        break;
      }
      case "error":
        console.error("[jarvis] erreur OpenAI", ev.error);
        if (/already has an active response/i.test(ev.error?.message || "")) { S.needResponse = true; S.responseActive = true; break; }
        if (!/no active response|Cancellation failed/i.test(ev.error?.message || "")) toast("Jarvis : " + (ev.error?.message || "erreur"), "err");
        break;
      default:
        break;
    }
  }

  // ────────────────────────────────────────────────────────────── Outils
  const LABELS = {
    show_window: (a) => "Afficher : " + (a.title || "fenêtre"),
    close_window: (a) => a.id === "all" ? "Fermer toutes les fenêtres" : "Fermer : " + a.id,
    open_page: (a) => "Ouvrir " + (a.title || PAGES[a.page] || a.page),
    platform_lookup: (a) => "Lexique : " + a.query,
    channel_stats: (a) => "Stats " + (a.channel && !/^all$/i.test(a.channel) ? a.channel : "de toutes les chaînes") + (a.period ? " · " + a.period : ""),
    window_control: (a) => `${a.action} : ${a.id}`,
    set_voice: (a) => "Voix : " + a.voice,
    page_read: (a) => "Lire la fenêtre" + (a.id ? " " + a.id.replace(/^page-/, "") : ""),
    page_act: (a) => ({ click: "Cliquer", fill: "Écrire", select: "Choisir", check: "Cocher" }[a.action] || a.action) + " : " + a.target + (a.value ? " = " + a.value : ""),
    niche_bank: (a) => "Banque de niches" + (a.machine ? " · " + (PAGES[a.machine] || a.machine) : a.niche ? " · " + a.niche : "") + (a.channel ? " · " + a.channel : ""),
    competitor_videos: (a) => "Dernières vidéos des concurrents" + (a.machine ? " · " + (PAGES[a.machine] || a.machine) : a.niche ? " · " + a.niche : ""),
    api_routes: (a) => "Chercher dans l'API : " + a.query,
    machine_info: (a) => "Machine " + (PAGES[a.machine] || a.machine),
    machine_idea: (a) => "Idée " + (PAGES[a.machine] || a.machine),
    machine_run: (a) => (a.confirm ? "Lancer le run " : "Préparer un run ") + (PAGES[a.machine] || a.machine) + (a.theme ? " : " + a.theme : a.pickIdea ? " (idée de la machine)" : ""),
    machine_settings: (a) => "Réglages " + (PAGES[a.machine] || a.machine),
    machine_runs: (a) => `${{ list: "Runs", status: "État du run", validate: "Valider l'étape", cancel: "Annuler le run", resume: "Reprendre le run" }[a.action] || a.action} ${PAGES[a.machine] || a.machine}`,
    kie_catalog: (a) => "Catalogue Kie" + (a.task ? " · " + a.task : a.category ? " · " + a.category : ""),
    kie_schema: (a) => "Options de " + a.model,
    kie_generate: (a) => "Générer : " + a.model,
    recent_files: () => "Fichiers récents",
    web_search: (a) => "Rechercher : " + a.query,
    brain_search: (a) => "Second cerveau : " + a.query,
    brain_read: (a) => "Lire la note " + a.path,
    brain_write: (a) => "Écrire la note " + (a.title || a.path || ""),
    brain_graph: (a) => "Graphe : " + a.query,
    ask_claude: (a) => "Claude Code : " + a.task,
    ask_hermes: (a) => "Hermès : " + a.task,
    job_status: () => "Vérifier un job",
    platform_overview: () => "État de la plateforme",
    agentos_api: (a) => `${a.method} ${a.path}`,
    generate_image: (a) => "Générer une image : " + a.prompt,
    notify_telegram: () => "Message Telegram",
    remember: (a) => "Mémoriser : " + a.fact,
    forget: (a) => "Oublier : " + a.match,
    program_get: () => "Programme du jour",
    program_set: () => "Mettre à jour le programme",
    program_done: (a) => "Cocher : " + a.match,
    computer_open: (a) => "Ouvrir " + a.target,
    computer_windows: (a) => (a.action === "list" ? "Lister les fenêtres" : `${a.action} : ${a.title}`),
    computer_screenshot: () => "Regarder l'écran",
    computer_type: (a) => "Taper : " + a.text,
    computer_keys: (a) => "Touches : " + a.keys,
    computer_click: (a) => `Clic (${a.x}, ${a.y})`,
    computer_run: (a) => "Commande : " + a.command,
    read_file: (a) => "Lire " + a.path,
    list_dir: (a) => "Lister " + a.path,
  };
  function labelFor(name, args) {
    try { return (LABELS[name] ? LABELS[name](args) : name).slice(0, 70); } catch { return name; }
  }

  async function runToolCalls(calls) {
    setState("thinking");
    await Promise.all(calls.map(async (call) => {
      let args = {};
      try { args = JSON.parse(call.arguments || "{}"); } catch {}
      const task = addTask(labelFor(call.name, args));
      let output;
      try {
        if (S.clientTools.has(call.name)) output = await runClientTool(call.name, args);
        else {
          // « Cette niche », « mes concurrents » sans précision : la machine de la fenêtre au premier plan
          if (call.name === "competitor_videos" && !args.machine && !args.niche) { const fm = frontMachine(); if (fm) args.machine = fm; }
          const r = await api("/api/jarvis/tool", { method: "POST", body: { name: call.name, args } });
          output = r.ok ? r.result : { error: r.error };
          // Veille concurrents : le tableau des dernières vidéos s'affiche tout seul
          if (r.ok && call.name === "competitor_videos" && r.result && r.result.newest) {
            try { showCompetitors(r.result); } catch (e) { console.warn("[jarvis] veille", e); }
            S.runJustShown = Date.now();
          }
          // Préparation d'un run (plan) : fenêtre mise à jour à chaque échange, rien n'est lancé
          if (r.ok && call.name === "machine_run" && r.result && r.result.step === "plan") {
            try { showPlan(r.result); } catch (e) { console.warn("[jarvis] plan", e); }
            S.runJustShown = Date.now();
          }
          // Run lancé / piloté sur une machine : sa fenêtre s'ouvre (ou se rafraîchit) dans l'appel
          if (r.ok && r.result && r.result.machine && ((call.name === "machine_run" && r.result.launched) || (call.name === "machine_runs" && args.action !== "list" && args.action !== "status" && args.action !== "stock"))) {
            if (call.name === "machine_run") closeWindow("plan-" + r.result.machine);
            try { showMachine(r.result.machine, r.result.runId || r.result.id); } catch (e) { console.warn("[jarvis] showMachine", e); }
            S.runJustShown = Date.now(); // la fenêtre du run suffit : pas de fenêtre récapitulative en plus
          }
          // Banque de niches consultée : la fenêtre Banque s'ouvre sur la niche (et la chaîne) concernée
          if (r.ok && call.name === "niche_bank" && r.result && r.result.nicheId) {
            try { showPage("bank", "niche=" + r.result.nicheId + (r.result.channel ? "&channel=" + r.result.channel : ""), "Banque — " + r.result.niche); } catch (e) { console.warn("[jarvis] bank", e); }
            S.runJustShown = Date.now();
          }
          // Rapport de chaîne : la fenêtre de stats s'affiche toute seule
          if (r.ok && call.name === "channel_stats" && r.result && r.result.periodStats) {
            try { showChannelStats(r.result); } catch (e) { console.warn("[jarvis] stats", e); }
            S.runJustShown = Date.now();
          }
        }
        task.done(!(output && output.error));
      } catch (e) {
        output = { error: e.message };
        task.done(false);
      }
      send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: call.call_id, output: JSON.stringify(output ?? { ok: true }) } });
    }));
    if (!isLive()) return;
    S.responseActive = true;
    send({ type: "response.create" });
  }

  /** Identifiant de page tolérant (« machine POV », « data ranking », « banque de niches »…) → page connue. */
  function resolvePage(args) {
    let page = String(args.page || "").replace(/^#?\/?/, "").toLowerCase().replace(/^(la\s+)?(page\s+)?(des?\s+|du\s+)?/, "").replace(/^machine[\s_-]+|[\s_-]+machine$/g, "").replace(/[\s_-]+/g, "");
    // « machines » + machine=pov, ou un nom approximatif (« time travel », « data ranking ») → la bonne page
    const mq = /machine=([\w-]+)/i.exec(String(args.query || ""));
    if (page === "machines" && mq && PAGES[mq[1].toLowerCase()]) { page = mq[1].toLowerCase(); args.query = ""; }
    const ALIAS = { dataranking: "datarank", kiestudio: "kie", banque: "bank", banquedeniches: "bank", secondcerveau: "brain", cerveau: "brain", fichiers: "files", mesfichiers: "files", parametres: "settings", "paramètres": "settings", reglages: "settings", "réglages": "settings", calendrier: "calendar", taches: "tasks", "tâches": "tasks", tachesetcron: "tasks", chaines: "channels", "chaînes": "channels", chaine: "channels", "chaîne": "channels", miniaturecreator: "miniature", miniatures: "miniature", nichefinder: "niche", scrapomatic: "scrap", scraper: "scrap", chatclaude: "chat", claude: "chat", claudecode: "chat", chathermes: "hermes", "hermès": "hermes", connexions: "connections", accueil: "dashboard", home: "dashboard", tableaudebord: "dashboard", stats: "dashboard", statistiques: "dashboard", voyagedansletemps: "timetravel", famille: "storyfamily", stickmen: "stickman", fruits: "ttfruits", machinefruits: "ttfruits", banquedhistoires: "ttbank" };
    if (!PAGES[page] && ALIAS[page]) page = ALIAS[page];
    if (!PAGES[page]) return { error: "Page inconnue : " + page + ". Pages : " + Object.keys(PAGES).join(", ") };
    return { page };
  }

  const MACHINE_IDS = ["timetravel", "linguistique", "musique", "storyfamily", "stickman", "pov", "wealth", "datarank"];
  /** Machine dont la fenêtre est au premier plan (sinon la dernière fenêtre de machine ouverte), ou null. */
  function frontMachine() {
    if (!S.el) return null;
    const wins = [...S.el.querySelectorAll("#jv-windows .jv-win.page:not(.min)")].reverse();
    for (const w of wins) { const id = String(w.dataset.id || "").replace(/^page-/, ""); if (MACHINE_IDS.includes(id)) return id; }
    return null;
  }
  /** Préparation d'un run (plan machine_run) : sujet, paramètres résolus, devis, ce qui manque — rien n'est lancé. */
  function showPlan(r) {
    const rows = [["Machine", r.name || r.machine], ["Sujet", r.theme ? r.theme + (r.ideaByMachine ? " (idée de la machine)" : "") : "— à préciser"], ["Mode", r.mode === "auto" ? "automatique" : "semi-manuel (validation à chaque étape)"]];
    for (const [k, v] of Object.entries(r.params || {})) if (!["subject", "topic", "theme", "mode"].includes(k)) rows.push([k, Array.isArray(v) ? v.join(", ") : String(v)]);
    if (r.estimateUsd !== undefined && r.estimateUsd !== null) rows.push(["Devis", "$" + Number(r.estimateUsd).toFixed(2)]);
    const missing = r.missing || [];
    const blocks = [{ kind: "kv", rows }, { kind: "text", text: missing.length ? `Il manque : ${missing.join(", ")}. Rien n'est lancé.` : "Prêt. Rien n'est lancé tant que vous n'avez pas dit « oui »." }];
    return showWindow({ id: "plan-" + r.machine, title: "Préparation — " + (r.name || r.machine), width: 380, position: "right", blocks });
  }
  /** Rapport de chaîne (channel_stats) : vues/abonnés de la période, compteurs, dernière vidéo, vidéos récentes. */
  function showChannelStats(r) {
    const PER = { "7d": "7 jours", "28d": "28 jours", "90d": "90 jours", all: "all time" };
    const n = (x) => Number(x || 0).toLocaleString("fr-FR");
    const fr = (d) => (d ? String(d).slice(8, 10) + "/" + String(d).slice(5, 7) : "");
    const p = r.periodStats || {};
    const chans = r.channels || [];
    const tot = (k) => chans.reduce((s, c) => s + (Number(c[k]) || 0), 0);
    const blocks = [{ kind: "stats", stats: [
      { value: n(p.views), label: "vues · période" }, { value: (p.subsNet >= 0 ? "+" : "") + n(p.subsNet), label: "abonnés nets" },
      { value: n(tot("subscribers")), label: "abonnés" }, { value: n(tot("totalViews")), label: "vues totales" },
      { value: n(tot("videos")), label: "vidéos" }, { value: n(tot("stockPrivate")), label: "en stock privé" },
    ] }];
    if ((p.last7days || []).length) blocks.push({ kind: "table", columns: ["Jour", "Vues", "Abonnés"], rows: p.last7days.map((d) => [fr(d.date), n(d.views), (d.subs >= 0 ? "+" : "") + d.subs]) });
    if (chans.length > 1) blocks.push({ kind: "table", columns: ["Chaîne", "Abonnés", "Vues", "Stock"], rows: chans.map((c) => [c.title, n(c.subscribers), n(c.totalViews), c.stockPrivate]) });
    const one = chans.length === 1 ? chans[0] : null;
    if (one && one.lastVideo) blocks.push({ kind: "kv", rows: [["Dernière vidéo", one.lastVideo.title], ["Publiée le", fr(one.lastVideo.publishedAt) + (one.lastVideo.privacy !== "public" ? " · " + one.lastVideo.privacy : "")], ["Vues / likes / comm.", `${n(one.lastVideo.views)} / ${n(one.lastVideo.likes)} / ${n(one.lastVideo.comments)}`]] });
    if ((r.recentVideos || []).length) blocks.push({ kind: "table", columns: ["Vidéos récentes", "Date", "Vues", "Likes"], rows: r.recentVideos.slice(0, 6).map((v) => [v.title, fr(v.publishedAt), n(v.views), n(v.likes)]) });
    if (r.stale && r.dataAt) blocks.push({ kind: "text", text: `Compteurs relevés le ${fr(r.dataAt)} (cache manuel) — « actualise » pour rafraîchir.` });
    return showWindow({ id: "stats-" + (r.channelId || "all"), title: `Stats — ${r.channel || "chaînes"} · ${PER[r.period] || r.period}`, width: 520, position: "right", blocks });
  }

  /** Tableau des dernières vidéos des concurrents (résultat de competitor_videos, immédiat puis mis à jour). */
  function showCompetitors(r) {
    const fr = (d) => (d ? d.slice(8, 10) + "/" + d.slice(5, 7) : "");
    const blocks = [
      { kind: "table", columns: ["Date", "Chaîne", "Vidéo", "Vues"], rows: (r.newest || []).map((v) => [fr(v.date), v.channel, v.title, Number(v.views || 0).toLocaleString("fr-FR")]) },
    ];
    if (r.refreshing) blocks.unshift({ kind: "text", text: "Mise à jour des chaînes en cours…" });
    else if (r.failed && r.failed.length) blocks.unshift({ kind: "text", text: "Non mises à jour : " + r.failed.join(" ; ") });
    return showWindow({ id: "veille-" + r.nicheId, title: "Dernières vidéos — " + r.niche, width: 520, position: "right", blocks });
  }

  function runClientTool(name, args) {
    switch (name) {
      case "show_window":
        // Juste après le lancement d'un run, le modèle veut parfois rouvrir une fenêtre « récapitulatif » : inutile, le run est affiché
        if (S.runJustShown && Date.now() - S.runJustShown < 15000) return { ok: true, note: "Inutile : la fenêtre concernée affiche déjà le résultat. N'ouvre pas de fenêtre récapitulative." };
        return { ok: true, id: showWindow(args) };
      case "close_window":
        if (args.id === "all") { for (const id of [...S.windows.keys()]) closeWindow(id); return { ok: true, closed: "all" }; }
        if (!S.windows.has(args.id)) return { error: "Fenêtre inconnue : " + args.id + ". Ouvertes : " + [...S.windows.keys()].join(", ") };
        closeWindow(args.id);
        return { ok: true };
      case "open_page": {
        const res = resolvePage(args);
        if (res.error) return res;
        const id = openPage(res.page, args.query, args.title, !!args.maximize);
        return { ok: true, id, note: "Page ouverte dans une fenêtre de l'appel (Alex reste avec toi). Pour la lire ou agir dedans : page_read / page_act (id '" + id + "')." };
      }
      case "page_read":
        return pageRead(args);
      case "page_act":
        S.runJustShown = Date.now(); // le résultat du clic se voit dans la page : pas de fenêtre récapitulative
        return pageAct(args);
      case "window_control": {
        const win = S.windows.get(args.id);
        if (!win) return { error: "Fenêtre inconnue : " + args.id + ". Ouvertes : " + [...S.windows.keys()].join(", ") };
        if (args.action === "minimize") minimizeWindow(win);
        else if (args.action === "restore") restoreWindow(win);
        else if (args.action === "maximize") { restoreWindow(win); maximizeWindow(win, true); }
        else { restoreWindow(win); focusWindow(win); }
        return { ok: true };
      }
      default:
        return { error: "Outil client inconnu : " + name };
    }
  }

  // ────────────────────────────────────────────────────────────── Jobs (SSE)
  function openSSE() {
    if (S.sse) S.sse.close();
    const es = new EventSource("/api/jarvis/events");
    S.sse = es;
    S.seenJobs = S.seenJobs || new Set();
    const onDone = (d, force) => {
      if (S.seenJobs.has(d.id) && !force) return;
      S.seenJobs.add(d.id);
      const t = S.jobTasks.get(d.id);
      if (t) t.done(!d.error);
      else addTask(d.label).done(!d.error);
      // Média généré (image, vidéo, audio) : fenêtre ouverte AUTOMATIQUEMENT, sans attendre le modèle
      const shown = !d.error && autoShowMedia(d);
      // Veille concurrents terminée : tableau mis à jour, Jarvis annonce l'essentiel sans être relancé
      if (!d.error && d.result && d.result.kind === "competitors") {
        try { showCompetitors(d.result); } catch (e) { console.warn("[jarvis] veille", e); }
        S.runJustShown = Date.now();
        const r = d.result;
        const lines = (r.newest || []).map((v) => `${v.date} | ${v.channel} | ${v.title} | ${v.views} vues`).join("\n");
        inject(`[RÉSULTAT JOB ${d.id}] (${d.label}) Mise à jour terminée : ${r.refreshed} chaîne(s) rescrappée(s), ${r.newVideos} nouvelle(s) vidéo(s) trouvée(s)${r.failed ? `, échec sur : ${r.failed.join(" ; ")}` : ""}, coût ${r.costUsd} $.\n${r.summary}\nDernières vidéos (les plus récentes d'abord) :\n${lines}\n\nLe tableau à jour est DÉJÀ affiché : n'appelle PAS show_window. Annonce à Alex, sans attendre qu'il te relance, en deux ou trois phrases : c'est à jour, ce que les concurrents viennent de sortir et ce qui marche le mieux.`);
        return;
      }
      const payload = d.error ? `ÉCHEC : ${d.error}` : typeof d.result === "string" ? d.result : JSON.stringify(d.result);
      const r = d.result || {};
      const rels = [...(Array.isArray(r.files) ? r.files.map((f) => f.rel) : []), r.file].filter(Boolean);
      const reuse = rels.length ? `\nPour RÉUTILISER ce fichier comme source d'une autre génération (image → vidéo, etc.), passe {"rel": "${rels[0]}"} dans le champ fichier (ex. image_url) — jamais une URL /media/.` : "";
      inject(`[RÉSULTAT JOB ${d.id}] (${d.label})\n${String(payload).slice(0, 6000)}${reuse}\n\n${shown ? "Le média est DÉJÀ affiché dans une fenêtre : n'appelle PAS show_window, dis juste une phrase." : "Commente ce résultat à Alex en une ou deux phrases, et affiche-le dans une fenêtre si c'est utile."}`);
    };
    const autoShowMedia = (d) => {
      const r = d.result || {};
      const files = Array.isArray(r.files) ? r.files : r.image ? [{ type: "image", url: r.image }] : [];
      const blocks = files.filter((f) => f.url && ["image", "video", "audio"].includes(f.type)).slice(0, 4).map((f) => ({ kind: f.type, src: f.url, caption: f.title || undefined }));
      if (!blocks.length) return false;
      // À droite du cœur : ne recouvre ni les sous-titres ni les contrôles
      showWindow({ id: "job-" + d.id, title: String(d.label || "Résultat").replace(/^Kie : |^Image : /, ""), blocks, position: "right", width: blocks[0].kind === "audio" ? 300 : 340 });
      return true;
    };
    es.addEventListener("job_started", (e) => {
      const d = JSON.parse(e.data);
      S.jobTasks.set(d.id, addTask(d.label));
    });
    es.addEventListener("job_done", (e) => onDone(JSON.parse(e.data)));
    // Suivi des tâches de la plateforme (run terminé, en attente de validation, publié, en échec) :
    // regroupées sur 2,5 s puis annoncées par Jarvis, sans qu'Alex ait à demander où ça en est.
    es.addEventListener("task_event", (e) => {
      if (!isLive()) return;
      S.taskEvents = S.taskEvents || [];
      S.taskEvents.push(JSON.parse(e.data));
      clearTimeout(S.taskEventTimer);
      S.taskEventTimer = setTimeout(flushTaskEvents, 2500);
    });
    // Rattrapage : jobs de CET appel terminés pendant une coupure (le serveur renvoie les 3 dernières minutes).
    // Après une reconnexion, la nouvelle session n'a plus le résultat en contexte → on le ré-injecte même s'il a déjà été vu.
    es.addEventListener("hello", (e) => {
      const d = JSON.parse(e.data);
      const resumed = S.resumedSession;
      S.resumedSession = false;
      for (const j of d.recent || []) if (S.jobTasks.has(j.id) && (resumed || !S.seenJobs.has(j.id))) onDone(j, resumed);
    });
  }
  function flushTaskEvents() {
    const list = (S.taskEvents || []).splice(0);
    if (!list.length) return;
    const WORD = { video_done: "TERMINÉ", video_published: "PUBLIÉ", render_failed: "ÉCHEC", needs_validation: "ATTEND LA VALIDATION D'ALEX" };
    const lines = list.map((d) => `- ${WORD[d.event] || d.event} : ${d.title}${d.machine ? " (" + d.machine + ")" : ""}${d.detail ? " — " + d.detail : ""}${d.runId && d.machineId ? ` [machine ${d.machineId}, run ${d.runId}]` : ""}`);
    for (const d of list) addTask((WORD[d.event] || d.event).toLowerCase() + " : " + d.title).done(d.event !== "render_failed");
    inject(`[SUIVI] Tâches de la plateforme qui viennent de changer d'état :\n${lines.join("\n")}\n\nPréviens Alex tout de suite, en une phrase, sans ouvrir de fenêtre récapitulative. Si une validation est attendue, propose de valider (machine_runs validate) ou d'ouvrir le run ; en cas d'échec, dis l'étape et la raison.`);
  }
  function inject(text) {
    S.injectQueue.push(text);
    flushInjectQueue();
  }
  function flushInjectQueue() {
    if (S.responseActive || !isLive() || !S.injectQueue.length) return;
    const text = S.injectQueue.shift();
    send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text }] } });
    send({ type: "response.create" });
    S.responseActive = true;
  }

  // ────────────────────────────────────────────────────────────── Liste d'actions
  function addTask(label) {
    const ol = S.el.querySelector("#jv-tasks");
    const li = document.createElement("li");
    li.className = "jv-task running";
    li.innerHTML = `<span class="ico">&#11041;</span><span>${esc(label)}</span>`;
    ol.appendChild(li);
    S.tasks.push(li);
    while (S.tasks.length > 9) S.tasks.shift().remove();
    S.tasks.forEach((t, i) => t.classList.toggle("old", i < S.tasks.length - 6));
    return {
      done(ok) { li.className = "jv-task " + (ok ? "done" : "error"); li.querySelector(".ico").innerHTML = "&#11042;"; },
    };
  }

  // ────────────────────────────────────────────────────────────── Sous-titres
  /** Sous-titre : les 2 dernières phrases (coupe par phrase, jamais au milieu d'un mot), fondu 8 s après la fin. */
  function renderSub(text, muted) {
    const el = S.el && S.el.querySelector("#jv-sub");
    if (!el) return;
    const sentences = String(text || "").trim().split(/(?<=[.!?…])\s+/).filter(Boolean);
    let shown = sentences.length > 2 ? sentences.slice(-2).join(" ") : sentences.join(" ");
    if (shown.length > 260) shown = "…" + shown.slice(shown.length - 260).replace(/^\S*\s/, "");
    el.textContent = shown;
    el.classList.toggle("muted", !!muted);
    el.classList.remove("fade");
    clearTimeout(S.subFadeTimer);
    if (shown) S.subFadeTimer = setTimeout(() => { if (S.state !== "speaking") el.classList.add("fade"); }, 9000);
  }
  function renderUser(text) {
    const el = S.el && S.el.querySelector("#jv-user");
    if (!el) return;
    el.textContent = text;
    el.classList.remove("hide");
    clearTimeout(S.userHideTimer);
    if (text) S.userHideTimer = setTimeout(() => el.classList.add("hide"), 7000);
  }
  function logLine(role, text) {
    fetch("/api/jarvis/log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role, text }) }).catch(() => {});
  }

  // ────────────────────────────────────────────────────────────── Fenêtres
  const SLOTS = ["top-center", "top-right", "left", "right", "bottom-right", "bottom-left", "top-left", "center"];
  function slotPos(slot, w, h) {
    const W = window.innerWidth, H = window.innerHeight, m = 24;
    const map = {
      "top-left": [m + 330, 64],
      "top-center": [W / 2 - w / 2, 60],
      "top-right": [W - w - m, 64],
      left: [m + 60, H / 2 - h / 2 - 20],
      right: [W - w - m, H / 2 - h / 2 - 20],
      "bottom-left": [m + 60, H - h - 150],
      "bottom-right": [W - w - m, H - h - 150],
      center: [W / 2 - w / 2, Math.max(60, H / 2 - h / 2 - 90)], // au-dessus des sous-titres
    };
    const [x, y] = map[slot] || map["top-right"];
    return [Math.max(8, Math.min(W - w - 8, x)), Math.max(58, Math.min(H - 80, y))];
  }

  function createWindow({ id, title, kind, width, height, position }) {
    const win = document.createElement("div");
    win.className = "jv-win" + (kind === "page" ? " page" : "");
    win.dataset.id = id;
    win.innerHTML = `
      <div class="jv-win-head"><span class="hx">&#11041;</span><b></b>
        <span class="jv-win-actions">
          ${kind === "page" ? `<button data-act="open" title="Ouvrir dans un onglet">↗</button>` : ""}
          <button data-act="min" title="Réduire dans le dock">–</button>
          <button data-act="max" title="Agrandir / restaurer">⤢</button>
          <button data-act="close" title="Fermer">✕</button>
        </span>
      </div>
      <div class="jv-win-body"></div>
      <div class="jv-win-grip" title="Redimensionner"></div>`;
    win.querySelector("b").textContent = title;
    win.style.width = width + "px";
    if (height) win.style.height = height + "px";
    S.el.querySelector("#jv-windows").appendChild(win);
    S.windows.set(id, win);
    const [x, y] = slotPos(position && position !== "auto" ? position : SLOTS[(S.windows.size - 1) % SLOTS.length], width, height || Math.min(win.offsetHeight || 220, window.innerHeight * 0.8));
    win.style.left = x + "px";
    win.style.top = y + "px";
    win.querySelector(".jv-win-actions").addEventListener("click", (e) => {
      const act = e.target.closest("button")?.dataset.act;
      if (act === "close") closeWindow(id);
      else if (act === "min") minimizeWindow(win);
      else if (act === "max") maximizeWindow(win);
      else if (act === "open" && win._src) window.open(win._src, "_blank");
    });
    win.addEventListener("pointerdown", () => focusWindow(win), true);
    makeDraggable(win);
    makeResizable(win);
    return win;
  }
  function focusWindow(win) {
    const parent = S.el.querySelector("#jv-windows");
    if (parent.lastElementChild !== win) parent.appendChild(win);
  }
  function hasPageWindow() {
    for (const w of S.windows.values()) if (w.classList.contains("page") && !w.classList.contains("min")) return true;
    return false;
  }
  /** Disposition « travail » : une page ouverte à droite → cœur, sous-titres et contrôles dans la colonne de gauche. */
  function syncLayout() {
    if (S.el) S.el.classList.toggle("has-page", hasPageWindow());
  }
  function minimizeWindow(win) {
    if (win.classList.contains("min")) return;
    win.classList.add("min");
    const chip = document.createElement("button");
    chip.innerHTML = `<span class="hx">&#11041;</span>${esc(win.querySelector("b").textContent)}`;
    chip.addEventListener("click", () => restoreWindow(win));
    win._chip = chip;
    S.el.querySelector("#jv-dock").appendChild(chip);
    syncLayout();
  }
  function restoreWindow(win) {
    win.classList.remove("min");
    if (win._chip) { win._chip.remove(); win._chip = null; }
    focusWindow(win);
    syncLayout();
  }
  function maximizeWindow(win, force) {
    const isMax = !!win._rect;
    if (isMax && !force) {
      Object.assign(win.style, win._rect);
      win._rect = null;
      return;
    }
    if (isMax) return;
    win._rect = { left: win.style.left, top: win.style.top, width: win.style.width, height: win.style.height };
    Object.assign(win.style, { left: "18px", top: "58px", width: window.innerWidth - 36 + "px", height: window.innerHeight - 58 - 96 + "px" });
    focusWindow(win);
  }
  function closeWindow(id, instant) {
    const win = S.windows.get(id);
    if (!win) return;
    S.windows.delete(id);
    if (win._chip) win._chip.remove();
    syncLayout();
    if (instant) return win.remove();
    win.classList.add("closing");
    setTimeout(() => win.remove(), 170);
  }
  function makeDraggable(win) {
    const head = win.querySelector(".jv-win-head");
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    head.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      dragging = true;
      sx = e.clientX; sy = e.clientY; ox = win.offsetLeft; oy = win.offsetTop;
      head.setPointerCapture(e.pointerId);
      S.el.classList.add("dragging");
    });
    head.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      win.style.left = Math.max(-win.offsetWidth + 80, Math.min(window.innerWidth - 80, ox + e.clientX - sx)) + "px";
      win.style.top = Math.max(0, Math.min(window.innerHeight - 40, oy + e.clientY - sy)) + "px";
    });
    const stop = () => { if (dragging) { dragging = false; S.el.classList.remove("dragging"); win._rect = null; } };
    head.addEventListener("pointerup", stop);
    head.addEventListener("pointercancel", stop);
    head.addEventListener("dblclick", (e) => { if (!e.target.closest("button")) maximizeWindow(win); });
  }
  function makeResizable(win) {
    const grip = win.querySelector(".jv-win-grip");
    let sx = 0, sy = 0, ow = 0, oh = 0, resizing = false;
    grip.addEventListener("pointerdown", (e) => {
      resizing = true;
      sx = e.clientX; sy = e.clientY; ow = win.offsetWidth; oh = win.offsetHeight;
      grip.setPointerCapture(e.pointerId);
      S.el.classList.add("dragging");
      e.preventDefault();
    });
    grip.addEventListener("pointermove", (e) => {
      if (!resizing) return;
      win.style.width = Math.max(260, Math.min(window.innerWidth - win.offsetLeft - 8, ow + e.clientX - sx)) + "px";
      win.style.height = Math.max(120, Math.min(window.innerHeight - win.offsetTop - 8, oh + e.clientY - sy)) + "px";
    });
    const stop = () => { if (resizing) { resizing = false; S.el.classList.remove("dragging"); win._rect = null; } };
    grip.addEventListener("pointerup", stop);
    grip.addEventListener("pointercancel", stop);
  }

  /** Fenêtre de contenu (blocs) — crée ou met à jour. Un média déjà affiché n'est pas rouvert : on remonte sa fenêtre. */
  function showWindow(args) {
    const blocks = args.blocks || [];
    const mediaSrcs = blocks.filter((b) => ["image", "video", "audio"].includes(b.kind) && b.src).map((b) => b.src.replace(/^https?:\/\/[^/]+/, ""));
    if (mediaSrcs.length && mediaSrcs.length === blocks.length) {
      const existing = mediaSrcs.map((s) => S.mediaIndex && S.mediaIndex.get(s)).find((wid) => wid && S.windows.has(wid));
      if (existing) { restoreWindow(S.windows.get(existing)); return existing; }
    }
    const id = String(args.id || ("w" + (++S.winCount))).replace(/[^\w-]/g, "_");
    const width = Math.max(240, Math.min(520, Number(args.width) || 320));
    S.mediaIndex = S.mediaIndex || new Map();
    for (const s of mediaSrcs) S.mediaIndex.set(s, id);
    let win = S.windows.get(id);
    if (!win) win = createWindow({ id, title: args.title || id, kind: "content", width, position: args.position });
    else { win.querySelector("b").textContent = args.title || id; restoreWindow(win); }
    win.querySelector(".jv-win-body").innerHTML = renderBlocks(args.blocks || []);
    win.querySelectorAll(".jv-img").forEach((img) => img.addEventListener("click", () => window.open(img.src, "_blank")));
    focusWindow(win);
    keepInView(win);
    return id;
  }
  /** La fenêtre est placée avant d'avoir son contenu : une fois remplie, on la remonte pour qu'elle tienne à l'écran. */
  function keepInView(win) {
    const r = win.getBoundingClientRect();
    if (!r.height) return;
    const maxTop = window.innerHeight - r.height - 14;
    if (r.top > maxTop) win.style.top = Math.max(56, maxTop) + "px";
    const maxLeft = window.innerWidth - r.width - 12;
    if (r.left > maxLeft) win.style.left = Math.max(8, maxLeft) + "px";
  }

  /**
   * Monte la page dans la fenêtre, MISE À L'ÉCHELLE : la page est rendue à sa largeur « bureau » (VIRTUAL_W)
   * puis réduite pour tenir en entier dans la fenêtre — on voit toute la page sans agrandir ni défiler en largeur.
   * L'échelle suit le redimensionnement (1 = taille réelle quand la fenêtre est assez large).
   */
  const VIRTUAL_W = 1180;
  function mountFrame(win, src) {
    const body = win.querySelector(".jv-win-body");
    body.innerHTML = "";
    const iframe = document.createElement("iframe");
    iframe.setAttribute("allow", "clipboard-read; clipboard-write");
    iframe.src = src;
    body.appendChild(iframe);
    win._src = src;
    win._els = null;
    const fit = () => {
      const w = body.clientWidth, h = body.clientHeight;
      if (!w || !h) return;
      const s = Math.min(1, w / VIRTUAL_W);
      iframe.style.transformOrigin = "0 0";
      if (s >= 1) { iframe.style.width = "100%"; iframe.style.height = "100%"; iframe.style.transform = "none"; }
      else { iframe.style.width = VIRTUAL_W + "px"; iframe.style.height = Math.ceil(h / s) + "px"; iframe.style.transform = `scale(${s})`; }
    };
    if (win._ro) win._ro.disconnect();
    win._ro = new ResizeObserver(fit);
    win._ro.observe(body);
    fit();
    return iframe;
  }

  /** Ouvre une page ; si sa fenêtre existe déjà, la recharge sur la nouvelle cible (iframe neuve = état à jour). */
  function showPage(page, query, title) {
    const existing = S.windows.get("page-" + page);
    if (!existing) return openPage(page, query, title);
    mountFrame(existing, "/?embed=1#/" + page + (query ? "?" + String(query).replace(/^\?/, "") : ""));
    restoreWindow(existing);
    return "page-" + page;
  }
  /** Fenêtre d'une machine, directement sur son run. */
  function showMachine(machine, runId) {
    return showPage(machine, runId ? "run=" + runId : "");
  }

  /** Fenêtre « page » : une page de la plateforme embarquée (iframe ?embed=1). */
  function openPage(page, query, title, maximize) {
    const id = "page-" + page;
    const src = "/?embed=1#/" + page + (query ? "?" + String(query).replace(/^\?/, "") : "");
    let win = S.windows.get(id);
    if (win) {
      restoreWindow(win);
      if (query && win._src !== src) mountFrame(win, src);
      if (maximize) maximizeWindow(win, true);
      return id;
    }
    // Moitié droite (le cœur glisse à gauche). Fenêtre de bonne taille, page entière visible grâce à la mise à l'échelle.
    const W = window.innerWidth, H = window.innerHeight;
    const width = Math.max(620, Math.min(1120, Math.round(W * 0.56)));
    const height = Math.max(380, Math.min(860, Math.round(H * 0.76)));
    win = createWindow({ id, title: title || PAGES[page] || page, kind: "page", width, height, position: "top-right" });
    const n = [...S.windows.values()].filter((w) => w.classList.contains("page")).length - 1;
    win.style.left = Math.max(8, W - width - 18 - n * 28) + "px";
    win.style.top = 60 + n * 24 + "px";
    syncLayout();
    mountFrame(win, src);
    if (maximize) maximizeWindow(win, true);
    return id;
  }

  // ────────────────────────────────────────────────────────────── Lire / manipuler une fenêtre (page_read, page_act)
  // Cible : une fenêtre de l'appel (par id), sinon la fenêtre de page au premier plan, sinon la fenêtre au
  // premier plan. `site` (non documenté) = la page de la SPA derrière l'overlay, pour le mode réduit.
  const SITE = { site: true, _els: null };
  function targetWindow(id) {
    if (id && /^(site|main)$/i.test(String(id))) return SITE;
    if (id && S.windows.has(id)) return S.windows.get(id);
    if (id && S.windows.has("page-" + id)) return S.windows.get("page-" + id);
    const all = [...S.el.querySelectorAll("#jv-windows .jv-win:not(.min)")].reverse(); // dernier du conteneur = premier plan
    return all.find((w) => w.classList.contains("page")) || all[0] || null;
  }
  const clean = (s, n = 70) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
  function labelOf(el) {
    let lab = el.getAttribute("aria-label") || el.placeholder || "";
    const wrap = el.closest("label, .field, .kie-f, .jv-set-row, .fbar-item");
    if (wrap) {
      const cap = [...wrap.querySelectorAll("span, .l, .lbl, b")].find((x) => !x.contains(el) && clean(x.textContent));
      if (cap) lab = clean(cap.textContent, 40) + (lab ? " (" + clean(lab, 30) + ")" : "");
    }
    return clean(lab || el.name || el.id || "champ", 70);
  }
  function describeEl(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") {
      const type = el.type || "text";
      if (type === "file" || type === "hidden") return null;
      if (type === "checkbox" || type === "radio") return `[case] ${labelOf(el)} = ${el.checked ? "coché" : "décoché"}`;
      if (type === "range") return `[curseur] ${labelOf(el)} = ${el.value} (${el.min}–${el.max})`;
      return `[champ] ${labelOf(el)} = « ${clean(el.value, 60)} »`;
    }
    if (tag === "select") return `[liste] ${labelOf(el)} = ${clean(el.options[el.selectedIndex] && el.options[el.selectedIndex].text, 40)} (options : ${[...el.options].slice(0, 14).map((o) => clean(o.text, 28)).join(" | ")})`;
    const t = clean(el.innerText || el.textContent) || clean(el.title) || clean(el.getAttribute("aria-label"));
    if (!t) return null;
    const kind = tag === "a" ? "lien" : el.classList.contains("active") ? "actif" : tag === "summary" ? "déplier" : "bouton";
    return `[${kind}] ${t}${el.disabled ? " (désactivé)" : ""}`;
  }
  const OVERLAY_SEL = ".pop-overlay, .picker-overlay, .lightbox";
  function collectEls(win) {
    let doc = null;
    const site = win === SITE;
    if (!site && win.classList.contains("page")) { try { doc = win.querySelector("iframe").contentDocument; } catch {} }
    const root = site ? document.body : doc ? doc.body : win.querySelector(".jv-win-body");
    if (!root) return { root: null, items: [] };
    const view = doc ? doc.defaultView : window;
    const SEL = "button, a[href], [role=button], input, textarea, select, summary, [data-run], [data-open], [data-chan], [data-vid], [data-m], [data-tab], [data-c], [data-nav], .chip, .scrap-row, .kie-row, .bank-folder, .tool-card, .chan-tab, .niche-card, .acc-head";
    // Site (mode réduit) : on ne liste ni Jarvis lui-même, ni les toasts, ni le menu — le sélecteur d'OS
    // (YouTube/TikTok) et la barre (Actualiser, thème) restent atteignables.
    const skip = site ? "#jarvis, #toasts, #nav, .sidebar-foot, .brand" : ".sidebar, .topbar, #toasts";
    const items = [];
    for (const el of root.querySelectorAll(SEL)) {
      if (el.closest(skip)) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const st = view.getComputedStyle(el);
      if (st.visibility === "hidden" || st.display === "none") continue;
      const d = describeEl(el);
      if (d) items.push({ el, d });
      if (items.length >= 110) break;
    }
    return { root, items, doc: site ? document : doc };
  }
  function pageRead(args) {
    const win = targetWindow(args.id);
    if (!win) return { error: args.id ? `Fenêtre « ${args.id} » inconnue. Ouvertes : ${[...S.windows.keys()].join(", ") || "aucune"}.` : "Aucune fenêtre ouverte. Ouvre d'abord une page avec open_page." };
    const { root, items, doc } = collectEls(win);
    if (!root) return { error: "Fenêtre illisible (page encore en chargement ?). Réessaie dans un instant." };
    win._els = items.map((x) => x.el);
    // Un assistant ouvert par-dessus la page (pop-up, wizard de run, sélecteur) : c'est lui qui est au premier plan
    const overlay = doc && [...doc.querySelectorAll(OVERLAY_SEL)].pop();
    const site = win === SITE;
    const main = site ? document.querySelector("#view") : root;
    const text = clean((overlay || main || root).innerText, 2600);
    const page = site ? (AgentOS.state.page || "dashboard") : win._src ? win._src.split("#/")[1] : undefined;
    return {
      id: site ? "site" : win.dataset.id, scope: site ? "site" : "window",
      title: site ? (document.querySelector("#page-title") || {}).textContent : win.querySelector(".jv-win-head b").textContent, page,
      overlayOpen: !!overlay, text, elements: items.map((x, i) => `${i + 1}. ${x.d}`),
      note: `Pour agir : page_act {id:'${site ? "site" : win.dataset.id}', action, target: numéro ou texte}.`,
    };
  }
  async function pageAct(args) {
    const win = targetWindow(args.id);
    if (!win) return { error: args.id ? `Fenêtre « ${args.id} » inconnue.` : "Aucune fenêtre ouverte. Ouvre d'abord une page avec open_page." };
    const target = String(args.target ?? "").trim();
    let el = null;
    if (/^\d+$/.test(target) && win._els && win._els[Number(target) - 1] && win._els[Number(target) - 1].isConnected) el = win._els[Number(target) - 1];
    if (!el) {
      const { items } = collectEls(win);
      const t = target.toLowerCase();
      const body = (x) => x.d.replace(/^\[[^\]]+\]\s*/, "").toLowerCase();
      const want = args.action === "click" ? (x) => !/^\[(champ|liste|curseur)\]/.test(x.d) : args.action === "select" ? (x) => /^\[liste\]/.test(x.d) : args.action === "check" ? (x) => /^\[case\]/.test(x.d) : (x) => /^\[(champ|curseur)\]/.test(x.d);
      const pool = items.filter(want);
      const hit = pool.find((x) => body(x) === t) || pool.find((x) => body(x).startsWith(t)) || pool.find((x) => body(x).includes(t)) || items.find((x) => body(x).includes(t));
      el = hit && hit.el;
    }
    if (!el) return { error: `Élément « ${target} » introuvable ${win === SITE ? "sur la page du site" : "dans la fenêtre"}. Fais page_read pour voir les éléments disponibles.` };
    const fire = (name) => el.dispatchEvent(new (el.ownerDocument.defaultView.Event)(name, { bubbles: true }));
    try { el.scrollIntoView({ block: "center" }); } catch {}
    const what = describeEl(el) || el.tagName;
    if (args.action === "click") el.click();
    else if (args.action === "fill") {
      const proto = el.tagName === "TEXTAREA" ? el.ownerDocument.defaultView.HTMLTextAreaElement.prototype : el.ownerDocument.defaultView.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value");
      el.focus();
      setter && setter.set ? setter.set.call(el, String(args.value ?? "")) : (el.value = String(args.value ?? ""));
      fire("input"); fire("change");
    } else if (args.action === "select") {
      const v = String(args.value ?? "").toLowerCase();
      const opt = [...el.options].find((o) => o.text.toLowerCase() === v || o.value.toLowerCase() === v) || [...el.options].find((o) => o.text.toLowerCase().includes(v));
      if (!opt) return { error: `Option « ${args.value} » absente. Options : ${[...el.options].map((o) => clean(o.text, 30)).join(" | ")}` };
      el.value = opt.value;
      fire("input"); fire("change");
    } else if (args.action === "check") {
      const wantOn = !/^(false|0|non|off)$/i.test(String(args.value ?? "true"));
      if (el.checked !== wantOn) el.click();
    }
    await new Promise((r) => setTimeout(r, 900)); // laisse la page réagir (rendu, appel API)
    const after = pageRead({ id: win === SITE ? "site" : win.dataset.id });
    return { ok: true, did: `${args.action} → ${what}`, page: after.error ? after.error : { page: after.page, overlayOpen: after.overlayOpen, text: after.text.slice(0, 900), elements: after.elements.slice(0, 40) } };
  }

  const isNum = (v) => typeof v === "number" || (typeof v === "string" && /^[\d\s.,%€$kKMx×+-]+$/.test(v) && /\d/.test(v));
  function inline(s) {
    let h = esc(String(s ?? ""));
    h = h.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    h = h.replace(/(https?:\/\/[^\s<)]+)/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u.replace(/^https?:\/\//, "").slice(0, 48)}</a>`);
    return h;
  }
  function renderBlocks(blocks) {
    return blocks.map((b) => {
      switch (b.kind) {
        case "kv":
          return `<table class="jv-kv">${(b.rows || []).map((r) => `<tr><th>${inline(r[0])}</th><td class="${isNum(r[1]) ? "num" : ""}">${inline(r[1])}</td></tr>`).join("")}</table>`;
        case "table":
          return `<table class="jv-table">${b.columns ? `<thead><tr>${b.columns.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead>` : ""}<tbody>${(b.rows || []).map((r) => `<tr>${(Array.isArray(r) ? r : [r]).map((c, i) => `<${i === 0 ? "th" : "td"} class="${isNum(c) ? "num" : ""}">${inline(c)}</${i === 0 ? "th" : "td"}>`).join("")}</tr>`).join("")}</tbody></table>`;
        case "stats":
          return `<div class="jv-stats">${(b.stats || []).map((s) => `<div class="jv-stat"><div class="v">${inline(s.value)}</div><div class="l">${inline(s.label)}</div></div>`).join("")}</div>`;
        case "list":
          return `<ul class="jv-list">${(b.items || []).map((i) => `<li>${inline(i)}</li>`).join("")}</ul>`;
        case "checklist":
          return `<ul class="jv-check">${(b.rows || []).map((r) => { const [t, done] = Array.isArray(r) ? r : [r, false]; return `<li class="${done ? "done" : ""}"><span class="box">${done ? "✓" : ""}</span><span>${inline(t)}</span></li>`; }).join("")}</ul>`;
        case "text":
          return `<div class="jv-text-block">${inline(b.text)}</div>`;
        case "image":
          return `<div><img class="jv-img" src="${esc(b.src || "")}" alt="">${b.caption ? `<div class="jv-cap">${inline(b.caption)}</div>` : ""}</div>`;
        case "video":
          return `<div><video class="jv-video" src="${esc(b.src || "")}" controls autoplay muted playsinline></video>${b.caption ? `<div class="jv-cap">${inline(b.caption)}</div>` : ""}</div>`;
        case "audio":
          return `<div class="jv-audio">${b.caption ? `<div class="jv-cap" style="margin:0 0 6px">${inline(b.caption)}</div>` : ""}<audio src="${esc(b.src || "")}" controls autoplay></audio></div>`;
        case "links":
          return `<div class="jv-links">${(b.links || []).map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${inline(l.title || l.url)}</a>`).join(" · ")}</div>`;
        default:
          return `<div class="jv-text-block">${inline(b.text || JSON.stringify(b))}</div>`;
      }
    }).join("");
  }

  // ────────────────────────────────────────────────────────────── Démo visuelle (sans OpenAI)
  // http://localhost:4200/?jvdemo=1 : overlay, cœur, fenêtres (dont une page embarquée) et actions factices.
  function demo() {
    build();
    S.el.hidden = false;
    setMode("full");
    S.startedAt = Date.now() - 297000;
    setState("speaking");
    S.orb.start();
    startTimer();
    ["Programme du jour", "Rechercher : nouveautés Gemini", "Second cerveau : machine POV"].forEach((l) => addTask(l).done(true));
    addTask("Ouvrir POV");
    renderUser("ouvre la machine POV et montre-moi les infos IA de la semaine");
    renderSub("J'ouvre la machine POV dans une fenêtre, Monsieur, et voici les quatre informations IA de la semaine.");
    showWindow({ id: "infos", title: "IA, les 4 infos de la semaine", position: "top-right", width: 400, blocks: [
      { kind: "table", rows: [["Gemini", "1 milliard d'utilisateurs, 150M d'images/jour"], ["ChatGPT", "pub sur les comptes Free et Go dès fin août"], ["UE, Article 50", "contenus générés par IA à déclarer obligatoirement"], ["Cadence", "8 modèles majeurs sortis en 6 jours"]] },
      { kind: "links", links: [{ title: "Blog du Modérateur, IA", url: "https://www.blogdumoderateur.com" }] },
    ] });
    showWindow({ id: "programme", title: "Programme du jour", position: "left", width: 360, blocks: [
      { kind: "stats", stats: [{ value: "3", label: "priorités" }, { value: "1", label: "faite" }] },
      { kind: "checklist", rows: [["Tester Jarvis (voix, fenêtres, contrôle du PC)", true], ["Tourner : vidéo accueil Club IA VIP", false], ["Trier les leads à relancer", false]] },
    ] });
    openPage("pov", "", "Machine POV");
  }

  // ────────────────────────────────────────────────────────────── Boot
  function boot() {
    if (AgentOS.embed) return; // page embarquée dans une fenêtre de l'appel : pas de Jarvis imbriqué
    build();
    const qs = new URLSearchParams(location.search);
    const demoMode = qs.get("jvdemo");
    if (demoMode) setTimeout(() => { demo(); if (demoMode === "mini") setMode("mini"); }, 300);
    if (qs.get("jvauto")) setTimeout(open, 400); // ?jvauto=1 : appelle Jarvis dès l'ouverture
    S.debug = !!qs.get("jvdebug");
    document.getElementById("btn-jarvis")?.addEventListener("click", () => (connected() || S.connecting ? setMode("full") : open()));
    window.addEventListener("keydown", (e) => {
      if (e.altKey && e.key.toLowerCase() === "j") { e.preventDefault(); toggle(); }
      if (e.key === "Escape" && connected() && S.mode === "full" && !S.textOpen) setMode("mini");
    });
    // Bouton de la barre : reflète l'état (en appel / raccroché)
    const sync = () => document.getElementById("btn-jarvis")?.classList.toggle("on", connected() || S.connecting);
    new MutationObserver(sync).observe(S.el, { attributes: true, attributeFilter: ["data-state"] });
  }

  return { open, close, toggle, setMode, showWindow, openPage, showPage, closeWindow, settingsForm, state: S, boot, demo, _tool: runClientTool, _sse: openSSE };
})();
