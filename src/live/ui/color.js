/* Graded preview: draws the visible <video> through a WebGL2 canvas that samples
   the item's 3D LUT with tetrahedral interpolation (the render uses tetrahedral
   `lut3d`; hardware trilinear differs). Items without a stage keep today's path
   (no canvas cost). LUTs come from /api/color/lut, cached by stage hash. */
import { decodeLut, tetrahedralGrade } from "./scopes.js";

const VERT = `#version 300 es
in vec2 p;out vec2 v;void main(){v=vec2(p.x,-p.y)*.5+.5;gl_Position=vec4(p,0.,1.);}`;
const FRAG = `#version 300 es
precision highp float;precision highp int;
in vec2 v;out vec4 o;
uniform sampler2D frame;uniform highp sampler2D lut;uniform float size;uniform float bypass;
vec3 lutFetch(float rr,float gg,float bb){
  float idx=((bb*size+gg)*size+rr)*3.;
  vec3 o;
  for(int k=0;k<3;k++){int lin=int(idx+float(k));o[k]=texelFetch(lut,ivec2(lin%64,lin/64),0).r;}
  return o;}
vec3 tetra(vec3 c){
  float s=size-1.;vec3 q=clamp(c,0.,1.)*s;vec3 i0=floor(q);vec3 f=q-i0;
  vec3 lo=min(i0,s-1.);float r=lo.x,g=lo.y,b=lo.z;
  vec3 c000=lutFetch(r,g,b),c111=lutFetch(r+1.,g+1.,b+1.);
  vec3 c1,c2;float t1,t2,t3;
  if(f.x>f.y){if(f.y>f.z){c1=lutFetch(r+1.,g,b);c2=lutFetch(r+1.,g+1.,b);t1=f.x;t2=f.y;t3=f.z;}
    else if(f.x>f.z){c1=lutFetch(r+1.,g,b);c2=lutFetch(r+1.,g,b+1.);t1=f.x;t2=f.z;t3=f.y;}
    else{c1=lutFetch(r,g,b+1.);c2=lutFetch(r+1.,g,b+1.);t1=f.z;t2=f.x;t3=f.y;}}
  else{if(f.z>f.y){c1=lutFetch(r,g,b+1.);c2=lutFetch(r,g+1.,b+1.);t1=f.z;t2=f.y;t3=f.x;}
    else if(f.z>f.x){c1=lutFetch(r,g+1.,b);c2=lutFetch(r,g+1.,b+1.);t1=f.y;t2=f.z;t3=f.x;}
    else{c1=lutFetch(r,g+1.,b);c2=lutFetch(r+1.,g+1.,b);t1=f.y;t2=f.x;t3=f.z;}}
  return (1.-t1)*c000+(t1-t2)*c1+(t2-t3)*c2+t3*c111;}
void main(){vec3 c=texture(frame,v).rgb;vec3 g=tetra(c);o=vec4(mix(c,g,1.-bypass),1.);}`;

function makeGl(canvas) {
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: false, preserveDrawingBuffer: true });
  if (!gl) return null;
  const sh = (t, s) => {
    const h = gl.createShader(t);
    gl.shaderSource(h, s);
    gl.compileShader(h);
    if (!gl.getShaderParameter(h, gl.COMPILE_STATUS)) console.error("[color] shader", gl.getShaderInfoLog(h));
    return h;
  };
  const pr = gl.createProgram();
  gl.attachShader(pr, sh(gl.VERTEX_SHADER, VERT));
  gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) {
    console.error("[color] program", gl.getProgramInfoLog(pr));
    return null;
  }
  gl.useProgram(pr);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(pr, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  return { gl, pr };
}

function uploadLut(gl, pr, lut) {
  // Packed into a 64-wide float texture: texel (i%64, i/64) holds one channel.
  const n = lut.data.length;
  const w = 64, h = Math.ceil(n / w);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  const pad = new Float32Array(w * h);
  // texelFetch reads raw texel rows (no flip), matching the packed row-major order.
  pad.set(lut.data);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, w, h, 0, gl.RED, gl.FLOAT, pad);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.uniform1i(gl.getUniformLocation(pr, "lut"), 1);
  gl.uniform1f(gl.getUniformLocation(pr, "size"), lut.size);
  return tex;
}

/** CPU fallback used by readPixels dumps and when WebGL2 is missing. */
export function gradePixelsCpu(pixels, lut) {
  const out = new Float32Array(pixels.length);
  const p = [0, 0, 0];
  for (let i = 0; i < pixels.length; i += 3) {
    p[0] = pixels[i] / 255; p[1] = pixels[i + 1] / 255; p[2] = pixels[i + 2] / 255;
    tetrahedralGrade(lut, p);
    out[i] = p[0] * 255; out[i + 1] = p[1] * 255; out[i + 2] = p[2] * 255;
  }
  return out;
}

export function decodeLutPayload(json) {
  return decodeLut(json);
}

