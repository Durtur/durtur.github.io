/* Ogreforge Share — host renderer. Runs a PeerJS peer and streams images to connected viewers. */
(async function () {
    "use strict";

    const $ = (id) => document.getElementById(id);
    const cfg = await window.host.config();

    const MAX_DIM = 4096;               // longest side we send without re-encoding
    const MAX_BYTES = 8 * 1024 * 1024;  // files above this get re-encoded
    const SAFE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"];

    // ---------- state ----------
    let sessionId = localStorage.getItem("share.sessionId") || crypto.randomUUID();
    localStorage.setItem("share.sessionId", sessionId);
    let sessionName = localStorage.getItem("share.name") || "";

    /** @type {{id:string,name:string,mime:string,w:number,h:number,data:ArrayBuffer,url:string,el?:HTMLElement}[]} */
    const images = [];
    let focusId = null;
    let peer = null;
    let idRetries = 0;
    const conns = new Set();

    const stage = $("stage");
    const imgEl = $("image");
    const zoomLabel = document.querySelector(".zoom-label");
    const pz = new PanZoom(stage, imgEl, {
        onChange: ({ scale }) => { zoomLabel.textContent = Math.round(scale * 100) + "%"; },
    });

    // ---------- helpers ----------
    function toast(msg) {
        const t = $("toast");
        t.textContent = msg;
        t.classList.add("show");
        clearTimeout(toast._t);
        toast._t = setTimeout(() => t.classList.remove("show"), 2000);
    }

    function setStatus(state, label) {
        $("status").dataset.state = state;
        $("status").querySelector(".label").textContent = label;
        $("qrBtn").classList.toggle("is-offline", state !== "online");
    }

    const shareLink = () => {
        const u = new URL(cfg.shareUrl);
        u.searchParams.set("id", sessionId);
        return u.toString();
    };

    // ---------- session / QR ----------
    async function renderSession() {
        const link = shareLink();
        $("linkText").textContent = link;
        $("linkText").title = link;
        $("qrBigLink").textContent = link;
        $("qrImg").src = await window.host.qr(link, { width: 440 });
    }

    $("copyLinkBtn").addEventListener("click", async () => {
        await window.host.copyText(shareLink());
        toast("Link copied");
    });
    $("copyCodeBtn").addEventListener("click", async () => {
        await window.host.copyText(sessionId);
        toast("Session code copied");
    });
    $("copyQrBtn").addEventListener("click", async () => {
        await window.host.copyImage(await window.host.qr(shareLink(), { width: 720 }));
        toast("QR code image copied");
    });
    $("openBtn").addEventListener("click", () => window.host.openExternal(shareLink()));

    $("qrBtn").addEventListener("click", async () => {
        $("qrBig").src = await window.host.qr(shareLink(), { width: 1000 });
        $("qrModal").hidden = false;
    });
    $("qrModal").addEventListener("click", () => { $("qrModal").hidden = true; });

    $("nameInput").value = sessionName;
    $("nameInput").addEventListener("input", (e) => {
        sessionName = e.target.value.trim();
        localStorage.setItem("share.name", sessionName);
        clearTimeout(renderSession._nameT);
        renderSession._nameT = setTimeout(() => broadcast({ t: "hello", name: sessionName }), 400);
    });

    $("newSessionBtn").addEventListener("click", () => {
        if (conns.size && !confirm(`Start a new session? ${conns.size} viewer(s) will be disconnected and the old link will stop working.`)) return;
        sessionId = crypto.randomUUID();
        localStorage.setItem("share.sessionId", sessionId);
        startPeer();
        toast("New session code created");
    });

    // ---------- networking ----------
    function updateViewers() {
        $("viewerCount").textContent = conns.size;
        $("viewers").classList.toggle("has-viewers", conns.size > 0);
    }

    const listMsg = () => ({
        t: "list",
        focus: focusId,
        items: images.map(({ id, name, w, h }) => ({ id, name, w, h })),
    });
    const imgMsg = (im) => ({ t: "img", id: im.id, name: im.name, mime: im.mime, w: im.w, h: im.h, data: im.data });

    function send(conn, msg) {
        try { if (conn.open) conn.send(msg); } catch (e) { console.warn("send failed", e); }
    }

    function broadcast(msg) {
        for (const c of conns) if (c.ready) send(c, msg);
    }

    function greet(conn, have = []) {
        if (conn.ready) return;
        conn.ready = true;
        send(conn, { t: "hello", name: sessionName });
        send(conn, listMsg());
        const haveSet = new Set(have);
        // Send the presented image first so the viewer sees something right away.
        const queue = [...images].sort((a, b) => (b.id === focusId) - (a.id === focusId));
        for (const im of queue) if (!haveSet.has(im.id)) send(conn, imgMsg(im));
    }

    function onConnection(conn) {
        conn.on("open", () => {
            conns.add(conn);
            updateViewers();
            toast("A viewer joined");
            // Viewers say "hi" with the images they already have; fall back if they don't.
            conn._greetT = setTimeout(() => greet(conn), 1500);
        });
        conn.on("data", (msg) => {
            if (msg && msg.t === "hi") {
                clearTimeout(conn._greetT);
                greet(conn, Array.isArray(msg.have) ? msg.have : []);
            }
        });
        const drop = () => {
            clearTimeout(conn._greetT);
            if (conns.delete(conn)) updateViewers();
        };
        conn.on("close", drop);
        conn.on("error", drop);
    }

    function startPeer() {
        if (peer) {
            broadcast({ t: "bye" });
            for (const c of conns) c.close();
            conns.clear();
            updateViewers();
            peer.destroy();
        }
        renderSession();
        setStatus("connecting", "Connecting");
        const p = new Peer(sessionId);
        peer = p;
        p.on("open", () => {
            if (p !== peer) return;
            idRetries = 0;
            setStatus("online", "Online");
        });
        p.on("connection", onConnection);
        p.on("disconnected", () => {
            if (p !== peer || p.destroyed) return;
            setStatus("connecting", "Reconnecting");
            setTimeout(() => { if (p === peer && !p.destroyed) p.reconnect(); }, 1000);
        });
        p.on("error", (err) => {
            if (p !== peer) return;
            console.warn("peer error", err.type, err);
            if (err.type === "unavailable-id") {
                // The signalling server can hold an id for a moment after a restart.
                if (idRetries++ < 5) {
                    setStatus("connecting", "Reclaiming code");
                    setTimeout(() => { if (p === peer) startPeer(); }, 3000);
                } else {
                    setStatus("offline", "Code in use");
                    toast("This code is in use elsewhere — click “New code”");
                }
            } else if (["network", "server-error", "socket-error", "socket-closed"].includes(err.type)) {
                setStatus("offline", "Offline");
                setTimeout(() => { if (p === peer) startPeer(); }, 4000);
            }
        });
    }

    // ---------- images ----------
    function loadImage(url) {
        return new Promise((resolve, reject) => {
            const im = new Image();
            im.onload = () => resolve(im);
            im.onerror = () => reject(new Error("Could not decode image"));
            im.src = url;
        });
    }

    async function ingest(file) {
        if (!file || !file.type.startsWith("image/")) return null;
        let url = URL.createObjectURL(file);
        let el;
        try { el = await loadImage(url); } catch (e) { URL.revokeObjectURL(url); throw e; }
        let w = el.naturalWidth, h = el.naturalHeight;
        let mime = file.type;
        let blob = file;

        if (file.size > MAX_BYTES || Math.max(w, h) > MAX_DIM || !SAFE_TYPES.includes(file.type)) {
            const k = Math.min(1, MAX_DIM / Math.max(w, h));
            const cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
            const canvas = new OffscreenCanvas(cw, ch);
            canvas.getContext("2d").drawImage(el, 0, 0, cw, ch);
            mime = "image/webp";
            blob = await canvas.convertToBlob({ type: mime, quality: 0.9 });
            URL.revokeObjectURL(url);
            url = URL.createObjectURL(blob);
            w = cw; h = ch;
        }

        return {
            id: crypto.randomUUID(),
            name: file.name || `Pasted image ${new Date().toLocaleTimeString()}`,
            mime, w, h, url,
            data: await blob.arrayBuffer(),
        };
    }

    async function addFiles(files) {
        const list = [...files].filter((f) => f.type.startsWith("image/"));
        if (!list.length) { toast("No images found in that drop"); return; }
        let added = 0;
        for (const f of list) {
            try {
                const im = await ingest(f);
                if (!im) continue;
                images.push(im);
                added++;
                broadcast(listMsg());
                broadcast(imgMsg(im));
                if (!focusId) present(im.id);
                renderGrid();
            } catch (e) {
                console.warn(e);
                toast(`Couldn't read ${f.name}`);
            }
        }
        if (added > 1) toast(`Shared ${added} images`);
        // Present the last thing dropped — that's almost always what you want to show.
        if (added) present(images[images.length - 1].id);
    }

    function removeImage(id) {
        const i = images.findIndex((x) => x.id === id);
        if (i < 0) return;
        const [im] = images.splice(i, 1);
        URL.revokeObjectURL(im.url);
        if (focusId === id) focusId = images[Math.min(i, images.length - 1)]?.id || null;
        broadcast(listMsg());
        renderGrid();
        renderStage();
    }

    function present(id) {
        if (focusId === id && imgEl.src) return;
        focusId = id;
        broadcast({ t: "focus", id });
        renderGrid();
        renderStage();
    }

    function renderStage() {
        const im = images.find((x) => x.id === focusId);
        $("emptyState").hidden = !!im;
        $("zoombar").hidden = !im;
        $("liveTag").hidden = !im;
        if (im) { if (imgEl.src !== im.url) pz.show(im.url); }
        else pz.clear();
    }

    function renderGrid() {
        $("imgCount").textContent = images.length;
        $("clearBtn").hidden = images.length === 0;
        $("grid").replaceChildren(...images.map((im) => {
            if (!im.el) {
                const b = document.createElement("button");
                b.className = "thumb";
                b.title = `${im.name} — ${im.w}×${im.h}`;
                const pic = new Image();
                pic.src = im.url;
                pic.alt = "";
                const name = document.createElement("span");
                name.className = "name";
                name.textContent = im.name;
                const x = document.createElement("span");
                x.className = "remove";
                x.title = "Stop sharing";
                x.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';
                x.addEventListener("click", (e) => { e.stopPropagation(); removeImage(im.id); });
                b.append(pic, name, x);
                b.addEventListener("click", () => present(im.id));
                im.el = b;
            }
            im.el.classList.toggle("is-active", im.id === focusId);
            let badge = im.el.querySelector(".badge");
            if (im.id === focusId && !badge) {
                badge = document.createElement("span");
                badge.className = "badge";
                badge.textContent = "Live";
                im.el.append(badge);
            } else if (im.id !== focusId && badge) badge.remove();
            return im.el;
        }));
    }

    // ---------- input: picker, drag & drop, paste ----------
    $("addBtn").addEventListener("click", () => $("fileInput").click());
    $("dropHint").addEventListener("click", () => $("fileInput").click());
    $("fileInput").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
    $("clearBtn").addEventListener("click", () => {
        if (!confirm("Stop sharing all images?")) return;
        for (const im of images) URL.revokeObjectURL(im.url);
        images.length = 0;
        focusId = null;
        broadcast(listMsg());
        renderGrid();
        renderStage();
    });

    let dragDepth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
    window.addEventListener("dragenter", (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        if (dragDepth++ === 0) $("dropOverlay").hidden = false;
    });
    window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener("dragleave", () => {
        if (--dragDepth <= 0) { dragDepth = 0; $("dropOverlay").hidden = true; }
    });
    window.addEventListener("drop", (e) => {
        e.preventDefault();
        dragDepth = 0;
        $("dropOverlay").hidden = true;
        if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
    });

    window.addEventListener("paste", (e) => {
        if (e.target.closest("input")) return;
        const files = [...(e.clipboardData?.items || [])]
            .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
            .map((i) => i.getAsFile());
        if (files.length) addFiles(files);
    });

    // ---------- stage controls & keys ----------
    $("zoombar").addEventListener("click", (e) => {
        const act = e.target.closest("[data-act]")?.dataset.act;
        if (act === "in") pz.zoomBy(1.4);
        else if (act === "out") pz.zoomBy(1 / 1.4);
        else if (act === "fit") pz.fit(true);
        else if (act === "actual") pz.actualSize();
    });

    function stepFocus(dir) {
        if (images.length < 2) return;
        const i = images.findIndex((x) => x.id === focusId);
        present(images[(i + dir + images.length) % images.length].id);
    }

    document.addEventListener("keydown", (e) => {
        if (e.target.closest("input")) return;
        if (!$("qrModal").hidden && e.key === "Escape") { $("qrModal").hidden = true; return; }
        switch (e.key) {
            case "ArrowLeft": case "ArrowUp": stepFocus(-1); break;
            case "ArrowRight": case "ArrowDown": stepFocus(1); break;
            case "+": case "=": pz.zoomBy(1.4); break;
            case "-": pz.zoomBy(1 / 1.4); break;
            case "0": pz.fit(true); break;
            case "1": pz.actualSize(); break;
            case "Delete": if (focusId) removeImage(focusId); break;
            default: return;
        }
        e.preventDefault();
    });

    window.addEventListener("beforeunload", () => {
        broadcast({ t: "bye" });
        peer?.destroy();
    });

    renderGrid();
    renderStage();
    startPeer();
})();
