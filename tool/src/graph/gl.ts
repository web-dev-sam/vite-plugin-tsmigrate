/**
 * WebGL2 scene for the radial graph: depth rings, import edges, the focus glow
 * and nodes — one draw call per layer. Node positions live in an RG32F
 * texture every layer fetches by node index, so a layout tick is one texture
 * upload and pan/zoom is a uniform change: no per-element CPU work, whatever
 * the edge count.
 *
 * Geometry is vertex-pulled, not instanced: each element's data sits in a
 * texture and `gl_VertexID / 6` selects it. Instanced draws hit a slow path
 * on ANGLE's D3D11 backend (measured ~9 µs per instance on Intel UHD 620 —
 * 10k quads 96 ms vs 1.3 ms pulled), which is the stack most Windows laptops
 * run Chrome on.
 *
 * All geometry is in layout ("user") units, like the SVG scene it replaced:
 * stroke widths and dash patterns scale with zoom. Sub-pixel strokes stay one
 * device pixel wide with coverage-scaled alpha, which is how the SVG
 * rasterizer rendered them too.
 */

/** Pan/zoom in CSS pixels: screen = user * k + (x, y). */
export interface View {
  k: number;
  x: number;
  y: number;
}

/** Floats per disc in `DiscData.geom`: radius, strokeWidth, glow (soft edge). */
export const DISC_GEOM = 3;
/** Bytes per disc in `DiscData.colors`: fill RGBA then stroke RGBA (straight alpha). */
export const DISC_COLORS = 8;

export interface DiscData {
  /** Node index per disc (centre fetched from the position texture). */
  index: Uint32Array;
  geom: Float32Array;
  colors: Uint8Array;
  count: number;
}

export interface EdgeData {
  /** Node-index pairs per edge: importer, imported. */
  ends: Uint32Array;
  /** Dash kind per edge: 0 solid, 1 type-only, 2 lazy. */
  dash: Uint8Array;
  count: number;
}

/** Texels per row of every data texture. */
const TEX_W = 1024;