/** Grade manager owned by the preview region. */
export function createGrader(ctx) {
  const cache = new Map(); // hash -> {size, data:Float32Array}
  const state = {
    item: null, hash: null, lut: null, bypass: false, canvas: null, gl: null,
    lutTex: null, frameTex: null, video: null, raf: 0, fps: { n: 0, t0: 0, value: 0 },
  };

  async function fetchLut(item) {
    const r = await ctx.api.get(`/api/color/lut?item=${encodeURIComponent(item)}`);
    if (!r || !r.ok) return null;
    cache.set(r.hash, { size: r.size, data: decodeLut(r) });
    return r;
  }

  function ensureCanvas(video) {
    if (state.canvas) return true;
    const canvas = document.createElement("canvas");
    canvas.className = "pv-grade";
    // Above BOTH video slots: the preview alternates two <video> elements, and a canvas placed after the
    // first one is painted under the second whenever the second slot is the visible one.
    const slots = video.parentElement ? [...video.parentElement.querySelectorAll(".pv-video")] : [video];
    (slots[slots.length - 1] ?? video).insertAdjacentElement("afterend", canvas);
    const g = makeGl(canvas);
    if (!g) { canvas.remove(); return false; }
    state.canvas = canvas;
    state.gl = g.gl;
    state.glPr = g.pr;
    const { gl, pr } = g;
    state.frameTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, state.frameTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.uniform1i(gl.getUniformLocation(pr, "frame"), 0);
    state.lutTex = null;
    return true;
  }

  function drawFrame() {
    const { gl, pr } = state.glPr ? { gl: state.gl, pr: state.glPr } : {};
    const v = state.video;
    if (!gl || !v) return;
    // The canvas sits above both video slots: it must only show while its own slot is the visible one,
    // otherwise it keeps painting the other slot's (preloaded) clip over the real one.
    const visible = v.style.visibility !== "hidden" && v.readyState >= 2 && v.videoWidth > 0;
    state.canvas.style.visibility = visible ? "visible" : "hidden";
    if (!visible) return;
    if (state.canvas.width !== v.videoWidth || state.canvas.height !== v.videoHeight) {
      state.canvas.width = v.videoWidth; state.canvas.height = v.videoHeight;
      gl.viewport(0, 0, v.videoWidth, v.videoHeight);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, state.frameTex);
    try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v); }
    catch { return; }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, state.lutTex);
    gl.uniform1f(gl.getUniformLocation(pr, "bypass"), state.bypass ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    const f = state.fps;
    f.n++;
    const now = performance.now();
    if (now - f.t0 > 1000) { f.value = Math.round((f.n * 1000) / Math.max(1, now - f.t0)); f.n = 0; f.t0 = now; }
  }

  function loop() {
    cancelAnimationFrame(state.raf);
    const tick = () => { drawFrame(); state.raf = requestAnimationFrame(tick); };
    state.raf = requestAnimationFrame(tick);
  }

  function stop() {
    cancelAnimationFrame(state.raf);
    state.raf = 0;
    if (state.canvas) { state.canvas.remove(); state.canvas = null; state.gl = null; state.glPr = null; }
    state.video = null; state.lut = null; state.item = null; state.hash = null;
  }

  /** Point the grader at a video element + colour item. No-ops (video untouched, no canvas) for identity. */
  async function attach(video, itemId, stageHash) {
    if (!itemId) { stop(); return { graded: false }; }
    let lut = cache.get(stageHash ?? "");
    if (!lut) {
      const r = await fetchLut(itemId);
      if (!r) return { graded: false };
      state.hash = r.hash;
      if (r.identity) { stop(); return { graded: false, identity: true }; }
      lut = cache.get(r.hash);
    }
    state.item = itemId; state.lut = lut;
    state.video = video;
    if (!ensureCanvas(video)) return { graded: false, cpu: true, lut };
    const { gl, pr } = { gl: state.gl, pr: state.glPr };
    if (state.lutTex) gl.deleteTexture(state.lutTex);
    state.lutTex = uploadLut(gl, pr, lut);
    loop();
    return { graded: true };
  }

  /** Draw once and synchronously read back downsampled RGB (same-task, buffer valid). */
  function capture(maxW = 64) {
    const { gl, pr } = state.glPr ? { gl: state.gl, pr: state.glPr } : {};
    const v = state.video;
    if (!gl || !v || v.readyState < 2 || !state.lut) return null;
    drawFrame();
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const dw = Math.min(maxW, w), dh = Math.max(1, Math.round((h * dw) / w));
    const out = [];
    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        const sx = Math.min(w - 1, Math.floor((x / dw) * w));
        const sy = Math.min(h - 1, Math.floor((y / dh) * h));
        const o = ((h - 1 - sy) * w + sx) * 4;
        out.push(px[o], px[o + 1], px[o + 2]);
      }
    }
    return { w: dw, h: dh, data: out, bypass: state.bypass };
  }

  /** Hot-swap the LUT during a slider drag (unsaved stage, no journal write). */
  async function previewStage(itemId, stage) {
    const r = await ctx.api.post("/api/color/preview", { item: itemId, stage });
    if (!r || !r.ok) return null;
    const lut = { size: r.size, data: decodeLut(r) };
    cache.set(r.hash, lut);
    state.lut = lut; state.hash = r.hash;
    if (state.gl && state.glPr && state.lutTex) {
      const { gl, pr } = { gl: state.gl, pr: state.glPr };
      gl.deleteTexture(state.lutTex);
      state.lutTex = uploadLut(gl, pr, lut);
    }
    return r;
  }

  return { state, cache, attach, stop, previewStage, drawFrame, capture, gradePixelsCpu };
}
