/* Scry — web viewer. Connects to a host peer by session id and shows whatever it presents. */
(function () {
    "use strict";

    const $ = (id) => document.getElementById(id);
    const ID_RE = /^[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)*$/;

    // ---------- session id ----------
    function extractId(raw) {
        raw = (raw || "").trim();
        if (!raw) return "";
        try {
            const u = new URL(raw);
            raw = u.searchParams.get("id") || u.hash.replace(/^#/, "") || "";
        } catch (_) { /* not a URL — treat as bare id */ }
        return ID_RE.test(raw) ? raw : "";
    }

    const params = new URLSearchParams(location.search);
    const sessionId = extractId(params.get("id") || location.hash.replace(/^#/, ""));

    if (!sessionId) {
        $("join").hidden = false;
        $("joinForm").addEventListener("submit", (e) => {
            e.preventDefault();
            const id = extractId($("joinInput").value);
            if (!id) {
                $("joinError").textContent = "That doesn't look like a valid session code or link.";
                $("joinError").hidden = false;
                return;
            }
            location.search = "?id=" + encodeURIComponent(id);
        });
        $("joinInput").focus();
        return;
    }

    // ---------- viewer state ----------
    const stage = $("stage");
    stage.hidden = false;
    const pz = new PanZoom(stage, $("image"));

    const images = new Map(); // id -> { name, url }  (all host images, preloaded for instant switching)
    let focus = null;          // id the host is presenting
    let shown = null;          // url currently on screen
    let hostName = "";
    let peer = null;
    let conn = null;
    let retryTimer = null;
    let everConnected = false;

    function setStatus(state, label) {
        const s = $("status");
        s.dataset.state = state;
        s.querySelector(".label").textContent = label;
        s.hidden = state === "online";
    }

    function setEmpty(title, text) {
        $("emptyTitle").textContent = title;
        $("emptyText").textContent = text;
        $("emptyState").hidden = false;
    }

    function render() {
        const it = focus && images.get(focus);
        if (it && it.url) {
            $("emptyState").hidden = true;
            if (shown !== it.url) { shown = it.url; pz.show(it.url); }
            document.title = it.name + (hostName ? " · " + hostName : "");
            return;
        }
        if (!it) { shown = null; pz.clear(); }
        if (everConnected) {
            setEmpty(it ? "Receiving image…" : "Waiting for the host",
                it ? "Almost there." : "Nothing is being shown right now.");
        }
    }

    // ---------- protocol ----------
    function handle(msg) {
        if (!msg || typeof msg !== "object") return;
        switch (msg.t) {
            case "hello":
                hostName = msg.name || "";
                render();
                break;
            case "list": {
                const ids = new Set(msg.items.map((x) => x.id));
                for (const [id, it] of images) {
                    if (!ids.has(id)) { if (it.url) URL.revokeObjectURL(it.url); images.delete(id); }
                }
                for (const x of msg.items) if (!images.has(x.id)) images.set(x.id, { name: x.name, url: null });
                focus = msg.focus || null;
                render();
                break;
            }
            case "img": {
                const old = images.get(msg.id);
                if (old && old.url) URL.revokeObjectURL(old.url);
                images.set(msg.id, {
                    name: msg.name,
                    url: URL.createObjectURL(new Blob([msg.data], { type: msg.mime || "image/png" })),
                });
                if (msg.id === focus) render();
                break;
            }
            case "focus":
                focus = msg.id || null;
                render();
                break;
            case "bye":
                setStatus("offline", "Host ended the session");
                break;
        }
    }

    // ---------- connection ----------
    function scheduleRetry(ms) {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(connect, ms);
    }

    function connect() {
        clearTimeout(retryTimer);
        if (!peer || peer.destroyed) {
            peer = new Peer();
            peer.on("open", openConnection);
            peer.on("disconnected", () => { if (!peer.destroyed) peer.reconnect(); });
            peer.on("error", (err) => {
                if (err.type === "peer-unavailable") {
                    setStatus("offline", "Host offline");
                    if (!everConnected) setEmpty("Host not found", "The session may have ended, or the host app isn't running yet. Retrying…");
                    scheduleRetry(4000);
                } else if (["network", "server-error", "socket-error", "socket-closed"].includes(err.type)) {
                    setStatus("offline", "Network issue");
                    peer.destroy();
                    scheduleRetry(5000);
                } else {
                    console.warn("peer error", err);
                }
            });
        } else if (peer.open) {
            openConnection();
        }
    }

    function openConnection() {
        if (conn && conn.open) return;
        setStatus("connecting", everConnected ? "Reconnecting" : "Connecting");
        conn = peer.connect(sessionId, { reliable: true });
        const c = conn;
        const timeout = setTimeout(() => { if (!c.open) { c.close(); scheduleRetry(1000); } }, 15000);
        c.on("open", () => {
            clearTimeout(timeout);
            everConnected = true;
            setStatus("online", "Live");
            render();
            const have = [...images].filter(([, it]) => it.url).map(([id]) => id);
            c.send({ t: "hi", have });
        });
        c.on("data", handle);
        c.on("close", () => {
            clearTimeout(timeout);
            if (c !== conn) return;
            setStatus("offline", "Disconnected — retrying");
            scheduleRetry(3000);
        });
        c.on("error", (e) => console.warn("conn error", e));
    }

    // Keyboard zoom for desktop viewers; wheel, drag, pinch and double-tap are handled by PanZoom.
    document.addEventListener("keydown", (e) => {
        if (e.key === "+" || e.key === "=") pz.zoomBy(1.4);
        else if (e.key === "-") pz.zoomBy(1 / 1.4);
        else if (e.key === "0") pz.fit(true);
        else return;
        e.preventDefault();
    });

    window.addEventListener("beforeunload", () => peer && peer.destroy());

    if (typeof Peer === "undefined") {
        setStatus("offline", "Error");
        setEmpty("Couldn't load", "The peer-to-peer library failed to load. Check your connection and reload.");
    } else {
        connect();
    }
})();