const HEAD = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uPos;
uniform vec3 uView;   // k, tx, ty (CSS px)
uniform vec2 uSize;   // viewport (CSS px)
uniform float uPx;    // one device pixel, in user units
ivec2 texel(int i) { return ivec2(i % ${TEX_W}, i / ${TEX_W}); }
vec2 nodePos(int i) { return texelFetch(uPos, texel(i), 0).xy; }
vec4 toClip(vec2 p) {
  vec2 c = (p * uView.x + uView.yz) / uSize * 2.0 - 1.0;
  return vec4(c.x, -c.y, 0.0, 1.0);
}
`;

const DISC_VS = `${HEAD}
uniform highp sampler2D uGeom;  // per disc: node index, radius, stroke width, glow
uniform highp sampler2D uColor; // per disc: fill texel, stroke texel (RGBA8)
const vec2 CORNER[6] = vec2[6](vec2(-1, -1), vec2(1, -1), vec2(-1, 1), vec2(-1, 1), vec2(1, -1), vec2(1, 1));
out vec2 vLocal;
out vec3 vGeom;
out vec4 vFill;
out vec4 vStroke;
void main() {
  int e = gl_VertexID / 6;
  vec4 g = texelFetch(uGeom, texel(e), 0);
  float r = g.y;
  float ext = r + max(g.z * 0.5, uPx) + g.w + uPx * 1.5;
  vLocal = CORNER[gl_VertexID % 6] * ext;
  vGeom = g.yzw;
  vFill = texelFetch(uColor, texel(e * 2), 0);
  vStroke = texelFetch(uColor, texel(e * 2 + 1), 0);
  gl_Position = r > 0.0 ? toClip(nodePos(int(g.x)) + vLocal) : vec4(2.0, 2.0, 2.0, 1.0);
}
`;

/** Segments per depth ring; keeps the chord error sub-pixel up to max zoom. */
const RING_SEGMENTS = 512;

// Depth rings are huge, mostly-empty circles: a full disc quad per ring would
// shade the whole viewport ~maxHeight times. Instead each ring is a thin
// annulus band of RING_SEGMENTS quads hugging the stroke, shaded by DISC_FS.
const RING_VS = `${HEAD}
uniform highp sampler2D uGeom;  // per ring: -, radius, stroke width, -
uniform highp sampler2D uColor; // per ring: fill texel, stroke texel (RGBA8)
out vec2 vLocal;
out vec3 vGeom;
out vec4 vFill;
out vec4 vStroke;
void main() {
  int e = gl_VertexID / (6 * ${RING_SEGMENTS});
  int v = gl_VertexID % (6 * ${RING_SEGMENTS});
  int k = v % 6;
  float along = (k == 1 || k == 4 || k == 5) ? 1.0 : 0.0;
  bool outer = k == 2 || k == 3 || k == 5;
  vec4 g = texelFetch(uGeom, texel(e), 0);
  float r = g.y;
  float band = max(g.z * 0.5, uPx) + uPx * 1.5;
  float step_ = 6.28318530718 / float(${RING_SEGMENTS});
  float a = (float(v / 6) + along) * step_;
  // Outer vertices sit on the circumscribed polygon so chords never cut the stroke.
  float rad = outer ? (r + band) / cos(step_ * 0.5) : max(r - band, 0.0);
  vLocal = vec2(cos(a), sin(a)) * rad;
  vGeom = g.yzw;
  vFill = texelFetch(uColor, texel(e * 2), 0);
  vStroke = texelFetch(uColor, texel(e * 2 + 1), 0);
  gl_Position = toClip(vLocal);
}
`;

const DISC_FS = `#version 300 es
precision highp float;
uniform float uPx;
in vec2 vLocal;
in vec3 vGeom;
in vec4 vFill;
in vec4 vStroke;
out vec4 outColor;
void main() {
  float d = length(vLocal);
  float r = vGeom.x, sw = vGeom.y, soft = vGeom.z;
  float fillCov = soft > 0.0
    ? 1.0 - smoothstep(r - soft * 0.5, r + soft, d)
    : clamp((r - d) / uPx + 0.5, 0.0, 1.0);
  float hw = max(sw * 0.5, uPx * 0.5);
  float strokeCov = sw > 0.0
    ? clamp((hw - abs(d - r)) / uPx + 0.5, 0.0, 1.0) * min(1.0, sw / uPx)
    : 0.0;
  vec4 f = vec4(vFill.rgb, 1.0) * vFill.a * fillCov;
  vec4 s = vec4(vStroke.rgb, 1.0) * vStroke.a * strokeCov;
  outColor = s + f * (1.0 - s.a);
  if (outColor.a <= 0.0) discard;
}
`;

const EDGE_VS = `${HEAD}
uniform highp sampler2D uEdge;   // per edge: (src, dst, dash, -)
uniform highp usampler2D uHover; // per edge: 1 = incident to the hovered node
uniform bool uHovering; // a node is hovered: incident edges highlight, the rest dim
uniform bool uAllHl;    // "highlight links": every edge in the hover colour
// x: 0 at the importer, 1 at the imported; y: side of the centre line.
const vec2 CORNER[6] = vec2[6](vec2(0, -1), vec2(1, -1), vec2(0, 1), vec2(0, 1), vec2(1, -1), vec2(1, 1));
const vec3 BASE = vec3(0.188, 0.212, 0.239); // #30363d
const vec3 HL = vec3(0.345, 0.651, 1.0);     // #58a6ff
const float WIDTH = 0.6;       // stroke width, user units
const float OPACITY = 0.1;     // muted edge
const float HL_OPACITY = 0.35; // highlighted edge
out float vAlong;
out float vSide;
out float vHalf;
out float vCov;
out vec4 vColor;
flat out int vDash;
void main() {
  int e = gl_VertexID / 6;
  vec2 corner = CORNER[gl_VertexID % 6];
  vec4 e0 = texelFetch(uEdge, texel(e), 0);
  bool incident = texelFetch(uHover, texel(e), 0).r == 1u;
  vec2 a = nodePos(int(e0.x));
  vec2 b = nodePos(int(e0.y));
  vec2 d = b - a;
  float len = length(d);
  vec2 dir = len > 0.0 ? d / len : vec2(1.0, 0.0);
  float half_ = max(WIDTH * 0.5, uPx * 0.5);
  vAlong = corner.x * len;
  // Quad hugs the stroke plus its half-pixel coverage ramp — edges are
  // fill-rate bound, so every extra pixel of width costs.
  vSide = corner.y * (half_ + uPx * 0.5);
  vHalf = half_;
  vCov = min(1.0, WIDTH / uPx);
  vDash = int(e0.z);
  bool hl = uHovering ? incident : uAllHl;
  float op = uHovering && !incident ? 0.04 : (hl ? HL_OPACITY : OPACITY);
  vColor = vec4(hl ? HL : BASE, op);
  gl_Position = toClip(mix(a, b, corner.x) + vec2(-dir.y, dir.x) * vSide);
}
`;

const EDGE_FS = `#version 300 es
precision highp float;
uniform float uPx;
in float vAlong;
in float vSide;
in float vHalf;
in float vCov;
in vec4 vColor;
flat in int vDash;
out vec4 outColor;
void main() {
  float cov = clamp((vHalf - abs(vSide)) / uPx + 0.5, 0.0, 1.0) * vCov;
  if (vDash != 0) {
    // stroke-dasharray: type-only "4 3", lazy "1.5 3" (user units).
    float on = vDash == 1 ? 4.0 : 1.5;
    float period = on + 3.0;
    // Sub-pixel patterns would alias into noise: average them instead.
    if (period < uPx * 3.0) cov *= on / period;
    else if (mod(vAlong, period) >= on) discard;
  }
  outColor = vec4(vColor.rgb, 1.0) * vColor.a * cov;
  if (outColor.a <= 0.0) discard;
}
`;

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const program = gl.createProgram();
  for (const [type, src] of [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs],
  ] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`shader: ${gl.getShaderInfoLog(shader)}`);
    }
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`program: ${gl.getProgramInfoLog(program)}`);
  }
  return program;
}

type Uniforms = Record<string, WebGLUniformLocation | null>;

/** A texture-backed layer: its two data textures and element count. */
interface Layer {
  data: WebGLTexture;
  aux: WebGLTexture;
  count: number;
}

/** Texture formats per channel layout: [internalFormat, format, type]. */
type Format = readonly [number, number, number];

// Composites the cached scene: a full-screen triangle resampling the cache.
// Pan is scale 1 at an integer offset — a 1:1 texel copy, still crisp — and
// an in-progress zoom gesture scales it until the next crisp re-raster.
const BLIT_VS = `#version 300 es
void main() {
  gl_Position = vec4(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0, 0.0, 1.0);
}
`;

const BLIT_FS = `#version 300 es
precision highp float;
uniform highp sampler2D uCache;
uniform float uScale;  // cache device px per screen device px
uniform vec2 uOffset;  // cache device px at the screen origin (GL, bottom-up)
out vec4 outColor;
void main() {
  vec2 size = vec2(textureSize(uCache, 0));
  vec2 p = gl_FragCoord.xy * uScale + uOffset;
  bool inside = all(greaterThanEqual(p, vec2(0.0))) && all(lessThan(p, size));
  outColor = inside ? texture(uCache, p / size) : vec4(0.0);
}
`;

/** Cached margin around the viewport, as a share of its size per side. */
const CACHE_MARGIN = 0.25;

export class Scene {
  private readonly gl: WebGL2RenderingContext;
  private readonly disc: WebGLProgram;
  private readonly ring: WebGLProgram;
  private readonly edge: WebGLProgram;
  private readonly blit: WebGLProgram;
  private readonly discU: Uniforms;
  private readonly ringU: Uniforms;
  private readonly edgeU: Uniforms;
  private readonly blitU: Uniforms;
  // The scene is rasterized into this framebuffer (viewport plus margins) and
  // blitted; pan within the margins is a blit, and only a zoom-scale change,
  // new data or a margin overrun re-rasterizes. `cached` is the view it was
  // drawn at (null = stale).
  private readonly cacheTex: WebGLTexture;
  private readonly cacheFbo: WebGLFramebuffer;
  private cached: View | null = null;
  private marginX = 0;
  private marginY = 0;
  private readonly vao: WebGLVertexArrayObject;
  private readonly posTex: WebGLTexture;
  private posStage = new Float32Array(0);
  private readonly rings: Layer;
  private readonly glow: Layer;
  private readonly nodes: Layer;
  private readonly edges: Layer;
  private readonly rgba32f: Format;
  private readonly rgba8: Format;
  private readonly r8ui: Format;
  private hovering = false;
  private allHl = false;
  private width = 1;
  private height = 1;
  private dpr = 1;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: true });
    if (!gl) throw new Error("WebGL2 is unavailable in this browser");
    this.gl = gl;
    this.rgba32f = [gl.RGBA32F, gl.RGBA, gl.FLOAT];
    this.rgba8 = [gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE];
    this.r8ui = [gl.R8UI, gl.RED_INTEGER, gl.UNSIGNED_BYTE];
    this.disc = compile(gl, DISC_VS, DISC_FS);
    this.ring = compile(gl, RING_VS, DISC_FS);
    this.edge = compile(gl, EDGE_VS, EDGE_FS);
    this.blit = compile(gl, BLIT_VS, BLIT_FS);
    const uniforms = (p: WebGLProgram, names: string[]): Uniforms =>
      Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(p, n)]));
    const common = ["uPos", "uView", "uSize", "uPx"];
    this.discU = uniforms(this.disc, [...common, "uGeom", "uColor"]);
    this.ringU = uniforms(this.ring, [...common, "uGeom", "uColor"]);
    this.edgeU = uniforms(this.edge, [...common, "uEdge", "uHover", "uHovering", "uAllHl"]);
    this.blitU = uniforms(this.blit, ["uCache", "uScale", "uOffset"]);
    // Linear: exact at scale 1 (texel-centre samples), smooth while zooming.
    this.cacheTex = this.texture();
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.cacheFbo = gl.createFramebuffer();
    // Attribute-less draws still need a bound vertex array object.
    this.vao = gl.createVertexArray();
    this.posTex = this.texture();
    const layer = (): Layer => ({ data: this.texture(), aux: this.texture(), count: 0 });
    this.rings = layer();
    this.glow = layer();
    this.nodes = layer();
    this.edges = layer();
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  private texture(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return tex;
  }

  /** Upload `data` (`channels` per texel) as whole TEX_W-wide rows. */
  private upload(
    tex: WebGLTexture,
    format: Format,
    channels: number,
    data: Float32Array | Uint8Array,
  ): void {
    const gl = this.gl;
    const rows = Math.max(1, Math.ceil(data.length / channels / TEX_W));
    const size = rows * TEX_W * channels;
    let padded = data;
    if (data.length !== size) {
      padded = data instanceof Float32Array ? new Float32Array(size) : new Uint8Array(size);
      padded.set(data);
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, format[0], TEX_W, rows, 0, format[1], format[2], padded);
  }

  private setDiscs(layer: Layer, d: DiscData): void {
    const geom = new Float32Array(d.count * 4);
    for (let i = 0; i < d.count; i++) {
      geom[i * 4] = d.index[i]!;
      geom[i * 4 + 1] = d.geom[i * DISC_GEOM]!;
      geom[i * 4 + 2] = d.geom[i * DISC_GEOM + 1]!;
      geom[i * 4 + 3] = d.geom[i * DISC_GEOM + 2]!;
    }
    this.upload(layer.data, this.rgba32f, 4, geom);
    this.upload(layer.aux, this.rgba8, 4, d.colors.subarray(0, d.count * DISC_COLORS));
    layer.count = d.count;
    this.cached = null;
  }

  /** Match the drawing buffer (and the scene cache) to the canvas' CSS size at device resolution. */
  resize(width: number, height: number, dpr: number): void {
    const gl = this.gl;
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.dpr = dpr;
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    const max = (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) / dpr;
    const margin = (size: number) =>
      Math.max(0, Math.min(Math.round(size * CACHE_MARGIN), Math.floor((max - size) / 2)));
    this.marginX = margin(this.width);
    this.marginY = margin(this.height);
    gl.bindTexture(gl.TEXTURE_2D, this.cacheTex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      Math.round((this.width + 2 * this.marginX) * dpr),
      Math.round((this.height + 2 * this.marginY) * dpr),
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.cacheFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.cacheTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.cached = null;
  }

  /** Node positions, x/y interleaved in node-index order. */
  setPositions(pos: Float32Array): void {
    const gl = this.gl;
    const rows = Math.max(1, Math.ceil(pos.length / 2 / TEX_W));
    const size = rows * TEX_W * 2;
    gl.bindTexture(gl.TEXTURE_2D, this.posTex);
    if (this.posStage.length !== size) {
      this.posStage = new Float32Array(size);
      this.posStage.set(pos);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, TEX_W, rows, 0, gl.RG, gl.FLOAT, this.posStage);
    } else {
      this.posStage.set(pos);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TEX_W, rows, gl.RG, gl.FLOAT, this.posStage);
    }
    this.cached = null;
  }

  setRings(data: DiscData): void {
    this.setDiscs(this.rings, data);
  }

  /** Soft discs drawn between the edges and the nodes (the focus glow). */
  setGlow(data: DiscData): void {
    this.setDiscs(this.glow, data);
  }

  setNodes(data: DiscData): void {
    this.setDiscs(this.nodes, data);
  }

  /** Uploads edge endpoints and dashes; the caller follows with `setEdgeHover`. */
  setEdges(data: EdgeData): void {
    const packed = new Float32Array(data.count * 4);
    for (let k = 0; k < data.count; k++) {
      packed[k * 4] = data.ends[k * 2]!;
      packed[k * 4 + 1] = data.ends[k * 2 + 1]!;
      packed[k * 4 + 2] = data.dash[k]!;
    }
    this.upload(this.edges.data, this.rgba32f, 4, packed);
    this.edges.count = data.count;
    this.cached = null;
  }

  /** Per edge: 1 when incident to the hovered node. */
  setEdgeHover(hover: Uint8Array): void {
    this.upload(this.edges.aux, this.r8ui, 1, hover);
    this.cached = null;
  }

  setEdgeMode(hovering: boolean, allHighlighted: boolean): void {
    this.hovering = hovering;
    this.allHl = allHighlighted;
    this.cached = null;
  }

  /**
   * Show the scene at `view`. Pan within the cached margins is a texel copy.
   * A zoom-scale change re-rasterizes — unless `allowScaled` (an active zoom
   * gesture) and the viewport still maps inside the cache: then the cache is
   * resampled and this returns false, asking for a crisp render later.
   */
  render(view: View, allowScaled = false): boolean {
    const gl = this.gl;
    const { dpr } = this;
    const mx = this.marginX;
    const my = this.marginY;
    const cw = Math.round((this.width + 2 * mx) * dpr);
    const ch = Math.round((this.height + 2 * my) * dpr);
    const sw = this.canvas.width;
    const sh = this.canvas.height;
    // Cache device px (GL, bottom-up) = screen device px * scale + offset;
    // derived from both views mapping the same user point.
    const placement = (c: View): [number, number, number] => {
      const r = c.k / view.k;
      return [r, (c.x + mx - view.x * r) * dpr, ch - sh * r + (view.y * r - c.y - my) * dpr];
    };
    let crisp = true;
    let place: [number, number, number] | null = null;
    const c = this.cached;
    if (c && c.k === view.k) {
      if (Math.abs(view.x - c.x) <= mx && Math.abs(view.y - c.y) <= my) place = placement(c);
    } else if (c && allowScaled) {
      const p = placement(c);
      const inside = (v: number, max: number) => v >= 0 && v <= max;
      if (
        inside(p[1], cw) &&
        inside(p[2], ch) &&
        inside(sw * p[0] + p[1], cw) &&
        inside(sh * p[0] + p[2], ch)
      ) {
        place = p;
        crisp = false;
      }
    }
    if (!place) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.cacheFbo);
      gl.viewport(0, 0, cw, ch);
      this.rasterize(
        { k: view.k, x: view.x + mx, y: view.y + my },
        this.width + 2 * mx,
        this.height + 2 * my,
      );
      this.cached = { k: view.k, x: view.x, y: view.y };
      place = placement(this.cached);
    }
    // A pure pan lands on whole texels so the copy stays pixel-exact.
    if (crisp) place = [1, Math.round(place[1]), Math.round(place[2])];
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, sw, sh);
    gl.disable(gl.BLEND);
    gl.useProgram(this.blit);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.cacheTex);
    gl.uniform1i(this.blitU.uCache!, 0);
    gl.uniform1f(this.blitU.uScale!, place[0]);
    gl.uniform2f(this.blitU.uOffset!, place[1], place[2]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.BLEND);
    gl.bindVertexArray(null);
    return crisp;
  }

  /** Draw every layer into the bound framebuffer, `width`×`height` CSS px at `view`. */
  private rasterize(view: View, width: number, height: number): void {
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.posTex);
    const px = 1 / (view.k * this.dpr);
    const common = (u: Uniforms) => {
      gl.uniform1i(u.uPos!, 0);
      gl.uniform3f(u.uView!, view.k, view.x, view.y);
      gl.uniform2f(u.uSize!, width, height);
      gl.uniform1f(u.uPx!, px);
    };
    const draw = (layer: Layer, verticesPer: number) => {
      if (!layer.count) return;
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, layer.data);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, layer.aux);
      gl.drawArrays(gl.TRIANGLES, 0, layer.count * verticesPer);
    };

    gl.useProgram(this.ring);
    common(this.ringU);
    gl.uniform1i(this.ringU.uGeom!, 1);
    gl.uniform1i(this.ringU.uColor!, 2);
    draw(this.rings, 6 * RING_SEGMENTS);

    gl.useProgram(this.edge);
    common(this.edgeU);
    gl.uniform1i(this.edgeU.uEdge!, 1);
    gl.uniform1i(this.edgeU.uHover!, 2);
    gl.uniform1i(this.edgeU.uHovering!, this.hovering ? 1 : 0);
    gl.uniform1i(this.edgeU.uAllHl!, this.allHl ? 1 : 0);
    draw(this.edges, 6);

    gl.useProgram(this.disc);
    common(this.discU);
    gl.uniform1i(this.discU.uGeom!, 1);
    gl.uniform1i(this.discU.uColor!, 2);
    draw(this.glow, 6);
    draw(this.nodes, 6);
    gl.bindVertexArray(null);
  }

  destroy(): void {
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
