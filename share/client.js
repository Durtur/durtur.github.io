/* Ogreforge Share — web viewer. Connects to a host peer by session id and shows its images. */
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
    $("viewer").hidden = false;
    const stage = $("stage");
    const imgEl = $("image");
    const zoomLabel = document.querySelector(".zoom-label");
    const pz = new PanZoom(stage, imgEl, {
        onChange: ({ scale }) => { zoomLabel.textContent = Math.round(scale * 100) + "%"; },
    });

    const items = new Map(); // id -> { id, name, w, h, url, el }
    let order = [];
    let current = null;
    let hostFocus = null;
    let follow = true;
    let peer = null;
    let conn = null;
    let retryTimer = null;
    let everConnected = false;

    function toast(msg) {
        const t = $("toast");
        t.textContent = msg;
        t.classList.add("show");
        clearTimeout(toast._t);
        toast._t = setTimeout(() => t.classList.remove("show"), 2200);
    }

    function setStatus(state, label) {
        const s = $("status");
        s.dataset.state = state;
        s.querySelector(".label").textContent = label;
    }

    function setEmpty(title, text, spinner) {
        $("emptyTitle").textContent = title;
        $("emptyText").textContent = text;
        document.querySelector("#emptyState .spinner").hidden = !spinner;
        $("emptyState").hidden = false;
    }

    // ---------- rendering ----------
    function renderStrip() {
        const strip = $("strip");
        strip.hidden = order.length < 2;
        strip.replaceChildren(...order.map((id) => {
            const it = items.get(id);
            if (!it.el) {
                const b = document.createElement("button");
                b.className = "thumb";
                b.title = it.name;
                b.addEventListener("click", () => {
                    if (follow && id !== hostFocus) setFollow(false);
                    select(id);
                });
                it.el = b;
            }
            it.el.classList.toggle("is-loading", !it.url);
            it.el.classList.toggle("is-active", id === current);
            let badge = it.el.querySelector(".badge");
            if (id === hostFocus && !badge) {
                badge = document.createElement("span");
                badge.className = "badge";
                badge.textContent = "Live";
                it.el.append(badge);
            } else if (id !== hostFocus && badge) badge.remove();
            if (it.url && !it.el.querySelector("img")) {
                const im = new Image();
                im.src = it.url;
                im.alt = "";
                it.el.prepend(im);
            }
            return it.el;
        }));
        const multi = order.length > 1;
        $("prevBtn").hidden = $("nextBtn").hidden = !multi;
    }

    function select(id) {
        if (!items.has(id)) return;
        const changed = id !== current;
        current = id;
        const it = items.get(id);
        $("imageTitle").textContent = it.name;
        document.title = it.name + " · Ogreforge Share";
        if (it.url) {
            $("progress").hidden = true;
            $("emptyState").hidden = true;
            $("zoombar").hidden = false;
            if (changed || imgEl.src !== it.url) pz.show(it.url);
        } else {
            $("progress").hidden = false;
        }
        renderStrip();
        const el = it.el;
        if (el) el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    }

    function step(dir) {
        if (order.length < 2) return;
        const i = order.indexOf(current);
        const next = order[(i + dir + order.length) % order.length];
        if (follow) setFollow(false);
        select(next);
    }

    function setFollow(on) {
        follow = on;
        $("followBtn").classList.toggle("is-on", on);
        if (on && hostFocus) select(hostFocus);
        toast(on ? "Following the host" : "Browsing freely");
    }

    function showNothingShared() {
        current = null;
        pz.clear();
        $("zoombar").hidden = true;
        $("progress").hidden = true;
        $("imageTitle").textContent = "";
        setEmpty("Waiting for images", "You're connected. The host hasn't shared anything yet.", true);
    }

    // ---------- protocol ----------
    function handle(msg) {
        if (!msg || typeof msg !== "object") return;
        switch (msg.t) {
            case "hello":
                $("hostName").textContent = msg.name ? "· " + msg.name : "";
                break;

            case "list": {
                const ids = new Set(msg.items.map((x) => x.id));
                for (const [id, it] of items) {
                    if (!ids.has(id)) { if (it.url) URL.revokeObjectURL(it.url); items.delete(id); }
                }
                for (const x of msg.items) {
                    const it = items.get(x.id);
                    if (it) Object.assign(it, { name: x.name, w: x.w, h: x.h });
                    else items.set(x.id, { ...x, url: null, el: null });
                }
                order = msg.items.map((x) => x.id);
                hostFocus = msg.focus || null;
                if (!order.length) { renderStrip(); showNothingShared(); break; }
                if (follow && hostFocus) select(hostFocus);
                else if (!current || !items.has(current)) select(hostFocus || order[0]);
                else renderStrip();
                break;
            }

            case "img": {
                const it = items.get(msg.id) || { id: msg.id, name: msg.name, el: null };
                if (it.url) URL.revokeObjectURL(it.url);
                it.url = URL.createObjectURL(new Blob([msg.data], { type: msg.mime || "image/png" }));
                it.mime = msg.mime;
                items.set(msg.id, it);
                if (!order.includes(msg.id)) order.push(msg.id);
                if (msg.id === current || !current) select(msg.id);
                else renderStrip();
                break;
            }

            case "focus":
                hostFocus = msg.id;
                if (follow && msg.id) select(msg.id);
                else renderStrip();
                break;

            case "bye":
                setStatus("offline", "Host ended");
                toast("The host ended the session");
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
                    if (!everConnected) {
                        setEmpty("Host not found", "The session may have ended, or the host app isn't running yet. Retrying…", true);
                    }
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
            if (!order.length) setEmpty("Waiting for images", "You're connected. The host hasn't shared anything yet.", true);
            const have = [...items.values()].filter((it) => it.url).map((it) => it.id);
            c.send({ t: "hi", have });
        });
        c.on("data", handle);
        c.on("close", () => {
            clearTimeout(timeout);
            if (c !== conn) return;
            setStatus("offline", "Disconnected");
            scheduleRetry(3000);
        });
        c.on("error", (e) => console.warn("conn error", e));
    }

    // ---------- UI wiring ----------
    $("followBtn").addEventListener("click", () => setFollow(!follow));
    $("prevBtn").addEventListener("click", () => step(-1));
    $("nextBtn").addEventListener("click", () => step(1));

    function download() {
        const it = items.get(current);
        if (!it || !it.url) return;
        const a = document.createElement("a");
        a.href = it.url;
        a.download = it.name || "image";
        a.click();
    }

    function fullscreen() {
        if (document.fullscreenElement) document.exitFullscreen();
        else stage.requestFullscreen?.().catch(() => {});
    }

    $("zoombar").addEventListener("click", (e) => {
        const act = e.target.closest("[data-act]")?.dataset.act;
        if (act === "in") pz.zoomBy(1.4);
        else if (act === "out") pz.zoomBy(1 / 1.4);
        else if (act === "fit") pz.fit(true);
        else if (act === "actual") pz.actualSize();
        else if (act === "download") download();
        else if (act === "fullscreen") fullscreen();
    });

    document.addEventListener("keydown", (e) => {
        if (e.target.closest("input, textarea")) return;
        switch (e.key) {
            case "ArrowLeft": step(-1); break;
            case "ArrowRight": step(1); break;
            case "+": case "=": pz.zoomBy(1.4); break;
            case "-": pz.zoomBy(1 / 1.4); break;
            case "0": pz.fit(true); break;
            case "1": pz.actualSize(); break;
            case "f": case "F": setFollow(!follow); break;
            default: return;
        }
        e.preventDefault();
    });

    window.addEventListener("beforeunload", () => peer && peer.destroy());

    if (typeof Peer === "undefined") {
        setStatus("offline", "Error");
        setEmpty("Couldn't load", "The peer-to-peer library failed to load. Check your connection and reload.", false);
    } else {
        connect();
    }
})();
