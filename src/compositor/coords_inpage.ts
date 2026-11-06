// In-page coordinate extractor: discovery, film-time seek, and per-frame box measurement.
//
// These functions run inside the composition page (serialized by puppeteer `page.evaluate`),
// so each serialized function must stay self-contained: no imports, no module state, and no
// references to module-scope helpers or constants (inline every literal they need).
// Measurement rules: re-discover every frame (late-added nodes), `getBoundingClientRect`,
// `Range` line-box union for bare text, multiplied ancestor opacity, invisible / zero-size /
// off-stage items dropped, `z` = paint order approximation. Identity key: `id` -> `data-*` -> DOM path.
// Ink rules: per-frame glyph/pixel boxes (text via canvas glyph metrics per line, images via
// Node-resolved transparent margins applied to the `object-fit` drawn rectangle, SVG via
// `getBBox` without a viewBox). Ink is emitted only when it differs from the item box by
// more than 0.5 px on some edge; anything uncertain falls back to no ink row (the item box).
export interface CoordsInpageElement {
  key: string;
  kind: string;
  label: string;
  /** Index of the nearest measured ancestor element (absent = none). */
  parent?: number;
  /** Index of the nearest measured painted non-stage-sized ancestor (absent = none). */
  group?: number;
  /**
   * Resolved absolute http(s) image URL for kind=image (in-page only, stripped from
   * the document). Absent for `data:` sources: those stay in the page (multi-MB
   * strings must never cross the protocol per frame) and their margins are measured
   * in-page on a canvas instead.
   */
  asset?: string;
}

/** [element index, x, y, w, h, opacity, z] in composition pixels. */
export type CoordsInpageItem = [number, number, number, number, number, number, number];

/** [element index, x, y, w, h] in composition pixels. */
export type CoordsInpageInk = [number, number, number, number, number];

/**
 * Rotated corners of one element in one frame: `[elementIndex, x1, y1, x2, y2, x3, y3, x4, y4]`
 * in composition pixels (border-frame order TL, TR, BR, BL mapped through the transform chain).
 * Present only for elements with a non-trivial 2D transform chain whose mapped corners verify
 * against the measured box (±1.2 px per edge); untransformed elements keep boxes only.
 */
export type CoordsInpageQuad = [number, number, number, number, number, number, number, number, number];

export interface CoordsInpageFrame {
  f: number;
  items: CoordsInpageItem[];
  ink?: CoordsInpageInk[];
  quads?: CoordsInpageQuad[];
  inkQuads?: CoordsInpageQuad[];
}

/** Fractional transparent margins of one image asset, resolved on the Node side. */
export interface CoordsInpageImageMargins {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export function coordsInpageInstall(args: { w: number; h: number }): CoordsInpageElement[] {
  const compW = args.w > 0 ? args.w : 1920;
  const compH = args.h > 0 ? args.h : 1080;
  const SKIP = new Set([
    "SCRIPT",
    "STYLE",
    "LINK",
    "META",
    "NOSCRIPT",
    "TEMPLATE",
    "TITLE",
    "HEAD",
    "BASE",
  ]);
  const root: Element = document.querySelector("[data-composition-id]") || document.body;

  // Seek follows the render seek chain: `__player.renderSeek` -> `__hf.seek` ->
  // `__player.seek` -> `__timelines` (`pause()` + `seek(t, false)`; the default `seek(t)`
  // suppresses `tl.call` callbacks while render runs them) + `gsap.ticker.tick()`,
  // then CSS/WAAPI animations are paused and pinned to film time (matches the renderer's
  // snapshot of the same instant: a keyframed box sits at the same x), then the `hf-seek` event.
  //
  // A seek that throws (e.g. a `tl.call` callback) must not break the measurement loop,
  // but it must not vanish either: render swallows the same throw, so the recording
  // below is the only place the agent ever sees it. Capped and de-duplicated.
  const seekErrors: string[] = [];
  function recordSeekError(err: unknown): void {
    try {
      const msg = err instanceof Error ? err.message || String(err) : String(err);
      const text = msg.replace(/\s+/g, " ").trim().slice(0, 300);
      if (!text || seekErrors.length >= 5 || seekErrors.includes(text)) return;
      seekErrors.push(text);
    } catch {
      // ignore recorder failure
    }
  }
  function coordsSeek(t: number): void {
    const w = window as unknown as Record<string, any>;
    const player = w.__player as { renderSeek?: unknown; seek?: unknown } | undefined;
    const hf = w.__hf as { seek?: unknown } | undefined;
    let done = false;
    try {
      if (player && typeof player.renderSeek === "function") {
        (player.renderSeek as (time: number) => void)(t);
        done = true;
      }
    } catch (e) {
      recordSeekError(e);
      // fall through to the next seek target
    }
    if (!done) {
      try {
        if (hf && typeof hf.seek === "function") {
          (hf.seek as (time: number) => void)(t);
          done = true;
        }
      } catch (e) {
        recordSeekError(e);
        // fall through to the next seek target
      }
    }
    if (!done) {
      try {
        if (player && typeof player.seek === "function") {
          (player.seek as (time: number) => void)(t);
          done = true;
        }
      } catch (e) {
        recordSeekError(e);
        // fall through to the timelines branch
      }
    }
    if (!done) {
      const tls = (w.__timelines || {}) as Record<
        string,
        { pause?: unknown; seek?: unknown } | undefined
      >;
      for (const k of Object.keys(tls)) {
        const tl = tls[k];
        try {
          if (tl && typeof tl.pause === "function") (tl.pause as () => void)();
        } catch (e) {
          recordSeekError(e);
        }
        try {
          if (tl && typeof tl.seek === "function")
            (tl.seek as (time: number, suppress: boolean) => void)(t, false);
        } catch (e) {
          recordSeekError(e);
        }
      }
    }
    try {
      const anims = document.getAnimations();
      for (const a of anims) {
        try {
          if (typeof a.pause === "function") a.pause();
        } catch {
          // ignore
        }
        try {
          a.currentTime = t * 1000;
        } catch {
          // progress-driven animations reject a set time
        }
      }
    } catch {
      // ignore
    }
    try {
      const g = w.gsap as { ticker?: { tick?: unknown } } | undefined;
      if (g && g.ticker && typeof g.ticker.tick === "function") (g.ticker.tick as () => void)();
    } catch {
      // ignore
    }
    try {
      window.dispatchEvent(new CustomEvent("hf-seek", { detail: { time: t } }));
    } catch {
      // ignore
    }
  }

  interface CoordsTrackedItem {
    el: Element;
    key: string;
    kind: string;
    textBox: boolean;
    label: string;
    order: number;
    zBase: number;
    parent: number | undefined;
    group: number | undefined;
    asset: string | undefined;
    /** Discovery saw a `data:` source (margins measured in-page, never shipped out). */
    assetDataUri: boolean;
    /** Lookup key currently used (differs from `asset` after a source swap). */
    assetChecked: string | undefined;
    /** A live source re-read was already spent (multi-MB strings: at most once). */
    assetSlowDone: boolean;
    /** Canvas-measured margins for `data:` sources (`undefined` = untried). */
    dataMargins: CoordsInpageImageMargins | null | undefined;
    dataNatW: number;
    dataNatH: number;
  }

  interface CoordsInpageState {
    items: CoordsTrackedItem[];
    byEl: Map<Element, CoordsTrackedItem>;
    dirty: boolean;
    scaleX: number;
    scaleY: number;
    rootLeft: number;
    rootTop: number;
    lastCount: number;
    inkByUrl: Map<string, CoordsInpageImageMargins>;
    textCtx: CanvasRenderingContext2D | null;
    textCtxTried: boolean;
  }

  function alphaOf(color: string | null): number {
    if (!color) return 0;
    const c = color.trim().toLowerCase();
    if (c === "transparent") return 0;
    let m = c.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
      const parts = m[1].split(",").map((s) => s.trim());
      if (parts.length === 4) {
        const a = Number(parts[3]);
        return Number.isFinite(a) ? a : 1;
      }
      return 1;
    }
    m = c.match(/^#([0-9a-f]{8})$/);
    if (m) return parseInt(m[1].slice(6, 8), 16) / 255;
    if (/^#[0-9a-f]{3,6}$/.test(c)) return 1;
    return 1;
  }

  function bgVisible(cs: CSSStyleDeclaration): boolean {
    if (alphaOf(cs.backgroundColor) > 0) return true;
    const bi = cs.backgroundImage;
    return !!bi && bi !== "none";
  }

  function borderVisible(cs: CSSStyleDeclaration): boolean {
    const sides = ["Top", "Right", "Bottom", "Left"];
    for (const s of sides) {
      const wProp = parseFloat(
        (cs as unknown as Record<string, string>)["border" + s + "Width"]
      );
      const st = (cs as unknown as Record<string, string>)["border" + s + "Style"];
      const col = (cs as unknown as Record<string, string>)["border" + s + "Color"];
      if (wProp > 0 && st && st !== "none" && st !== "hidden" && alphaOf(col) > 0) return true;
    }
    return false;
  }

  function shadowVisible(cs: CSSStyleDeclaration): boolean {
    const bs = cs.boxShadow;
    if (!bs || bs === "none") return false;
    const colors = bs.match(/rgba?\([^)]*\)|#[0-9a-f]{3,8}/gi) || [];
    if (colors.length === 0) return true;
    return colors.some((c) => alphaOf(c) > 0);
  }

  function directText(el: Element): string {
    let s = "";
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === 3 && /\S/.test(n.nodeValue || "")) s += n.nodeValue;
    }
    return s.replace(/\s+/g, " ").trim();
  }

