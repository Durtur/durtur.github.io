/*
 * PanZoom — a tiny drag / wheel / pinch zoom viewer for a single <img>.
 * Shared by the Scry viewer page and the Electron host app.
 */
(function (global) {
    "use strict";

    const MIN_SCALE = 0.05;
    const MAX_SCALE = 40;

    class PanZoom {
        constructor(stage, img, { onChange } = {}) {
            this.stage = stage;
            this.img = img;
            this.onChange = onChange || (() => {});
            this.scale = 1;
            this.x = 0;
            this.y = 0;
            this.fitScale = 1;
            this.pointers = new Map();
            this.pinch = null;
            this.animating = false;

            img.draggable = false;
            img.style.transformOrigin = "0 0";
            img.style.position = "absolute";
            img.style.left = "0";
            img.style.top = "0";
            img.style.willChange = "transform";
            img.style.userSelect = "none";
            stage.style.touchAction = "none";
            stage.style.overflow = "hidden";

            this._bind();
            this._ro = new ResizeObserver(() => {
                if (this._isFitted) this.fit(false);
                else this._apply();
            });
            this._ro.observe(stage);
        }

        _bind() {
            const s = this.stage;
            s.addEventListener("wheel", (e) => {
                if (!this._hasImage()) return;
                e.preventDefault();
                const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
                const p = this._local(e.clientX, e.clientY);
                this.zoomAt(p.x, p.y, this.scale * factor);
            }, { passive: false });

            s.addEventListener("pointerdown", (e) => {
                if (!this._hasImage() || e.button > 0) return;
                s.setPointerCapture(e.pointerId);
                this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
                s.classList.add("is-dragging");
                if (this.pointers.size === 2) this._startPinch();
            });

            s.addEventListener("pointermove", (e) => {
                const prev = this.pointers.get(e.pointerId);
                if (!prev) return;
                const cur = { x: e.clientX, y: e.clientY };
                this.pointers.set(e.pointerId, cur);
                if (this.pointers.size === 1) {
                    this.x += cur.x - prev.x;
                    this.y += cur.y - prev.y;
                    this._isFitted = false;
                    this._apply();
                } else if (this.pointers.size === 2 && this.pinch) {
                    const [a, b] = [...this.pointers.values()];
                    const dist = Math.hypot(a.x - b.x, a.y - b.y);
                    const mid = this._local((a.x + b.x) / 2, (a.y + b.y) / 2);
                    const newScale = this._clamp(this.pinch.scale * (dist / this.pinch.dist));
                    // keep the image point under the original midpoint under the current midpoint
                    this.scale = newScale;
                    this.x = mid.x - this.pinch.imgX * newScale;
                    this.y = mid.y - this.pinch.imgY * newScale;
                    this._isFitted = false;
                    this._apply();
                }
            });

            const end = (e) => {
                this.pointers.delete(e.pointerId);
                if (this.pointers.size < 2) this.pinch = null;
                if (this.pointers.size === 0) s.classList.remove("is-dragging");
            };
            s.addEventListener("pointerup", end);
            s.addEventListener("pointercancel", end);

            s.addEventListener("dblclick", (e) => {
                if (!this._hasImage()) return;
                const p = this._local(e.clientX, e.clientY);
                if (this.scale > this.fitScale * 1.05) this.fit(true);
                else this.zoomAt(p.x, p.y, Math.max(this.fitScale * 2.5, 1), true);
            });
        }

        _startPinch() {
            const [a, b] = [...this.pointers.values()];
            const mid = this._local((a.x + b.x) / 2, (a.y + b.y) / 2);
            this.pinch = {
                dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
                scale: this.scale,
                imgX: (mid.x - this.x) / this.scale,
                imgY: (mid.y - this.y) / this.scale,
            };
        }

        _hasImage() {
            return this.img.naturalWidth > 0 && !this.img.hidden;
        }

        _local(cx, cy) {
            const r = this.stage.getBoundingClientRect();
            return { x: cx - r.left, y: cy - r.top };
        }

        _clamp(s) {
            return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
        }

        _apply(animate) {
            const img = this.img;
            img.style.transition = animate ? "transform 220ms cubic-bezier(.2,.8,.2,1)" : "none";
            img.style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.scale})`;
            this.onChange({ scale: this.scale, fitScale: this.fitScale });
        }

        zoomAt(px, py, newScale, animate) {
            newScale = this._clamp(newScale);
            const k = newScale / this.scale;
            this.x = px - (px - this.x) * k;
            this.y = py - (py - this.y) * k;
            this.scale = newScale;
            this._isFitted = false;
            this._apply(animate);
        }

        zoomBy(factor) {
            const r = this.stage.getBoundingClientRect();
            this.zoomAt(r.width / 2, r.height / 2, this.scale * factor, true);
        }

        actualSize() {
            const r = this.stage.getBoundingClientRect();
            this.zoomAt(r.width / 2, r.height / 2, 1, true);
            // centre
            this.x = (r.width - this.img.naturalWidth) / 2;
            this.y = (r.height - this.img.naturalHeight) / 2;
            this._apply(true);
        }

        fit(animate = true) {
            if (!this._hasImage()) return;
            const r = this.stage.getBoundingClientRect();
            const w = this.img.naturalWidth;
            const h = this.img.naturalHeight;
            const pad = Math.min(48, r.width * 0.05);
            const s = Math.min((r.width - pad * 2) / w, (r.height - pad * 2) / h);
            this.fitScale = this._clamp(Math.min(s, 4));
            this.scale = this.fitScale;
            this.x = (r.width - w * this.scale) / 2;
            this.y = (r.height - h * this.scale) / 2;
            this._isFitted = true;
            this._apply(animate);
        }

        /** Load a new image src and fit it once decoded. */
        async show(src) {
            this.img.hidden = false;
            this.img.style.opacity = "0";
            this.img.src = src;
            try { await this.img.decode(); } catch (_) { /* fall through */ }
            this.fit(false);
            requestAnimationFrame(() => {
                this.img.style.transition = "opacity 200ms ease";
                this.img.style.opacity = "1";
            });
        }

        clear() {
            this.img.hidden = true;
            this.img.removeAttribute("src");
        }
    }

    global.PanZoom = PanZoom;
})(window);
