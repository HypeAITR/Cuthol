// Small FFmpeg filter builders: atempo chains, path escaping, envelope expressions, sub-pixel scale/pan, seekable inputs (split out of compiler.ts).
import { ParameterEnvelope } from "../core/schema.js";

export function buildAtempoChain(rate: number): string[] {
  const filters: string[] = [];
  let r = Math.max(0.1, Math.min(16.0, rate));
  while (r > 2.0) {
    filters.push("atempo=2.0");
    r /= 2.0;
  }
  while (r < 0.5) {
    filters.push("atempo=0.5");
    r /= 0.5;
  }
  if (Math.abs(r - 1.0) > 0.001) {
    filters.push(`atempo=${r.toFixed(4)}`);
  }
  return filters;
}

export function escapeFfmpegFilterPath(relPath: string): string {
  return relPath
    .replace(/\\/g, "/")
    .replace(/([:\\',;[\]])/g, "\\$1");
}

/**
 * Compiles a `ParameterEnvelope` into a deterministic piecewise FFmpeg expression
 * evaluated over `t` (in seconds), supporting `linear`, `ease_in`, `ease_out`, and `ease_in_out`.
 */
export function compileEnvelopeToFfmpegExpr(options: {
  envelope: ParameterEnvelope | undefined;
  timeBaseOffsetMs: number;
  mode: "pixel_offset" | "db_to_linear" | "raw";
  baseCenterPx?: number;
  canvasDimPx?: number;
  baseGainDb?: number;
}): string | null {
  const env = options.envelope;
  if (!env || env.points.length === 0) return null;

  const mapVal = (v: number): number => {
    if (options.mode === "db_to_linear") {
      const totalDb = (options.baseGainDb ?? 0) + v;
      return Number(Math.pow(10, totalDb / 20).toFixed(4));
    }
    if (options.mode === "raw") {
      return Number(v.toFixed(4));
    }
    const center = options.baseCenterPx ?? 0;
    const dim = options.canvasDimPx ?? 1000;
    return Number((center + (v / 100) * dim).toFixed(4));
  };

  const pts = env.points.map((p) => ({
    tSec: Number(((options.timeBaseOffsetMs + p.offset_ms) / 1000).toFixed(3)),
    val: mapVal(p.value),
    dbVal: Number(((options.baseGainDb ?? 0) + p.value).toFixed(4)),
    easing: p.easing,
  }));

  if (pts.length === 1) {
    return String(pts[0].val);
  }

  // Build nested `if(lt(t, t1), easedLerp, ...)` from right to left (easing + dB-space interpolation)
  let expr = String(pts[pts.length - 1].val);
  for (let i = pts.length - 2; i >= 0; i--) {
    const a = pts[i];
    const b = pts[i + 1];
    const dt = Math.max(0.001, Number((b.tSec - a.tSec).toFixed(3)));
    const dv = Number((b.val - a.val).toFixed(4));
    const uExpr = `((t-${a.tSec})/${dt})`;

    let easedU = uExpr;
    if (b.easing === "ease_in") {
      easedU = `pow(${uExpr},2)`;
    } else if (b.easing === "ease_out") {
      easedU = `(1-pow(1-${uExpr},2))`;
    } else if (b.easing === "ease_in_out") {
      easedU = `(pow(${uExpr},2)*(3-2*${uExpr}))`;
    }

    let segExpr: string;
    if (options.mode === "db_to_linear") {
      const dDb = Number((b.dbVal - a.dbVal).toFixed(4));
      segExpr =
        Math.abs(dDb) < 1e-4
          ? String(a.val)
          : `pow(10,(${a.dbVal}+(${dDb})*${easedU})/20)`;
    } else {
      segExpr =
        Math.abs(dv) < 1e-4
          ? String(a.val)
          : `${a.val}+(${dv})*${easedU}`;
    }
    expr = `if(lt(t,${b.tSec}),${segExpr},${expr})`;
  }
  expr = `if(lt(t,${pts[0].tSec}),${pts[0].val},${expr})`;
  return expr;
}

export function buildSubpixelScaleOrPanFilters(options: {
  hasDynamicScale: boolean;
  sxPart: string;
  syPart: string;
  xEnv: ParameterEnvelope | undefined;
  yEnv: ParameterEnvelope | undefined;
  staticXPct: number;
  staticYPct: number;
  baseCenterX: number;
  baseCenterY: number;
  renderWidth: number;
  renderHeight: number;
  localTimeExpr: string;
}): string[] {
  if (options.hasDynamicScale) {
    const sxP = options.sxPart.replace(/\bt\b/g, options.localTimeExpr);
    const syP = options.syPart.replace(/\bt\b/g, options.localTimeExpr);
    const xLocalRaw = compileEnvelopeToFfmpegExpr({
      envelope: options.xEnv,
      timeBaseOffsetMs: 0,
      mode: "pixel_offset",
      baseCenterPx: 0,
      canvasDimPx: options.renderWidth,
    });
    const yLocalRaw = compileEnvelopeToFfmpegExpr({
      envelope: options.yEnv,
      timeBaseOffsetMs: 0,
      mode: "pixel_offset",
      baseCenterPx: 0,
      canvasDimPx: options.renderHeight,
    });
    const dxP = xLocalRaw
      ? xLocalRaw.replace(/\bt\b/g, options.localTimeExpr)
      : String(Number(((options.staticXPct / 100) * options.renderWidth).toFixed(4)));
    const dyP = yLocalRaw
      ? yLocalRaw.replace(/\bt\b/g, options.localTimeExpr)
      : String(Number(((options.staticYPct / 100) * options.renderHeight).toFixed(4)));

    const x0 = `(W*(1-(${sxP}))/2)+(${dxP})`;
    const x1 = `(W*(1+(${sxP}))/2)+(${dxP})`;
    const y0 = `(H*(1-(${syP}))/2)+(${dyP})`;
    const y2 = `(H*(1+(${syP}))/2)+(${dyP})`;
    return [
      `pad=w=iw+4:h=ih+4:x=2:y=2:color=black@0`,
      `perspective=x0='${x0}':y0='${y0}':x1='${x1}':y1='${y0}':x2='${x0}':y2='${y2}':x3='${x1}':y3='${y2}':sense=destination:interpolation=linear:eval=frame`,
      `crop=w=iw-4:h=ih-4:x=2:y=2`,
    ];
  }

  if (options.xEnv || options.yEnv) {
    const xLocalRaw = compileEnvelopeToFfmpegExpr({
      envelope: options.xEnv,
      timeBaseOffsetMs: 0,
      mode: "pixel_offset",
      baseCenterPx: options.baseCenterX,
      canvasDimPx: options.renderWidth,
    });
    const yLocalRaw = compileEnvelopeToFfmpegExpr({
      envelope: options.yEnv,
      timeBaseOffsetMs: 0,
      mode: "pixel_offset",
      baseCenterPx: options.baseCenterY,
      canvasDimPx: options.renderHeight,
    });
    const xLocalP = xLocalRaw ? xLocalRaw.replace(/\bt\b/g, options.localTimeExpr) : null;
    const yLocalP = yLocalRaw ? yLocalRaw.replace(/\bt\b/g, options.localTimeExpr) : null;
    const subDx = xLocalP ? `((${xLocalP})-trunc(${xLocalP}))` : "0";
    const subDy = yLocalP ? `((${yLocalP})-trunc(${yLocalP}))` : "0";
    return [
      `pad=w=iw+4:h=ih+4:x=2:y=2:color=black@0`,
      `perspective=x0='${subDx}':y0='${subDy}':x1='W+(${subDx})':y1='${subDy}':x2='${subDx}':y2='H+(${subDy})':x3='W+(${subDx})':y3='H+(${subDy})':sense=destination:interpolation=linear:eval=frame`,
      `crop=w=iw-4:h=ih-4:x=2:y=2`,
    ];
  }

  return [];
}

export function buildSeekableMediaInput(
  absAssetPath: string,
  srcInMs: number,
  srcOutMs: number,
  assetDurationMs: number,
  allowFastInputSeek = true
): {
  inputArgs: string[];
  localSrcInSec: string;
  localSrcOutSec: string;
  seekSec: number;
} {
  if (allowFastInputSeek && srcInMs >= 3000) {
    const seekSec = Math.max(0, Math.floor((srcInMs - 2000) / 1000));
    const readSpanSec = Math.max(1, Math.ceil(srcOutMs / 1000 - seekSec + 3));
    return {
      inputArgs: ["-ss", String(seekSec), "-t", String(readSpanSec), "-i", absAssetPath],
      localSrcInSec: (srcInMs / 1000 - seekSec).toFixed(3),
      localSrcOutSec: (srcOutMs / 1000 - seekSec).toFixed(3),
      seekSec,
    };
  }
  if (allowFastInputSeek && assetDurationMs > 60_000 && srcOutMs + 5000 < assetDurationMs) {
    const readSpanSec = Math.max(1, Math.ceil(srcOutMs / 1000 + 3));
    return {
      inputArgs: ["-t", String(readSpanSec), "-i", absAssetPath],
      localSrcInSec: (srcInMs / 1000).toFixed(3),
      localSrcOutSec: (srcOutMs / 1000).toFixed(3),
      seekSec: 0,
    };
  }
  return {
    inputArgs: ["-i", absAssetPath],
    localSrcInSec: (srcInMs / 1000).toFixed(3),
    localSrcOutSec: (srcOutMs / 1000).toFixed(3),
    seekSec: 0,
  };
}