  function domPath(el: Element): string {
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== root && cur !== document.body) {
      const tag = cur.tagName.toLowerCase();
      let idx = 1;
      let sib = cur.previousElementSibling;
      while (sib) {
        if (sib.tagName === cur.tagName) idx++;
        sib = sib.previousElementSibling;
      }
      parts.unshift(tag + ":" + idx);
      cur = cur.parentElement;
    }
    return parts.join(">");
  }

  function dataKey(el: Element): string | null {
    const names = el.getAttributeNames().filter((n) => n.startsWith("data-")).sort();
    if (names.length === 0) return null;
    return names[0] + "=" + (el.getAttribute(names[0]) || "");
  }

  function shortLabel(el: Element, kind: string, text: string): string {
    if (kind === "text") return text.slice(0, 30);
    if (kind === "image" || kind === "video") {
      const src = el.getAttribute("src") || el.getAttribute("data-src") || "";
      if (src.startsWith("data:")) return (el.id || kind).slice(0, 40);
      const base = src.split(/[?#]/)[0].split("/").pop() || src || kind;
      try {
        return decodeURIComponent(base).slice(0, 40);
      } catch {
        return base.slice(0, 40);
      }
    }
    const cls =
      el.className && typeof el.className === "string"
        ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join(".")
        : "";
    return (el.tagName.toLowerCase() + (cls ? "." + cls : "")).slice(0, 40);
  }

  const state: CoordsInpageState = {
    items: [],
    byEl: new Map(),
    dirty: false,
    scaleX: 1,
    scaleY: 1,
    rootLeft: 0,
    rootTop: 0,
    lastCount: -1,
    inkByUrl: new Map(),
    textCtx: null,
    textCtxTried: false,
  };
  new MutationObserver(() => {
    state.dirty = true;
  }).observe(root, { childList: true, subtree: true });

  function paints(cs: CSSStyleDeclaration): boolean {
    return bgVisible(cs) || borderVisible(cs) || shadowVisible(cs);
  }

  function stageSized(el: Element): boolean {
    // Layout size (untransformed): a near-full-stage backdrop is not a design group.
    const w = (el as HTMLElement).offsetWidth || 0;
    const h = (el as HTMLElement).offsetHeight || 0;
    return w >= compW * 0.98 && h >= compH * 0.98;
  }

  /** Nearest measured ancestor; then the nearest measured painted non-stage-sized one. */
  function resolveParentGroup(el: Element): { parent: number | undefined; group: number | undefined } {
    let parent: number | undefined;
    let group: number | undefined;
    let node = el.parentElement;
    while (node && node !== root && node !== document.body) {
      const tracked = state.byEl.get(node);
      if (tracked) {
        if (parent === undefined) parent = tracked.order;
        if (group === undefined && !stageSized(node)) {
          try {
            if (paints(getComputedStyle(node))) group = tracked.order;
          } catch {
            // unreadable style: not a group
          }
        }
        if (parent !== undefined && group !== undefined) break;
      }
      node = node.parentElement;
    }
    return { parent, group };
  }

  function publicElements(): CoordsInpageElement[] {
    return state.items.map((it) => {
      const out: CoordsInpageElement = { key: it.key, kind: it.kind, label: it.label };
      if (it.parent !== undefined) out.parent = it.parent;
      if (it.group !== undefined) out.group = it.group;
      if (it.asset !== undefined) out.asset = it.asset;
      return out;
    });
  }

  // Merging discovery: earlier frames keep their indices, new nodes append,
  // removed nodes are skipped at measure time.
  function discover(): CoordsInpageElement[] {
    const els = root.querySelectorAll("*");
    let added = false;
    for (const el of Array.from(els)) {
      const tag = (el.tagName || "").toUpperCase();
      if (SKIP.has(tag) || el === root) continue;
      let kind: string | null = null;
      if (tag === "IMG") kind = "image";
      else if (tag === "VIDEO") kind = "video";
      else if (tag === "CANVAS") kind = "canvas";
      else if (
        tag === "SVG" &&
        el.parentElement &&
        (el.parentElement.tagName || "").toUpperCase() !== "SVG"
      )
        kind = "svg";
      let text = "";
      if (!kind) {
        text = directText(el);
        if (text) kind = "text";
      }
      // Text with a visible border/background measures the element box (the border
      // can extend past the glyphs); bare text measures the Range box.
      let boxPaint = false;
      if (!kind) {
        const cs = getComputedStyle(el);
        if (bgVisible(cs) || borderVisible(cs) || shadowVisible(cs)) kind = "box";
        else continue;
      } else if (kind === "text") {
        const cs = getComputedStyle(el);
        boxPaint = bgVisible(cs) || borderVisible(cs);
      }
      if (state.byEl.has(el)) continue;
      // SVG descendants (path/circle/...) are not separate elements
      let p = el.parentElement;
      let inside = false;
      while (p && p !== root) {
        if ((p.tagName || "").toUpperCase() === "SVG") {
          inside = true;
          break;
        }
        p = p.parentElement;
      }
      if (inside) continue;
      // z: DOM order; positioned elements with a numeric z-index sort first
      const cs2 = getComputedStyle(el);
      const pos = cs2.position;
      const zi = Number.parseInt(cs2.zIndex, 10);
      const pg = resolveParentGroup(el);
      let asset: string | undefined;
      let assetDataUri = false;
      if (kind === "image") {
        try {
          const src = (el as HTMLImageElement).currentSrc || el.getAttribute("src") || "";
          if (src.startsWith("data:")) {
            // Resolved in-page (see imageInk); the bytes never leave the page.
            assetDataUri = true;
          } else if (src) {
            asset = new URL(src, document.baseURI).href;
          }
        } catch {
          asset = undefined;
        }
      }
      const it: CoordsTrackedItem = {
        el,
        key: el.id || dataKey(el) || domPath(el),
        kind,
        textBox: kind === "text" && !boxPaint,
        label: shortLabel(el, kind, text),
        order: state.items.length,
        zBase: pos !== "static" && Number.isFinite(zi) ? zi * 1e6 : 0,
        parent: pg.parent,
        group: pg.group,
        asset,
        assetDataUri,
        assetChecked: undefined,
        assetSlowDone: false,
        dataMargins: undefined,
        dataNatW: 0,
        dataNatH: 0,
      };
      state.items.push(it);
      state.byEl.set(el, it);
      added = true;
    }
    // Ancestors can be measured after their descendants (late-filled wrappers):
    // retry unresolved links whenever the list grew.
    if (added) {
      for (const it of state.items) {
        if (!it.el.isConnected) continue;
        if (it.parent !== undefined && it.group !== undefined) continue;
        const pg = resolveParentGroup(it.el);
        if (it.parent === undefined) it.parent = pg.parent;
        if (it.group === undefined) it.group = pg.group;
      }
    }
    state.lastCount = root.getElementsByTagName("*").length;
    state.dirty = false;
    return publicElements();
  }

  function syncRoot(): void {
    const r = root.getBoundingClientRect();
    state.scaleX = r.width / compW || 1;
    state.scaleY = r.height / compH || 1;
    state.rootLeft = r.left;
    state.rootTop = r.top;
  }

  const range = document.createRange();
  function textBox(el: Element): [number, number, number, number] | null {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let any = false;
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType !== 3 || !/\S/.test(n.nodeValue || "")) continue;
      range.selectNode(n);
      const rects = range.getClientRects();
      for (const r of Array.from(rects)) {
        if (r.width <= 0 || r.height <= 0) continue;
        any = true;
        if (r.left < x0) x0 = r.left;
        if (r.top < y0) y0 = r.top;
        if (r.right > x1) x1 = r.right;
        if (r.bottom > y1) y1 = r.bottom;
      }
    }
    return any ? [x0, y0, x1 - x0, y1 - y0] : null;
  }

  // --- Ink: text ---

  interface InkLineMetric {
    adv: number;
    left: number;
    right: number;
    asc: number;
    desc: number;
  }

  interface TextNodeInkCache {
    text: string;
    fontSig: string;
    widthPx: number;
    fontAsc: number;
    fontDesc: number;
    lines: InkLineMetric[];
  }

  function textContext(): CanvasRenderingContext2D | null {
    if (state.textCtx || state.textCtxTried) return state.textCtx;
    state.textCtxTried = true;
    try {
      const canvas = document.createElement("canvas");
      state.textCtx = canvas.getContext("2d");
    } catch {
      state.textCtx = null;
    }
    return state.textCtx;
  }

  function applyTextTransform(s: string, transform: string): string | null {
    if (!transform || transform === "none") return s;
    try {
      const lang = document.documentElement.lang || undefined;
      if (transform === "uppercase") return s.toLocaleUpperCase(lang);
      if (transform === "lowercase") return s.toLocaleLowerCase(lang);
      if (transform === "capitalize") {
        const lower = s.toLocaleLowerCase(lang);
        return lower.replace(/(^|[\s\(\["'])\S/g, (m) => m.toLocaleUpperCase(lang));
      }
    } catch {
      return null;
    }
    return null;
  }

  function fontSigOf(cs: CSSStyleDeclaration): string {
    return [
      cs.fontFamily,
      cs.fontSize,
      cs.fontWeight,
      cs.fontStyle,
      cs.letterSpacing,
      cs.textTransform,
      cs.lineHeight,
    ].join("|");
  }

  function measureLine(
    ctx: CanvasRenderingContext2D,
    cs: CSSStyleDeclaration,
    line: string
  ): InkLineMetric | null {
    const shaped = applyTextTransform(line, cs.textTransform);
    if (shaped === null) return null;
    try {
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const ls = cs.letterSpacing && cs.letterSpacing !== "normal" ? cs.letterSpacing : "0px";
      try {
        (ctx as unknown as Record<string, string>).letterSpacing = ls;
      } catch {
        // older canvas: letter spacing unsupported, metrics stay approximate
      }
      const m = ctx.measureText(shaped);
      if (!Number.isFinite(m.width)) return null;
      return {
        adv: m.width,
        left: m.actualBoundingBoxLeft,
        right: m.actualBoundingBoxRight,
        asc: m.actualBoundingBoxAscent,
        desc: m.actualBoundingBoxDescent,
      };
    } catch {
      return null;
    }
  }

  function fontBoxOf(
    ctx: CanvasRenderingContext2D,
    cs: CSSStyleDeclaration
  ): { asc: number; desc: number } | null {
    try {
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const m = ctx.measureText("Hg");
      const asc = m.fontBoundingBoxAscent;
      const desc = m.fontBoundingBoxDescent;
      if (!Number.isFinite(asc) || !Number.isFinite(desc) || asc + desc <= 0) return null;
      return { asc, desc };
    } catch {
      return null;
    }
  }

  /** Line-break offsets of one text node by per-character geometry (cache miss only). */
  function breakTextNode(node: Text): number[][] {
    const text = node.nodeValue || "";
    const bounds: number[][] = [];
    let start = 0;
    let lineTop = NaN;
    const r = document.createRange();
    for (let i = 0; i < text.length; i++) {
      r.setStart(node, i);
      r.setEnd(node, i + 1);
      const rect = r.getBoundingClientRect();
      if (rect.width <= 0 && rect.height <= 0) continue;
      if (!Number.isFinite(lineTop) || Math.abs(rect.top - lineTop) > 0.5) {
        if (Number.isFinite(lineTop)) bounds.push([start, i]);
        start = i;
        lineTop = rect.top;
      }
    }
    bounds.push([start, text.length]);
    return bounds;
  }

  function nodeInkCache(
    node: Text,
    el: Element,
    cs: CSSStyleDeclaration
  ): TextNodeInkCache | null {
    const rec = node as unknown as Record<string, TextNodeInkCache | undefined>;
    const text = node.nodeValue || "";
    const widthPx = (el as HTMLElement).clientWidth || 0;
    const fontSig = fontSigOf(cs);
    const prev = rec["__cxink"];
    if (prev && prev.text === text && prev.fontSig === fontSig && prev.widthPx === widthPx) {
      return prev;
    }
    const ctx = textContext();
    if (!ctx) return null;
    const fontBox = fontBoxOf(ctx, cs);
    if (!fontBox) return null;
    const lines: InkLineMetric[] = [];
    // Animated single-line text (counters, typewriters) changes every frame: one rect
    // means one line, so skip the per-character break pass (it stays exact).
    range.selectNode(node);
    const rectCount = range.getClientRects().length;
    const bounds = rectCount === 1 ? [[0, text.length]] : breakTextNode(node);
    for (const [a, b] of bounds) {
      const m = measureLine(ctx, cs, text.slice(a as number, b as number));
      if (!m) return null;
      lines.push(m);
    }
    const fresh: TextNodeInkCache = {
      text,
      fontSig,
      widthPx,
      fontAsc: fontBox.asc,
      fontDesc: fontBox.desc,
      lines,
    };
    rec["__cxink"] = fresh;
    return fresh;
  }

  function clearNodeInkCache(node: Text): void {
    try {
      delete (node as unknown as Record<string, unknown>)["__cxink"];
    } catch {
      // ignore
    }
  }

  interface TextLineBox {
    node: Text;
    rect: DOMRect;
  }

  function textLineBoxes(el: Element): TextLineBox[] {
    const out: TextLineBox[] = [];
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType !== 3 || !/\S/.test(n.nodeValue || "")) continue;
      range.selectNode(n);
      const rects = range.getClientRects();
      for (const r of Array.from(rects)) {
        if (r.width <= 0 || r.height <= 0) continue;
        out.push({ node: n as Text, rect: r });
      }
    }
    return out;
  }

  // --- Ink: local-to-client mapping for transformed elements ---

  interface ChainTransform {
    node: Element;
  }

  interface ChainInfo {
    transforms: ChainTransform[];
    complex: boolean;
    selfCs: CSSStyleDeclaration | null;
  }

  /**
   * True for identity and pure-translation matrices (settled tweens and positional
   * x/y motion map local px 1:1 onto the item box, so the direct ink paths stay exact).
   */
  function isNoneMatrix(t: string): boolean {
    let m = /^matrix\(([^)]+)\)$/.exec(t.trim());
    if (m) {
      const v = m[1].split(",").map((s) => Number(s.trim()));
      return (
        v.length === 6 &&
        v.every((x) => Number.isFinite(x)) &&
        Math.abs(v[0] - 1) < 1e-9 &&
        Math.abs(v[1]) < 1e-9 &&
        Math.abs(v[2]) < 1e-9 &&
        Math.abs(v[3] - 1) < 1e-9
      );
    }
    m = /^matrix3d\(([^)]+)\)$/.exec(t.trim());
    if (m) {
      const v = m[1].split(",").map((s) => Number(s.trim()));
      if (v.length !== 16 || !v.every((x) => Number.isFinite(x))) return false;
      // Identity except the translation column (m41/m42/m43 move no pixels without
      // perspective, and perspective elsewhere already flags the chain complex).
      for (let i = 0; i < 16; i++) {
        if (i === 12 || i === 13 || i === 14) continue;
        const want = i % 5 === 0 ? 1 : 0;
        if (Math.abs(v[i] - want) >= 1e-9) return false;
      }
      return true;
    }
    return false;
  }

  function isNoneTransform(cs: CSSStyleDeclaration): boolean {
    const rec = cs as unknown as Record<string, string>;
    const t = (cs.transform || "").trim();
    if (t && t !== "none" && !isNoneMatrix(t)) return false;
    // NOTE: the individual `translate` property is always a rigid shift (accepted).
    const rt = (rec["rotate"] || "").trim().toLowerCase();
    if (rt && rt !== "none" && rt !== "0deg") return false;
    const sc = (rec["scale"] || "").trim().toLowerCase();
    if (sc && sc !== "none" && sc !== "1" && sc !== "1 1" && sc !== "1 1 1") return false;
    return true;
  }

  function chainComplex(cs: CSSStyleDeclaration): boolean {
    const rec = cs as unknown as Record<string, string>;
    if (rec["offsetPath"] && rec["offsetPath"] !== "none") return true;
    if (rec["zoom"] && rec["zoom"] !== "1") return true;
    if (rec["perspective"] && rec["perspective"] !== "none") return true;
    if (rec["transformStyle"] && rec["transformStyle"] !== "flat") return true;
    return false;
  }

  function parseOrigin2D(origin: string, w: number, h: number): [number, number] | null {
    const parts = origin.trim().split(/\s+/);
    const conv = (tok: string | undefined, size: number, center: string): number | null => {
      if (tok === undefined || tok === "") return size / 2;
      const t = tok.toLowerCase();
      if (t === "left" || t === "top") return 0;
      if (t === "center" || t === center) return size / 2;
      if (t === "right" || t === "bottom") return size;
      if (t.endsWith("%")) {
        const v = Number(t.slice(0, -1));
        return Number.isFinite(v) ? (v / 100) * size : null;
      }
      if (t.endsWith("px")) {
        const v = Number(t.slice(0, -2));
        return Number.isFinite(v) ? v : null;
      }
      const v = Number(t);
      return Number.isFinite(v) ? v : null;
    };
    const ox = conv(parts[0], w, "center");
    const oy = conv(parts[1], h, "center");
    return ox === null || oy === null ? null : [ox, oy];
  }

  /** Own-transform matrix of one node in its border-box frame (affine 2D only). */
  function ownMatrix(node: Element, cs: CSSStyleDeclaration): DOMMatrix | null {
    const t = (cs.transform || "").trim();
    if (!t || t === "none") return new DOMMatrix();
    let m: DOMMatrix;
    try {
      m = new DOMMatrix(t);
    } catch {
      return null;
    }
    // Reject perspective and true 3D (the center trick below needs an affine map).
    if (
      m.m13 !== 0 ||
      m.m14 !== 0 ||
      m.m23 !== 0 ||
      m.m24 !== 0 ||
      m.m31 !== 0 ||
      m.m32 !== 0 ||
      m.m33 !== 1 ||
      m.m34 !== 0 ||
      m.m43 !== 0 ||
      m.m44 !== 1
    ) {
      return null;
    }
    const rec = cs as unknown as Record<string, string>;
    const w =
      parseFloat(rec["width"] || "") +
      parseFloat(rec["paddingLeft"] || "") +
      parseFloat(rec["paddingRight"] || "") +
      parseFloat(rec["borderLeftWidth"] || "") +
      parseFloat(rec["borderRightWidth"] || "");
    const h =
      parseFloat(rec["height"] || "") +
      parseFloat(rec["paddingTop"] || "") +
      parseFloat(rec["paddingBottom"] || "") +
      parseFloat(rec["borderTopWidth"] || "") +
      parseFloat(rec["borderBottomWidth"] || "");
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
    const origin = parseOrigin2D(rec["transformOrigin"] || "", w, h);
    if (!origin) return null;
    try {
      return new DOMMatrix()
        .translate(origin[0], origin[1])
        .multiply(m)
        .translate(-origin[0], -origin[1]);
    } catch {
      return null;
    }
  }

  function borderSizeOf(cs: CSSStyleDeclaration): [number, number] | null {
    const rec = cs as unknown as Record<string, string>;
    const w =
      parseFloat(rec["width"] || "") +
      parseFloat(rec["paddingLeft"] || "") +
      parseFloat(rec["paddingRight"] || "") +
      parseFloat(rec["borderLeftWidth"] || "") +
      parseFloat(rec["borderRightWidth"] || "");
    const h =
      parseFloat(rec["height"] || "") +
      parseFloat(rec["paddingTop"] || "") +
      parseFloat(rec["paddingBottom"] || "") +
      parseFloat(rec["borderTopWidth"] || "") +
      parseFloat(rec["borderBottomWidth"] || "");
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
    return [w, h];
  }

  // --- Ink: multi-transform chains (two or more nested 2D affine transforms) ---

  /** 2x2 linear part of an affine map, row-major: x' = a00*x + a01*y. */
  type InkLinear = [[number, number], [number, number]];

  function inkMatMul(a: InkLinear, b: InkLinear): InkLinear {
    return [
      [a[0][0] * b[0][0] + a[0][1] * b[1][0], a[0][0] * b[0][1] + a[0][1] * b[1][1]],
      [a[1][0] * b[0][0] + a[1][1] * b[1][0], a[1][0] * b[0][1] + a[1][1] * b[1][1]],
    ];
  }

  /** Parses a single CSS angle (the `rotate` property); null for axis syntax. */
  function inkParseAngle(s: string): number | null {
    const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(deg|grad|rad|turn)?\s*$/i.exec(s);
    if (!m) return null;
    const v = Number(m[1]);
    if (!Number.isFinite(v)) return null;
    const u = (m[2] || "deg").toLowerCase();
    if (u === "deg") return (v * Math.PI) / 180;
    if (u === "grad") return (v * Math.PI) / 200;
    if (u === "rad") return v;
    return v * 2 * Math.PI;
  }

  /**
   * Linear part of one node's own transform (`transform` plus the individual
   * `rotate`/`scale`; `translate` and `transform-origin` only shift, so the
   * composite shift is solved from geometry instead). Null when the node leaves
   * the 2D affine plane (perspective, rotateX/Y, matrix3d, axis rotate).
   */
  function inkNodeLinear(cs: CSSStyleDeclaration): InkLinear | null {
    let w00 = 1;
    let w01 = 0;
    let w10 = 0;
    let w11 = 1;
    const t = (cs.transform || "").trim();
    if (t && t !== "none") {
      let m: DOMMatrix;
      try {
        m = new DOMMatrix(t);
      } catch {
        return null;
      }
      if (
        m.m13 !== 0 ||
        m.m14 !== 0 ||
        m.m23 !== 0 ||
        m.m24 !== 0 ||
        m.m31 !== 0 ||
        m.m32 !== 0 ||
        m.m33 !== 1 ||
        m.m34 !== 0 ||
        m.m43 !== 0 ||
        m.m44 !== 1
      ) {
        return null;
      }
      if (
        !Number.isFinite(m.m11) ||
        !Number.isFinite(m.m12) ||
        !Number.isFinite(m.m21) ||
        !Number.isFinite(m.m22)
      ) {
        return null;
      }
      w00 = m.m11;
      w01 = m.m21;
      w10 = m.m12;
      w11 = m.m22;
    }
    // Spec order: translate x rotate x scale x transform (translate shifts only).
    const rec = cs as unknown as Record<string, string>;
    const sc = (rec["scale"] || "").trim();
    if (sc && sc.toLowerCase() !== "none") {
      const parts = sc.split(/\s+/).map(Number);
      if (parts.some((v) => !Number.isFinite(v))) return null;
      let sx = 1;
      let sy = 1;
      if (parts.length === 1) {
        sx = parts[0];
        sy = parts[0];
      } else if (parts.length === 2) {
        sx = parts[0];
        sy = parts[1];
      } else if (parts.length === 3 && parts[2] === 1) {
        sx = parts[0];
        sy = parts[1];
      } else {
        return null;
      }
      w00 = sx * w00;
      w01 = sx * w01;
      w10 = sy * w10;
      w11 = sy * w11;
    }
    const rt = (rec["rotate"] || "").trim();
    if (rt && rt.toLowerCase() !== "none") {
      const a = inkParseAngle(rt);
      if (a === null) return null;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const n00 = c * w00 - s * w10;
      const n01 = c * w01 - s * w11;
      const n10 = s * w00 + c * w10;
      const n11 = s * w01 + c * w11;
      w00 = n00;
      w01 = n01;
      w10 = n10;
      w11 = n11;
    }
    return [
      [w00, w01],
      [w10, w11],
    ];
  }

  /** Border-box size honoring `box-sizing` (style first, layout size fallback). */
  function inkBorderBoxSize(el: Element, cs: CSSStyleDeclaration): [number, number] | null {
    const rec = cs as unknown as Record<string, string>;
    const num = (k: string): number => parseFloat(rec[k] || "");
    const w = num("width");
    const h = num("height");
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      if ((rec["boxSizing"] || "").trim().toLowerCase() === "border-box") return [w, h];
      const bw =
        w + num("paddingLeft") + num("paddingRight") + num("borderLeftWidth") + num("borderRightWidth");
      const bh =
        h + num("paddingTop") + num("paddingBottom") + num("borderTopWidth") + num("borderBottomWidth");
      if (Number.isFinite(bw) && Number.isFinite(bh) && bw > 0 && bh > 0) return [bw, bh];
    }
    const ow = (el as HTMLElement).offsetWidth || 0;
    const oh = (el as HTMLElement).offsetHeight || 0;
    return ow > 0 && oh > 0 ? [ow, oh] : null;
  }

  /**
   * Border-frame to client mapping for a chain of nested 2D affine transforms.
   * The linear part is the product of every level's own matrix (transform
   * origins and offsets only shift); the shift is solved from the affine center
   * rule (the client box center is the image of the border-box center), then
   * verified against the element box. Null on any 3D level or mismatch.
   */
  function inkChainMap(
    el: Element,
    elCs: CSSStyleDeclaration
  ): ((x: number, y: number) => [number, number]) | null {
    let L: InkLinear = [
      [1, 0],
      [0, 1],
    ];
    let node: Element | null = el;
    while (node && node !== root) {
      const cs = node === el ? elCs : getComputedStyle(node);
      if (!isNoneTransform(cs)) {
        const ln = inkNodeLinear(cs);
        if (!ln) return null;
        L = inkMatMul(ln, L);
      }
      node = node.parentElement;
    }
    const size = inkBorderBoxSize(el, elCs);
    if (!size) return null;
    let box: { left: number; top: number; width: number; height: number };
    try {
      box = el.getBoundingClientRect();
    } catch {
      return null;
    }
    if (!(box.width > 0) || !(box.height > 0)) return null;
    const a = state.scaleX * L[0][0];
    const b = state.scaleX * L[0][1];
    const c = state.scaleY * L[1][0];
    const d = state.scaleY * L[1][1];
    if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c) || !Number.isFinite(d)) {
      return null;
    }
    if (Math.abs(a * d - b * c) < 1e-12) return null;
    const tx = box.left + box.width / 2 - (a * size[0]) / 2 - (b * size[1]) / 2;
    const ty = box.top + box.height / 2 - (c * size[0]) / 2 - (d * size[1]) / 2;
    if (!Number.isFinite(tx) || !Number.isFinite(ty)) return null;
    const map = (x: number, y: number): [number, number] => [a * x + b * y + tx, c * x + d * y + ty];
    try {
      const corners = [map(0, 0), map(size[0], 0), map(0, size[1]), map(size[0], size[1])];
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const [cx, cy] of corners) {
        if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
        if (cx < x0) x0 = cx;
        if (cy < y0) y0 = cy;
        if (cx > x1) x1 = cx;
        if (cy > y1) y1 = cy;
      }
      const tol = 1;
      if (
        Math.abs(x0 - box.left) > tol ||
        Math.abs(y0 - box.top) > tol ||
        Math.abs(x1 - (box.left + box.width)) > tol ||
        Math.abs(y1 - (box.top + box.height)) > tol
      ) {
        return null;
      }
    } catch {
      return null;
    }
    return map;
  }

  interface InkSavedProp {
    node: Element;
    prop: string;
    value: string;
    priority: string;
  }

  function inkRestoreProps(saved: InkSavedProp[]): void {
    for (const s of saved) {
      try {
        const st = (s.node as HTMLElement).style;
        if (!s.value) st.removeProperty(s.prop);
        else st.setProperty(s.prop, s.value, s.priority);
      } catch {
        // keep restoring the rest
      }
    }
  }

  /**
   * Pins every transform of the chain to `none` with important inline style
   * (wins over stylesheets and running animations; synchronous, so no frame
   * paints mid-measurement) and verifies the pin took. The caller restores in a
   * finally. Transforms never move layout, so line boxes read while pinned
   * equal the live ones.
   */
  function inkPinChain(nodes: Element[]): InkSavedProp[] | null {
    const saved: InkSavedProp[] = [];
    const seen = new Set<Element>();
    try {
      for (const n of nodes) {
        if (seen.has(n)) continue;
        seen.add(n);
        const st = (n as HTMLElement).style;
        for (const p of ["transform", "translate", "rotate", "scale"]) {
          saved.push({
            node: n,
            prop: p,
            value: st.getPropertyValue(p),
            priority: st.getPropertyPriority(p),
          });
          st.setProperty(p, "none", "important");
        }
      }
    } catch {
      inkRestoreProps(saved);
      return null;
    }
    for (const n of seen) {
      let cs: CSSStyleDeclaration;
      try {
        cs = getComputedStyle(n);
      } catch {
        inkRestoreProps(saved);
        return null;
      }
      const rec = cs as unknown as Record<string, string>;
      const vals = [
        (cs.transform || "").trim().toLowerCase(),
        (rec["translate"] || "").trim().toLowerCase(),
        (rec["rotate"] || "").trim().toLowerCase(),
        (rec["scale"] || "").trim().toLowerCase(),
      ];
      if (vals.some((v) => v !== "" && v !== "none")) {
        inkRestoreProps(saved);
        return null;
      }
    }
    return saved;
  }

  interface InkMultiCache {
    text: string;
    key: string;
    /** Line boxes in the element border frame, top to bottom. */
    boxes: Array<[number, number, number, number]>;
  }

  function inkLayoutSig(cs: CSSStyleDeclaration): string {
    const rec = cs as unknown as Record<string, string>;
    return [
      rec["textAlign"],
      rec["textIndent"],
      rec["whiteSpace"],
      rec["wordSpacing"],
      rec["wordBreak"],
      rec["overflowWrap"],
      rec["direction"],
      rec["writingMode"],
      rec["paddingLeft"],
      rec["paddingTop"],
      rec["paddingRight"],
      rec["paddingBottom"],
      rec["borderLeftWidth"],
      rec["borderTopWidth"],
      rec["borderRightWidth"],
      rec["borderBottomWidth"],
      rec["boxSizing"],
    ].join("|");
  }

  function inkReadMultiCache(node: Text, key: string): Array<[number, number, number, number]> | null {
    const rec = (node as unknown as Record<string, InkMultiCache | undefined>)["__cxinkm"];
    if (!rec || rec.text !== (node.nodeValue || "") || rec.key !== key) return null;
    return rec.boxes;
  }

  function inkWriteMultiCache(
    node: Text,
    key: string,
    boxes: Array<[number, number, number, number]>
  ): void {
    (node as unknown as Record<string, InkMultiCache>)["__cxinkm"] = {
      text: node.nodeValue || "",
      key,
      boxes,
    };
  }


  /**
   * Maps a point in the element's border-box frame to client pixels. Exact when only the
   * element itself is transformed (the affine center trick: the client AABB center is the
   * image of the layout center); one transformed ancestor is composed through integer
   * offsets (+-0.5 px); anything more complex returns null (caller falls back to no ink).
   */
  function composeLocalToClient(
    el: Element,
    elCs: CSSStyleDeclaration,
    elClientAabb: { x: number; y: number; w: number; h: number },
    chain: ChainInfo
  ): ((x: number, y: number) => [number, number]) | null {
    if (chain.complex || chain.transforms.length > 1) return null;
    const toClient = (rx: number, ry: number): [number, number] => [
      state.rootLeft + rx * state.scaleX,
      state.rootTop + ry * state.scaleY,
    ];
    if (chain.transforms.length === 0) {
      // Untransformed: derive the layout origin from the client box itself.
      const ox = (elClientAabb.x - state.rootLeft) / state.scaleX;
      const oy = (elClientAabb.y - state.rootTop) / state.scaleY;
      return (x, y) => toClient(ox + x, oy + y);
    }
    // Layout origin of a transformed node in root coords: the client AABB center is
    // the image of the layout center under any affine map, so origin = center - M(center).
    const layoutOrigin = (
      m: DOMMatrix,
      size: [number, number],
      aabb: { x: number; y: number; w: number; h: number }
    ): [number, number] => {
      const ccx = (aabb.x + aabb.w / 2 - state.rootLeft) / state.scaleX;
      const ccy = (aabb.y + aabb.h / 2 - state.rootTop) / state.scaleY;
      const mc = m.transformPoint(new DOMPoint(size[0] / 2, size[1] / 2));
      return [ccx - mc.x, ccy - mc.y];
    };
    const tr = chain.transforms[0];
    if (tr.node !== el) {
      // One transformed ancestor: element origin inside its border frame via offsets.
      let px = 0;
      let py = 0;
      let cur: Element | null = el;
      while (cur && cur !== tr.node) {
        const op = (cur as HTMLElement).offsetParent as Element | null;
        px += (cur as HTMLElement).offsetLeft || 0;
        py += (cur as HTMLElement).offsetTop || 0;
        if (op === tr.node) break;
        if (!op || op === document.body || op === document.documentElement) return null;
        // Next step is relative to the next padding box: cross this border too.
        px += (op as HTMLElement).clientLeft || 0;
        py += (op as HTMLElement).clientTop || 0;
        cur = op;
      }
      if (!cur || (cur as HTMLElement).offsetParent !== tr.node) {
        // Fell off the chain (fixed positioning): cannot compose.
        return null;
      }
      px += (tr.node as HTMLElement).clientLeft || 0;
      py += (tr.node as HTMLElement).clientTop || 0;
      const trCs = getComputedStyle(tr.node);
      const m = ownMatrix(tr.node, trCs);
      const size = borderSizeOf(trCs);
      if (!m || !size) return null;
      const ar = tr.node.getBoundingClientRect();
      if (ar.width <= 0 || ar.height <= 0) return null;
      const [ox, oy] = layoutOrigin(m, size, {
        x: ar.left,
        y: ar.top,
        w: ar.width,
        h: ar.height,
      });
      if (!Number.isFinite(ox) || !Number.isFinite(oy)) return null;
      // Map: element-local -> ancestor-local -> ancestor-layout(root) -> client.
      return (x, y) => {
        const q = m.transformPoint(new DOMPoint(px + x, py + y));
        return toClient(ox + q.x, oy + q.y);
      };
    }
    // Only the element itself is transformed: exact center trick.
    const m = ownMatrix(el, elCs);
    const size = borderSizeOf(elCs);
    if (!m || !size) return null;
    const [ox, oy] = layoutOrigin(m, size, elClientAabb);
    if (!Number.isFinite(ox) || !Number.isFinite(oy)) return null;
    return (x, y) => {
      const q = m.transformPoint(new DOMPoint(x, y));
      return toClient(ox + q.x, oy + q.y);
    };
  }

  function selfCheckMapping(
    el: Element,
    elCs: CSSStyleDeclaration,
    elClientAabb: { x: number; y: number; w: number; h: number },
    map: (x: number, y: number) => [number, number],
    tol: number
  ): boolean {
    const size = borderSizeOf(elCs);
    if (!size) return false;
    try {
      const corners: Array<[number, number]> = [
        map(0, 0),
        map(size[0], 0),
        map(0, size[1]),
        map(size[0], size[1]),
      ];
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const [cx, cy] of corners) {
        if (!Number.isFinite(cx) || !Number.isFinite(cy)) return false;
        if (cx < x0) x0 = cx;
        if (cy < y0) y0 = cy;
        if (cx > x1) x1 = cx;
        if (cy > y1) y1 = cy;
      }
      return (
        Math.abs(x0 - elClientAabb.x) <= tol &&
        Math.abs(y0 - elClientAabb.y) <= tol &&
        Math.abs(x1 - (elClientAabb.x + elClientAabb.w)) <= tol &&
        Math.abs(y1 - (elClientAabb.y + elClientAabb.h)) <= tol
      );
    } catch {
      return false;
    }
  }

  // --- Ink: images ---

  function parseObjectPosition(
    value: string
  ): { x: { v: number; pct: boolean }; y: { v: number; pct: boolean } } | null {
    const toks = value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (toks.length === 0 || toks.length > 2) return null;
    const one = (t: string): { v: number; pct: boolean } | null => {
      if (t === "left" || t === "top") return { v: 0, pct: true };
      if (t === "center") return { v: 50, pct: true };
      if (t === "right" || t === "bottom") return { v: 100, pct: true };
      if (t.endsWith("%")) {
        const v = Number(t.slice(0, -1));
        return Number.isFinite(v) ? { v, pct: true } : null;
      }
      if (t.endsWith("px")) {
        const v = Number(t.slice(0, -2));
        return Number.isFinite(v) ? { v, pct: false } : null;
      }
      return null;
    };
    const x = one(toks[0]);
    if (!x) return null;
    if (toks.length === 1) {
      // A single value fixes the x axis except for top/bottom (CSS: the other axis centers).
      if (toks[0] === "top") return { x: { v: 50, pct: true }, y: { v: 0, pct: true } };
      if (toks[0] === "bottom") return { x: { v: 50, pct: true }, y: { v: 100, pct: true } };
      return { x, y: { v: 50, pct: true } };
    }
    const y = one(toks[1]);
    return y ? { x, y } : null;
  }

  /**
   * Drawn image rectangle in border-box-relative px (object-fit/position aware),
   * unclipped, plus the content box it clips against. Ink margins are fractions of
   * the whole drawn image, so the caller insets first and clips to the content box.
   */
  function drawnImageRect(
    el: HTMLImageElement,
    cs: CSSStyleDeclaration
  ): {
    drawn: { x: number; y: number; w: number; h: number };
    content: { x: number; y: number; w: number; h: number };
  } | null {
    const rec = cs as unknown as Record<string, string>;
    const num = (k: string): number => {
      const v = parseFloat(rec[k] || "");
      return Number.isFinite(v) ? v : 0;
    };
    const bl = num("borderLeftWidth");
    const bt = num("borderTopWidth");
    const pl = num("paddingLeft");
    const pt = num("paddingTop");
    const pr = num("paddingRight");
    const pb = num("paddingBottom");
    const cw = parseFloat(rec["width"] || "");
    const ch = parseFloat(rec["height"] || "");
    if (!Number.isFinite(cw) || !Number.isFinite(ch) || cw <= 0 || ch <= 0) return null;
    const iw = el.naturalWidth || 0;
    const ih = el.naturalHeight || 0;
    if (iw <= 0 || ih <= 0) return null;
    const fit = (rec["objectFit"] || "fill").trim().toLowerCase();
    let dw = cw;
    let dh = ch;
    if (fit === "fill") {
      dw = cw;
      dh = ch;
    } else if (fit === "contain") {
      const s = Math.min(cw / iw, ch / ih);
      dw = iw * s;
      dh = ih * s;
    } else if (fit === "cover") {
      const s = Math.max(cw / iw, ch / ih);
      dw = iw * s;
      dh = ih * s;
    } else if (fit === "none") {
      dw = iw;
      dh = ih;
    } else if (fit === "scale-down") {
      if (iw > cw || ih > ch) {
        const s = Math.min(cw / iw, ch / ih);
        dw = iw * s;
        dh = ih * s;
      } else {
        dw = iw;
        dh = ih;
      }
    } else {
      return null;
    }
    const pos = parseObjectPosition(rec["objectPosition"] || "50% 50%");
    if (!pos) return null;
    const off = (
      p: { v: number; pct: boolean },
      content: number,
      drawn: number
    ): number => (p.pct ? ((content - drawn) * p.v) / 100 : p.v);
    const ox = off(pos.x, cw, dw);
    const oy = off(pos.y, ch, dh);
    return {
      drawn: { x: bl + pl + ox, y: bt + pt + oy, w: dw, h: dh },
      content: { x: bl + pl, y: bt + pt, w: cw, h: ch },
    };
  }

  /** Transparent margins of the live bitmap via canvas (alpha > 12 bounding box). */
  function measureDataUriMargins(img: HTMLImageElement): CoordsInpageImageMargins | null {
    const w = img.naturalWidth || 0;
    const h = img.naturalHeight || 0;
    if (w <= 0 || h <= 0 || w * h > 16777216) return null;
    try {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const g = c.getContext("2d", { willReadFrequently: true } as CanvasRenderingContext2DSettings);
      if (!g) return null;
      g.drawImage(img, 0, 0);
      const px = g.getImageData(0, 0, w, h).data;
      let minX = w;
      let minY = h;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < h; y++) {
        const row = y * w * 4;
        for (let x = 0; x < w; x++) {
          if (px[row + x * 4 + 3] > 12) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < minX || maxY < minY) return null;
      // Speck robustness (mirrors the Node path): an edge row/column counts only
      // with >= 3 ink pixels.
      const rowCount = (y: number): number => {
        let n = 0;
        for (let x = minX; x <= maxX && n < 3; x++) {
          if (px[(y * w + x) * 4 + 3] > 12) n++;
        }
        return n;
      };
      const colCount = (x: number): number => {
        let n = 0;
        for (let y = minY; y <= maxY && n < 3; y++) {
          if (px[(y * w + x) * 4 + 3] > 12) n++;
        }
        return n;
      };
      while (minY <= maxY && rowCount(minY) < 3) minY++;
      while (maxY >= minY && rowCount(maxY) < 3) maxY--;
      while (minX <= maxX && colCount(minX) < 3) minX++;
      while (maxX >= minX && colCount(maxX) < 3) maxX--;
      if (maxX < minX || maxY < minY) return null;
      return {
        left: minX / w,
        top: minY / h,
        right: (w - maxX - 1) / w,
        bottom: (h - maxY - 1) / h,
        width: w,
        height: h,
      };
    } catch {
      return null;
    }
  }

  /**
   * Local ink rectangle of an image in its border frame (no transforms applied):
   * the drawn image rectangle (`object-fit`/`object-position` aware) inset by the
   * asset's transparent margins and clipped to the content box.
   */
  function imageLocalInk(
    el: Element,
    cs: CSSStyleDeclaration,
    it: CoordsTrackedItem
  ): [number, number, number, number] | null {
    const img = el as HTMLImageElement;
    if (borderVisible(cs)) return null;
    const natW = img.naturalWidth || 0;
    const natH = img.naturalHeight || 0;
    if (natW <= 0 || natH <= 0) return null;
    // Margins come from the discovery-time source without re-reading it: `currentSrc`
    // of an inlined asset is a multi-MB string and costs milliseconds per read. A source
    // swap to different dimensions re-resolves once (same-dimension swaps keep the old
    // margins; compositions do not swap sources mid-measurement).
    let m: CoordsInpageImageMargins | null | undefined;
    if (!it.assetDataUri) {
      const key = it.assetChecked ?? it.asset;
      m = key ? state.inkByUrl.get(key) : undefined;
      if (!m || m.width !== natW || m.height !== natH) {
        if (it.assetSlowDone) return null;
        it.assetSlowDone = true;
        try {
          const live = img.currentSrc || img.getAttribute("src") || "";
          if (!live) return null;
          if (live.startsWith("data:")) {
            it.assetDataUri = true;
          } else {
            const url = new URL(live, document.baseURI).href;
            const hit = state.inkByUrl.get(url);
            if (hit && hit.width === natW && hit.height === natH) {
              it.assetChecked = url;
              m = hit;
            } else {
              return null;
            }
          }
        } catch {
          return null;
        }
      }
    }
    if (it.assetDataUri) {
      if (it.dataMargins === undefined || it.dataNatW !== natW || it.dataNatH !== natH) {
        it.dataMargins = measureDataUriMargins(img);
        it.dataNatW = natW;
        it.dataNatH = natH;
      }
      if (!it.dataMargins) return null;
      m = it.dataMargins;
    }
    if (!m) return null;
    const placed = drawnImageRect(img, cs);
    if (!placed) return null;
    // Margins are fractions of the whole drawn image: inset first, then clip the
    // ink to the content box (replaced content never paints outside it).
    const ix0 = placed.drawn.x + m.left * placed.drawn.w;
    const iy0 = placed.drawn.y + m.top * placed.drawn.h;
    const ix1 = placed.drawn.x + placed.drawn.w * (1 - m.right);
    const iy1 = placed.drawn.y + placed.drawn.h * (1 - m.bottom);
    const cx0 = placed.content.x;
    const cy0 = placed.content.y;
    const cx1 = placed.content.x + placed.content.w;
    const cy1 = placed.content.y + placed.content.h;
    const ix = Math.max(ix0, cx0);
    const iy = Math.max(iy0, cy0);
    const iw = Math.min(ix1, cx1) - ix;
    const ih = Math.min(iy1, cy1) - iy;
    if (!(iw > 0) || !(ih > 0)) return null;
    return [ix, iy, iw, ih];
  }

  function imageInk(
    el: Element,
    cs: CSSStyleDeclaration,
    chain: ChainInfo,
    itemClient: { x: number; y: number; w: number; h: number },
    it: CoordsTrackedItem
  ): [number, number, number, number] | null {
    const local = imageLocalInk(el, cs, it);
    if (!local) return null;
    const [ix, iy, iw, ih] = local;
    // Untransformed chains map local px 1:1 onto the item box.
    if (chain.transforms.length === 0 && !chain.complex) {
      const ox = (itemClient.x - state.rootLeft) / state.scaleX;
      const oy = (itemClient.y - state.rootTop) / state.scaleY;
      return [ox + ix, oy + iy, iw, ih];
    }
    const map = composeLocalToClient(el, cs, itemClient, chain);
    if (!map) return null;
    const tol = chain.transforms.length > 0 && chain.transforms[0].node !== el ? 1.2 : 0.6;
    if (!selfCheckMapping(el, cs, itemClient, map, tol)) return null;
    try {
      const c1 = map(ix, iy);
      const c2 = map(ix + iw, iy);
      const c3 = map(ix, iy + ih);
      const c4 = map(ix + iw, iy + ih);
      const x0 = Math.min(c1[0], c2[0], c3[0], c4[0]);
      const y0 = Math.min(c1[1], c2[1], c3[1], c4[1]);
      const x1 = Math.max(c1[0], c2[0], c3[0], c4[0]);
      const y1 = Math.max(c1[1], c2[1], c3[1], c4[1]);
      return [
        (x0 - state.rootLeft) / state.scaleX,
        (y0 - state.rootTop) / state.scaleY,
        (x1 - x0) / state.scaleX,
        (y1 - y0) / state.scaleY,
      ];
    } catch {
      return null;
    }
  }

  // --- Ink: text ---

  function textInk(
    el: Element,
    cs: CSSStyleDeclaration,
    chain: ChainInfo
  ): [number, number, number, number] | null {
    // Transformed text keeps the line box (inverse-mapping each line through the
    // chain is not worth the risk; the item box still covers the glyphs). This check
    // comes first so transformed text pays no cache or Range work at all.
    if (chain.transforms.length > 0 || chain.complex) return null;
    // Bearings below assume left-to-right advances (the line rect's left edge is the
    // advance start); right-to-left text keeps the line box.
    if ((cs as unknown as Record<string, string>)["direction"] === "rtl") return null;
    const lines = textLineBoxes(el);
    if (lines.length === 0) return null;
    // Per-node caches; a reflowed node is re-measured once.
    const byNode = new Map<Text, { rects: DOMRect[]; cache: TextNodeInkCache }>();
    for (const ln of lines) {
      let e = byNode.get(ln.node);
      if (!e) {
        const cache = nodeInkCache(ln.node, el, cs);
        if (!cache) return null;
        e = { rects: [], cache };
        byNode.set(ln.node, e);
      }
      e.rects.push(ln.rect);
    }
    for (const [node, e] of byNode) {
      if (e.rects.length !== e.cache.lines.length) {
        clearNodeInkCache(node);
        const cache = nodeInkCache(node, el, cs);
        if (!cache || cache.lines.length !== e.rects.length) return null;
        e.cache = cache;
      }
    }
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [, e] of byNode) {
      const emH = e.cache.fontAsc + e.cache.fontDesc;
      for (let i = 0; i < e.rects.length; i++) {
        const r = e.rects[i];
        const lm = e.cache.lines[i];
        // Untransformed fast path: shrink the client line box by local bearings.
        const lh = r.height / state.scaleY;
        if (!(lh > 0)) return null;
        const halfLead = (lh - emH) / 2;
        const topTrim = (halfLead + (e.cache.fontAsc - lm.asc)) * state.scaleY;
        const botTrim = (halfLead + (e.cache.fontDesc - lm.desc)) * state.scaleY;
        // NOTE: actualBoundingBoxLeft is positive LEFTWARD from the alignment point
        // (actualBoundingBoxRight positive rightward), so the left ink edge is x0 - left.
        const lx = r.left - lm.left * state.scaleX;
        const rx = r.left + lm.right * state.scaleX;
        const ty = r.top + topTrim;
        const by = r.bottom - botTrim;
        if (!(rx > lx) || !(by > ty)) return null;
        const cx = (lx - state.rootLeft) / state.scaleX;
        const cy = (ty - state.rootTop) / state.scaleY;
        const cw = (rx - lx) / state.scaleX;
        const ch = (by - ty) / state.scaleY;
        if (cx < x0) x0 = cx;
        if (cy < y0) y0 = cy;
        if (cx + cw > x1) x1 = cx + cw;
        if (cy + ch > y1) y1 = cy + ch;
      }
    }
    if (!Number.isFinite(x0) || !(x1 > x0) || !(y1 > y0)) return null;
    // A text stroke paints around the glyph edge (canvas metrics exclude it).
    const sw = parseFloat(cs.getPropertyValue("-webkit-text-stroke-width") || "") || 0;
    if (sw > 0) {
      const pad = sw / 2 + 0.5;
      x0 -= pad;
      y0 -= pad;
      x1 += pad;
      y1 += pad;
    }
    return [x0, y0, x1 - x0, y1 - y0];
  }

  // --- Ink: svg ---

  /**
   * Local ink rectangle of an SVG root without a viewBox (geometry box in the
   * border frame; padding/border invalidate the origin assumption).
   */
  function svgLocalInk(
    el: Element,
    cs: CSSStyleDeclaration
  ): [number, number, number, number] | null {
    try {
      if (el.getAttribute("viewBox")) return null;
      const rec = cs as unknown as Record<string, string>;
      const pad =
        parseFloat(rec["paddingLeft"] || "") +
        parseFloat(rec["paddingRight"] || "") +
        parseFloat(rec["paddingTop"] || "") +
        parseFloat(rec["paddingBottom"] || "") +
        parseFloat(rec["borderLeftWidth"] || "") +
        parseFloat(rec["borderTopWidth"] || "") +
        parseFloat(rec["borderRightWidth"] || "") +
        parseFloat(rec["borderBottomWidth"] || "");
      if (!(pad === 0)) return null;
      let bb: DOMRect;
      try {
        // Stroke-inclusive when supported (painted pixels include the stroke).
        bb = (el as unknown as SVGSVGElement).getBBox({ stroke: true } as object);
      } catch {
        try {
          bb = (el as unknown as SVGSVGElement).getBBox();
        } catch {
          return null;
        }
      }
      if (!Number.isFinite(bb.x) || !(bb.width > 0) || !(bb.height > 0)) return null;
      const size = borderSizeOf(cs);
      if (!size) return null;
      // Geometry outside the viewport cannot be trusted (origin assumption).
      if (bb.x < -1 || bb.y < -1 || bb.x + bb.width > size[0] + 1 || bb.y + bb.height > size[1] + 1) {
        return null;
      }
      return [bb.x, bb.y, bb.width, bb.height];
    } catch {
      return null;
    }
  }

  function svgInk(
    el: Element,
    cs: CSSStyleDeclaration,
    chain: ChainInfo,
    itemClient: { x: number; y: number; w: number; h: number }
  ): [number, number, number, number] | null {
    let local: [number, number, number, number] | null;
    try {
      local = svgLocalInk(el, cs);
    } catch {
      return null;
    }
    if (!local) return null;
    const bb = { x: local[0], y: local[1], width: local[2], height: local[3] };
    try {
      if (chain.transforms.length === 0 && !chain.complex) {
        const ox = (itemClient.x - state.rootLeft) / state.scaleX;
        const oy = (itemClient.y - state.rootTop) / state.scaleY;
        return [ox + bb.x, oy + bb.y, bb.width, bb.height];
      }
      const map = composeLocalToClient(el, cs, itemClient, chain);
      if (!map) return null;
      const tol = chain.transforms.length > 0 && chain.transforms[0].node !== el ? 1.2 : 0.6;
      if (!selfCheckMapping(el, cs, itemClient, map, tol)) return null;
      const c1 = map(bb.x, bb.y);
      const c2 = map(bb.x + bb.width, bb.y);
      const c3 = map(bb.x, bb.y + bb.height);
      const c4 = map(bb.x + bb.width, bb.y + bb.height);
      const x0 = Math.min(c1[0], c2[0], c3[0], c4[0]);
      const y0 = Math.min(c1[1], c2[1], c3[1], c4[1]);
      const x1 = Math.max(c1[0], c2[0], c3[0], c4[0]);
      const y1 = Math.max(c1[1], c2[1], c3[1], c4[1]);
      return [
        (x0 - state.rootLeft) / state.scaleX,
        (y0 - state.rootTop) / state.scaleY,
        (x1 - x0) / state.scaleX,
        (y1 - y0) / state.scaleY,
      ];
    } catch {
      return null;
    }
  }

  // --- Ink: multi-chain entry points (text, image, svg) ---

  function imageInkMulti(
    el: Element,
    cs: CSSStyleDeclaration,
    it: CoordsTrackedItem
  ): [number, number, number, number] | null {
    const local = imageLocalInk(el, cs, it);
    if (!local) return null;
    const map = inkChainMap(el, cs);
    if (!map) return null;
    try {
      const [ix, iy, iw, ih] = local;
      const c1 = map(ix, iy);
      const c2 = map(ix + iw, iy);
      const c3 = map(ix, iy + ih);
      const c4 = map(ix + iw, iy + ih);
      const x0 = Math.min(c1[0], c2[0], c3[0], c4[0]);
      const y0 = Math.min(c1[1], c2[1], c3[1], c4[1]);
      const x1 = Math.max(c1[0], c2[0], c3[0], c4[0]);
      const y1 = Math.max(c1[1], c2[1], c3[1], c4[1]);
      return [
        (x0 - state.rootLeft) / state.scaleX,
        (y0 - state.rootTop) / state.scaleY,
        (x1 - x0) / state.scaleX,
        (y1 - y0) / state.scaleY,
      ];
    } catch {
      return null;
    }
  }

  function svgInkMulti(
    el: Element,
    cs: CSSStyleDeclaration
  ): [number, number, number, number] | null {
    let local: [number, number, number, number] | null;
    try {
      local = svgLocalInk(el, cs);
    } catch {
      return null;
    }
    if (!local) return null;
    const map = inkChainMap(el, cs);
    if (!map) return null;
    try {
      const [ix, iy, iw, ih] = local;
      const c1 = map(ix, iy);
      const c2 = map(ix + iw, iy);
      const c3 = map(ix, iy + ih);
      const c4 = map(ix + iw, iy + ih);
      const x0 = Math.min(c1[0], c2[0], c3[0], c4[0]);
      const y0 = Math.min(c1[1], c2[1], c3[1], c4[1]);
      const x1 = Math.max(c1[0], c2[0], c3[0], c4[0]);
      const y1 = Math.max(c1[1], c2[1], c3[1], c4[1]);
      return [
        (x0 - state.rootLeft) / state.scaleX,
        (y0 - state.rootTop) / state.scaleY,
        (x1 - x0) / state.scaleX,
        (y1 - y0) / state.scaleY,
      ];
    } catch {
      return null;
    }
  }

  /**
   * Glyph ink of a text element under nested 2D transforms. Line boxes are read
   * once per layout in the element border frame (transforms pinned while
   * reading, then restored) and each line's local ink is mapped through the
   * composite chain. Shares the glyph metric cache with the flat path.
   */
  function textInkMulti(
    el: Element,
    cs: CSSStyleDeclaration,
    chain: ChainInfo
  ): [number, number, number, number] | null {
    const rec = cs as unknown as Record<string, string>;
    if (rec["direction"] === "rtl") return null;
    // A fixed element's layout answers to its containing block, which pinning
    // would move; keep the safe fallback there.
    if (rec["position"] === "fixed") return null;
    const nodes: Text[] = [];
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === 3 && /\S/.test(n.nodeValue || "")) nodes.push(n as Text);
    }
    if (nodes.length === 0) return null;
    const map = inkChainMap(el, cs);
    if (!map) return null;
    // Cache key first: computed style is live, pinning must not move the key.
    const fontSig = fontSigOf(cs);
    const widthPx = (el as HTMLElement).clientWidth || 0;
    const layoutSig = inkLayoutSig(cs);
    const keyOf = (): string => fontSig + "|" + widthPx + "|" + layoutSig;
    let boxesByNode: Array<Array<[number, number, number, number]> | null> = nodes.map((n) =>
      inkReadMultiCache(n, keyOf())
    );
    if (boxesByNode.some((b) => b === null)) {
      const pinned = inkPinChain([el, ...chain.transforms.map((t) => t.node)]);
      if (!pinned) return null;
      try {
        let origin: { left: number; top: number };
        try {
          origin = el.getBoundingClientRect();
        } catch {
          return null;
        }
        const fresh: Array<Array<[number, number, number, number]> | null> = [];
        for (const n of nodes) {
          const cache = nodeInkCache(n, el, cs);
          if (!cache) return null;
          range.selectNode(n);
          const rects = Array.from(range.getClientRects()).filter(
            (r) => r.width > 0 && r.height > 0
          );
          if (rects.length !== cache.lines.length) {
            clearNodeInkCache(n);
            const retry = nodeInkCache(n, el, cs);
            if (!retry || retry.lines.length !== rects.length) return null;
          }
          const boxes: Array<[number, number, number, number]> = rects.map((r) => [
            r.left - origin.left,
            r.top - origin.top,
            r.width,
            r.height,
          ]);
          inkWriteMultiCache(n, keyOf(), boxes);
          fresh.push(boxes);
        }
        boxesByNode = fresh;
      } finally {
        inkRestoreProps(pinned);
      }
    }
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const sw = parseFloat(cs.getPropertyValue("-webkit-text-stroke-width") || "") || 0;
    const pad = sw > 0 ? sw / 2 + 0.5 : 0;
    for (let i = 0; i < nodes.length; i++) {
      const boxes = boxesByNode[i];
      if (!boxes) return null;
      const cache = nodeInkCache(nodes[i] as Text, el, cs);
      if (!cache || cache.lines.length !== boxes.length) return null;
      const emH = cache.fontAsc + cache.fontDesc;
      for (let j = 0; j < boxes.length; j++) {
        const b = boxes[j] as [number, number, number, number];
        const lm = cache.lines[j] as InkLineMetric;
        if (!(b[2] > 0) || !(b[3] > 0)) return null;
        const halfLead = (b[3] - emH) / 2;
        const topTrim = halfLead + (cache.fontAsc - lm.asc);
        const botTrim = halfLead + (cache.fontDesc - lm.desc);
        // Bearings mirror the flat path (actualBoundingBoxLeft runs leftward).
        const lx = b[0] - lm.left - pad;
        const rx = b[0] + lm.right + pad;
        const ty = b[1] + topTrim - pad;
        const by = b[1] + b[3] - botTrim + pad;
        if (!(rx > lx) || !(by > ty)) return null;
        const c1 = map(lx, ty);
        const c2 = map(rx, ty);
        const c3 = map(lx, by);
        const c4 = map(rx, by);
        const flat = [c1[0], c1[1], c2[0], c2[1], c3[0], c3[1], c4[0], c4[1]];
        if (flat.some((v) => !Number.isFinite(v))) return null;
        x0 = Math.min(x0, c1[0], c2[0], c3[0], c4[0]);
        y0 = Math.min(y0, c1[1], c2[1], c3[1], c4[1]);
        x1 = Math.max(x1, c1[0], c2[0], c3[0], c4[0]);
        y1 = Math.max(y1, c1[1], c2[1], c3[1], c4[1]);
      }
    }
    if (!Number.isFinite(x0) || !(x1 > x0) || !(y1 > y0)) return null;
    return [
      (x0 - state.rootLeft) / state.scaleX,
      (y0 - state.rootTop) / state.scaleY,
      (x1 - x0) / state.scaleX,
      (y1 - y0) / state.scaleY,
    ];
  }

  // --- Quads: rotated corners for transformed elements ---

  /** Per-edge tolerance (px, composition space) between a quad's AABB and its box. */
  const QUAD_VERIFY_TOL = 1.2;

  function quadAabbMatchesBox(
    corners: Array<[number, number]>,
    box: [number, number, number, number]
  ): boolean {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [cx, cy] of corners) {
      if (!Number.isFinite(cx) || !Number.isFinite(cy)) return false;
      if (cx < x0) x0 = cx;
      if (cy < y0) y0 = cy;
      if (cx > x1) x1 = cx;
      if (cy > y1) y1 = cy;
    }
    return (
      Math.abs(x0 - box[0]) <= QUAD_VERIFY_TOL &&
      Math.abs(y0 - box[1]) <= QUAD_VERIFY_TOL &&
      Math.abs(x1 - (box[0] + box[2])) <= QUAD_VERIFY_TOL &&
      Math.abs(y1 - (box[1] + box[3])) <= QUAD_VERIFY_TOL
    );
  }

  function clientCornersToComp(
    corners: Array<[number, number]>
  ): [number, number, number, number, number, number, number, number] | null {
    const flat: number[] = [];
    for (const [cx, cy] of corners) {
      const rx = (cx - state.rootLeft) / state.scaleX;
      const ry = (cy - state.rootTop) / state.scaleY;
      if (!Number.isFinite(rx) || !Number.isFinite(ry)) return null;
      flat.push(rx, ry);
    }
    return flat as [number, number, number, number, number, number, number, number];
  }

  /**
   * Item quad for a non-text element: the border-box corners through the verified
   * chain map. Returns null for flat chains or any verification mismatch (the caller
   * keeps the box, which is always emitted).
   */
  function itemQuadForBox(
    el: Element,
    cs: CSSStyleDeclaration,
    chain: ChainInfo,
    clientBox: { x: number; y: number; w: number; h: number },
    itemBox: [number, number, number, number]
  ): [number, number, number, number, number, number, number, number] | null {
    if (chain.transforms.length === 0 || chain.complex) return null;
    const map = composeLocalToClient(el, cs, clientBox, chain);
    if (!map) return null;
    const tol = chain.transforms.length > 0 && chain.transforms[0].node !== el ? 1.2 : 0.6;
    if (!selfCheckMapping(el, cs, clientBox, map, tol)) return null;
    const size = borderSizeOf(cs);
    if (!size) return null;
    try {
      const corners: Array<[number, number]> = [
        map(0, 0),
        map(size[0], 0),
        map(size[0], size[1]),
        map(0, size[1]),
      ];
      const comp = clientCornersToComp(corners);
      if (!comp) return null;
      const compCorners: Array<[number, number]> = [
        [comp[0], comp[1]],
        [comp[2], comp[3]],
        [comp[4], comp[5]],
        [comp[6], comp[7]],
      ];
      return quadAabbMatchesBox(compCorners, itemBox) ? comp : null;
    } catch {
      return null;
    }
  }

  /**
   * Ink quad for an image/svg element under a transform: the local ink rect corners
   * through the same verified chain map the ink box used. Null when the ink box is
   * absent (flat path) or the corners do not verify against it.
   */
  function inkQuadForLocalRect(
    el: Element,
    cs: CSSStyleDeclaration,
    chain: ChainInfo,
    clientBox: { x: number; y: number; w: number; h: number },
    local: [number, number, number, number],
    inkBox: [number, number, number, number]
  ): [number, number, number, number, number, number, number, number] | null {
    if (chain.transforms.length === 0 || chain.complex) return null;
    const map = composeLocalToClient(el, cs, clientBox, chain);
    if (!map) return null;
    const tol = chain.transforms.length > 0 && chain.transforms[0].node !== el ? 1.2 : 0.6;
    if (!selfCheckMapping(el, cs, clientBox, map, tol)) return null;
    try {
      const [ix, iy, iw, ih] = local;
      const corners: Array<[number, number]> = [
        map(ix, iy),
        map(ix + iw, iy),
        map(ix + iw, iy + ih),
        map(ix, iy + ih),
      ];
      const comp = clientCornersToComp(corners);
      if (!comp) return null;
      const compCorners: Array<[number, number]> = [
        [comp[0], comp[1]],
        [comp[2], comp[3]],
        [comp[4], comp[5]],
        [comp[6], comp[7]],
      ];
      return quadAabbMatchesBox(compCorners, inkBox) ? comp : null;
    } catch {
      return null;
    }
  }

  /**
   * Item + ink quads for transformed text, from the cached border-frame line boxes
   * `textInkMulti` just populated (same frame, same key): the item quad covers the
   * line-box union, the ink quad the glyph union. Returns null on a cold cache or any
   * verification mismatch; the boxes always stay.
   */
  function textQuadsMulti(
    el: Element,
    cs: CSSStyleDeclaration,
    chain: ChainInfo,
    itemBox: [number, number, number, number],
    inkBox: [number, number, number, number] | null
  ): {
    item: [number, number, number, number, number, number, number, number];
    ink: [number, number, number, number, number, number, number, number] | null;
  } | null {
    if (chain.transforms.length === 0 || chain.complex) return null;
    const rec = cs as unknown as Record<string, string>;
    if (rec["direction"] === "rtl" || rec["position"] === "fixed") return null;
    const nodes: Text[] = [];
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === 3 && /\S/.test(n.nodeValue || "")) nodes.push(n as Text);
    }
    if (nodes.length === 0) return null;
    const map = inkChainMap(el, cs);
    if (!map) return null;
    const fontSig = fontSigOf(cs);
    const widthPx = (el as HTMLElement).clientWidth || 0;
    const key = fontSig + "|" + widthPx + "|" + inkLayoutSig(cs);
    let lx0 = Infinity;
    let ly0 = Infinity;
    let lx1 = -Infinity;
    let ly1 = -Infinity;
    let gx0 = Infinity;
    let gy0 = Infinity;
    let gx1 = -Infinity;
    let gy1 = -Infinity;
    const sw = parseFloat(cs.getPropertyValue("-webkit-text-stroke-width") || "") || 0;
    const pad = sw > 0 ? sw / 2 + 0.5 : 0;
    for (const n of nodes) {
      const boxes = inkReadMultiCache(n, key);
      if (!boxes) return null;
      const cache = nodeInkCache(n, el, cs);
      if (!cache || cache.lines.length !== boxes.length) return null;
      const emH = cache.fontAsc + cache.fontDesc;
      for (let j = 0; j < boxes.length; j++) {
        const b = boxes[j];
        const lm = cache.lines[j] as InkLineMetric;
        if (!(b[2] > 0) || !(b[3] > 0)) return null;
        lx0 = Math.min(lx0, b[0]);
        ly0 = Math.min(ly0, b[1]);
        lx1 = Math.max(lx1, b[0] + b[2]);
        ly1 = Math.max(ly1, b[1] + b[3]);
        const halfLead = (b[3] - emH) / 2;
        const topTrim = halfLead + (cache.fontAsc - lm.asc);
        const botTrim = halfLead + (cache.fontDesc - lm.desc);
        const lx = b[0] - lm.left - pad;
        const rx = b[0] + lm.right + pad;
        const ty = b[1] + topTrim - pad;
        const by = b[1] + b[3] - botTrim + pad;
        if (!(rx > lx) || !(by > ty)) return null;
        gx0 = Math.min(gx0, lx);
        gy0 = Math.min(gy0, ty);
        gx1 = Math.max(gx1, rx);
        gy1 = Math.max(gy1, by);
      }
    }
    if (!(lx1 > lx0) || !(ly1 > ly0) || !(gx1 > gx0) || !(gy1 > gy0)) return null;
    try {
      const itemCorners: Array<[number, number]> = [
        map(lx0, ly0),
        map(lx1, ly0),
        map(lx1, ly1),
        map(lx0, ly1),
      ];
      const itemComp = clientCornersToComp(itemCorners);
      if (!itemComp) return null;
      const itemCc: Array<[number, number]> = [
        [itemComp[0], itemComp[1]],
        [itemComp[2], itemComp[3]],
        [itemComp[4], itemComp[5]],
        [itemComp[6], itemComp[7]],
      ];
      if (!quadAabbMatchesBox(itemCc, itemBox)) return null;
      let inkComp: [number, number, number, number, number, number, number, number] | null = null;
      if (inkBox) {
        const inkCorners: Array<[number, number]> = [
          map(gx0, gy0),
          map(gx1, gy0),
          map(gx1, gy1),
          map(gx0, gy1),
        ];
        const comp = clientCornersToComp(inkCorners);
        if (comp) {
          const cc: Array<[number, number]> = [
            [comp[0], comp[1]],
            [comp[2], comp[3]],
            [comp[4], comp[5]],
            [comp[6], comp[7]],
          ];
          if (quadAabbMatchesBox(cc, inkBox)) inkComp = comp;
        }
      }
      return { item: itemComp, ink: inkComp };
    } catch {
      return null;
    }
  }


  function measure(): { items: CoordsInpageItem[]; ink: CoordsInpageInk[]; quads: CoordsInpageQuad[]; inkQuads: CoordsInpageQuad[] } {
    // MutationObserver is async (never fires inside the loop), so also watch the
    // synchronous node counter every frame. Same count means the same list.
    if (state.dirty || root.getElementsByTagName("*").length !== state.lastCount) discover();
    syncRoot();
    const out: CoordsInpageItem[] = [];
    const inkOut: CoordsInpageInk[] = [];
    const quadOut: CoordsInpageQuad[] = [];
    const inkQuadOut: CoordsInpageQuad[] = [];
    const items = state.items;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const el = it.el;
      if (!el.isConnected) continue;
      // Visibility: visibility chain + multiplied opacity
      let op = 1;
      let vis = true;
      let selfCs: CSSStyleDeclaration | null = null;
      const transforms: ChainTransform[] = [];
      let complex = window.scrollX !== 0 || window.scrollY !== 0;
      let node: Element | null = el;
      let first = true;
      while (node && node !== root) {
        const cs = getComputedStyle(node);
        if (first) {
          selfCs = cs;
          first = false;
        }
        if (cs.display === "none") {
          vis = false;
          break;
        }
        if (cs.visibility !== "visible") {
          vis = false;
          break;
        }
        op *= parseFloat(cs.opacity || "1");
        if (op <= 0) break;
        if (!isNoneTransform(cs)) {
          transforms.push({ node });
        }
        if (!complex && chainComplex(cs)) complex = true;
        if (!complex && node !== el) {
          const he = node as HTMLElement;
          if (he.scrollTop !== 0 || he.scrollLeft !== 0) complex = true;
        }
        node = node.parentElement;
      }
      if (!vis || op <= 0) continue;
      let x: number;
      let y: number;
      let w: number;
      let h: number;
      // Unrounded client box of the element itself (for the ink mapping paths).
      let clientX = 0;
      let clientY = 0;
      let clientW = 0;
      let clientH = 0;
      if (it.textBox) {
        const b = textBox(el);
        if (!b) continue;
        clientX = b[0];
        clientY = b[1];
        clientW = b[2];
        clientH = b[3];
        x = (b[0] - state.rootLeft) / state.scaleX;
        y = (b[1] - state.rootTop) / state.scaleY;
        w = b[2] / state.scaleX;
        h = b[3] / state.scaleY;
      } else {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        clientX = r.left;
        clientY = r.top;
        clientW = r.width;
        clientH = r.height;
        x = (r.left - state.rootLeft) / state.scaleX;
        y = (r.top - state.rootTop) / state.scaleY;
        w = r.width / state.scaleX;
        h = r.height / state.scaleY;
      }
      if (w <= 0 || h <= 0) continue;
      if (x + w <= 0 || y + h <= 0 || x >= compW || y >= compH) continue;
      const r1 = (v: number): number => Math.round(v * 10) / 10;
      out.push([
        i,
        r1(x),
        r1(y),
        r1(w),
        r1(h),
        Math.round(op * 1000) / 1000,
        it.zBase + it.order,
      ]);
      // Ink: best effort, never affects the item box above.
      if (selfCs) {
        try {
          const chain: ChainInfo = { transforms, complex, selfCs };
          const itemClient = { x: clientX, y: clientY, w: clientW, h: clientH };
          let box: [number, number, number, number] | null = null;
          // Text never had transformed ink, so any 2D chain composes through the
          // whole path; images and SVG keep the legacy paths bit for bit below
          // two levels (composeLocalToClient already covers zero and one).
          const multiText = chain.transforms.length > 0 && !chain.complex;
          const multi = chain.transforms.length > 1 && !chain.complex;
          if (it.textBox) box = multiText ? textInkMulti(el, selfCs, chain) : textInk(el, selfCs, chain);
          else if (it.kind === "image")
            box = multi ? imageInkMulti(el, selfCs, it) : imageInk(el, selfCs, chain, itemClient, it);
          else if (it.kind === "svg")
            box = multi ? svgInkMulti(el, selfCs) : svgInk(el, selfCs, chain, itemClient);
          if (box) {
            const [ix, iy, iw, ih] = box;
            if (
              Number.isFinite(ix) &&
              Number.isFinite(iy) &&
              iw > 0 &&
              ih > 0 &&
              ix < x + w &&
              x < ix + iw &&
              iy < y + h &&
              y < iy + ih
            ) {
              const qx = r1(ix);
              const qy = r1(iy);
              const qw = r1(iw);
              const qh = r1(ih);
              const bx = r1(x);
              const by = r1(y);
              const bw = r1(w);
              const bh = r1(h);
              if (
                Math.abs(qx - bx) > 0.5 ||
                Math.abs(qy - by) > 0.5 ||
                Math.abs(qx + qw - (bx + bw)) > 0.5 ||
                Math.abs(qy + qh - (by + bh)) > 0.5
              ) {
                inkOut.push([i, qx, qy, qw, qh]);
              }
            }
          }
        } catch {
          // ink failure must never drop the item
        }
      }
      // Quads: rotated corners for transformed elements; best effort like ink, never
      // affects the item or ink box above. Emitted only when the corners verify
      // against the measured box (±1.2 px per edge).
      if (selfCs) {
        try {
          const chain: ChainInfo = { transforms, complex, selfCs };
          if (chain.transforms.length > 0 && !chain.complex) {
            const itemClient = { x: clientX, y: clientY, w: clientW, h: clientH };
            const itemBox: [number, number, number, number] = [r1(x), r1(y), r1(w), r1(h)];
            const rq = (corners: [number, number, number, number, number, number, number, number]): CoordsInpageQuad => [
              i,
              r1(corners[0]),
              r1(corners[1]),
              r1(corners[2]),
              r1(corners[3]),
              r1(corners[4]),
              r1(corners[5]),
              r1(corners[6]),
              r1(corners[7]),
            ];
            if (it.textBox) {
              const lastInk = inkOut.length > 0 && inkOut[inkOut.length - 1][0] === i ? inkOut[inkOut.length - 1] : null;
              const tq = textQuadsMulti(
                el,
                selfCs,
                chain,
                itemBox,
                lastInk ? [lastInk[1], lastInk[2], lastInk[3], lastInk[4]] : null
              );
              if (tq) {
                quadOut.push(rq(tq.item));
                if (tq.ink && lastInk) inkQuadOut.push(rq(tq.ink));
              }
            } else {
              const itemQ = itemQuadForBox(el, selfCs, chain, itemClient, itemBox);
              if (itemQ) quadOut.push(rq(itemQ));
              const lastInk = inkOut.length > 0 && inkOut[inkOut.length - 1][0] === i ? inkOut[inkOut.length - 1] : null;
              if (lastInk) {
                const local =
                  it.kind === "image"
                    ? imageLocalInk(el, selfCs, it)
                    : it.kind === "svg"
                      ? svgLocalInk(el, selfCs)
                      : null;
                if (local) {
                  const inkQ = inkQuadForLocalRect(
                    el,
                    selfCs,
                    chain,
                    itemClient,
                    local,
                    [lastInk[1], lastInk[2], lastInk[3], lastInk[4]]
                  );
                  if (inkQ) inkQuadOut.push(rq(inkQ));
                }
              }
            }
          }
        } catch {
          // quad failure must never drop the item or the ink
        }
      }
    }
    return { items: out, ink: inkOut, quads: quadOut, inkQuads: inkQuadOut };
  }

  function seek(t: number): void {
    coordsSeek(t);
  }

  function setInkData(args: { margins: Record<string, CoordsInpageImageMargins> }): number {
    let n = 0;
    try {
      for (const url of Object.keys(args.margins || {})) {
        const m = args.margins[url];
        if (
          m &&
          Number.isFinite(m.left) &&
          Number.isFinite(m.top) &&
          Number.isFinite(m.right) &&
          Number.isFinite(m.bottom) &&
          Number.isFinite(m.width) &&
          m.width > 0 &&
          Number.isFinite(m.height) &&
          m.height > 0
        ) {
          state.inkByUrl.set(url, {
            left: m.left,
            top: m.top,
            right: m.right,
            bottom: m.bottom,
            width: m.width,
            height: m.height,
          });
          n++;
        }
      }
    } catch {
      // ignore malformed ink data
    }
    return n;
  }

  (window as unknown as Record<string, any>)["__cxcoords"] = {
    discover,
    measure,
    seek,
    setInkData,
    elements: () => publicElements(),
    count: () => state.items.length,
    seekErrors: () => {
      const out = seekErrors.slice();
      seekErrors.length = 0;
      return out;
    },
  };
  return discover();
}

export function coordsLoopRun(args: { frames: number[]; fps: number; rescan: boolean }): {
  frames: CoordsInpageFrame[];
  elements: CoordsInpageElement[];
  seekErrors: string[];
} {
  // `page.evaluate` serializes this function alone: no module references, the page
  // API installed above carries seek/measure/discover.
  const api = (window as unknown as Record<string, any>)["__cxcoords"] as {
    discover: () => CoordsInpageElement[];
    measure: () => { items: CoordsInpageItem[]; ink: CoordsInpageInk[]; quads: CoordsInpageQuad[]; inkQuads: CoordsInpageQuad[] };
    seek: (t: number) => void;
    elements: () => CoordsInpageElement[];
    seekErrors: () => string[];
  };
  const out: CoordsInpageFrame[] = [];
  for (const f of args.frames) {
    api.seek(f / args.fps);
    if (args.rescan) api.discover();
    const m = api.measure();
    const frame: CoordsInpageFrame = { f, items: m.items };
    if (m.ink.length > 0) frame.ink = m.ink;
    if (m.quads.length > 0) frame.quads = m.quads;
    if (m.inkQuads.length > 0) frame.inkQuads = m.inkQuads;
    out.push(frame);
  }
  return { frames: out, elements: api.elements(), seekErrors: api.seekErrors() };
}

export function coordsInpageSetInkData(args: {
  margins: Record<string, CoordsInpageImageMargins>;
}): number {
  // Serialized alone like `coordsLoopRun`: forwards to the installed page API.
  const api = (window as unknown as Record<string, any>)["__cxcoords"] as {
    setInkData: (a: { margins: Record<string, CoordsInpageImageMargins> }) => number;
  };
  return api.setInkData(args);
}
