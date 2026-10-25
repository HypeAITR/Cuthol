// Envelope evaluation and slicing, reframe focal-point slicing (split out of spine.ts).
import {
  ParameterEnvelope,
  ParameterEnvelopePoint, SpineClip
} from "../core/schema.js";

export function evaluateEnvelopeAt(envelope: ParameterEnvelope, offsetMs: number): number {
  const pts = envelope.points;
  if (pts.length === 0) return 0;
  if (offsetMs <= pts[0].offset_ms) return pts[0].value;
  if (offsetMs >= pts[pts.length - 1].offset_ms) return pts[pts.length - 1].value;

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (offsetMs >= a.offset_ms && offsetMs <= b.offset_ms) {
      const span = Math.max(1, b.offset_ms - a.offset_ms);
      const t = (offsetMs - a.offset_ms) / span;
      let easedT = t;
      switch (b.easing) {
        case "ease_in":
          easedT = t * t;
          break;
        case "ease_out":
          easedT = 1 - (1 - t) * (1 - t);
          break;
        case "ease_in_out":
          easedT = t * t * (3 - 2 * t);
          break;
        case "linear":
        default:
          easedT = t;
          break;
      }
      return Number((a.value + (b.value - a.value) * easedT).toFixed(6));
    }
  }
  return pts[pts.length - 1].value;
}

export function sliceEnvelopes(
  envelopes: ParameterEnvelope[],
  localStartMs: number,
  localEndMs: number
): ParameterEnvelope[] {
  const newDurationMs = Math.max(0, Math.round(localEndMs - localStartMs));
  const out: ParameterEnvelope[] = [];

  for (const env of envelopes) {
    if (env.points.length === 0) continue;
    if (env.points.length === 1) {
      const shiftedOffset = Math.max(
        0,
        Math.min(newDurationMs, Math.round(env.points[0].offset_ms - localStartMs))
      );
      out.push({
        parameter: env.parameter,
        points: [{ ...env.points[0], offset_ms: shiftedOffset }],
      });
      continue;
    }

    const startVal = evaluateEnvelopeAt(env, localStartMs);
    const endVal = evaluateEnvelopeAt(env, localEndMs);

    let endEasing: ParameterEnvelopePoint["easing"] = "linear";
    for (let i = 0; i < env.points.length - 1; i++) {
      const a = env.points[i];
      const b = env.points[i + 1];
      if (localEndMs > a.offset_ms && localEndMs <= b.offset_ms) {
        endEasing = b.easing;
        break;
      }
    }

    const firstOrigOffset = env.points[0].offset_ms;
    const lastOrigOffset = env.points[env.points.length - 1].offset_ms;
    const rawPts: ParameterEnvelopePoint[] = [];

    if (localStartMs >= firstOrigOffset || localEndMs <= firstOrigOffset) {
      rawPts.push({ offset_ms: 0, value: startVal, easing: "linear" });
    }

    for (const p of env.points) {
      if (p.offset_ms > localStartMs && p.offset_ms < localEndMs) {
        rawPts.push({
          offset_ms: Math.max(0, Math.min(newDurationMs, Math.round(p.offset_ms - localStartMs))),
          value: p.value,
          easing: p.easing,
        });
      }
    }

    if (localEndMs <= lastOrigOffset && localEndMs > firstOrigOffset) {
      rawPts.push({ offset_ms: newDurationMs, value: endVal, easing: endEasing });
    } else if (rawPts.length === 0) {
      rawPts.push({ offset_ms: 0, value: startVal, easing: "linear" });
    }

    rawPts.sort((a, b) => a.offset_ms - b.offset_ms);
    const deduped: ParameterEnvelopePoint[] = [];
    for (const pt of rawPts) {
      if (deduped.length > 0 && deduped[deduped.length - 1].offset_ms === pt.offset_ms) {
        deduped[deduped.length - 1] = pt;
      } else {
        deduped.push(pt);
      }
    }

    out.push({ parameter: env.parameter, points: deduped });
  }

  return out;
}

export function sliceReframeFocalPoints(
  focalPoints: SpineClip["treatments"]["reframe"]["focal_points"],
  localStartMs: number,
  localEndMs: number
): SpineClip["treatments"]["reframe"]["focal_points"] {
  if (!focalPoints || focalPoints.length === 0) return [];
  const newDurationMs = Math.max(0, Math.round(localEndMs - localStartMs));
  if (focalPoints.length === 1) {
    return [
      {
        ...focalPoints[0],
        offset_ms: Math.max(0, Math.min(newDurationMs, Math.round(focalPoints[0].offset_ms - localStartMs))),
      },
    ];
  }

  const xEnv: ParameterEnvelope = {
    parameter: "placement.x_pct",
    points: focalPoints.map((fp) => ({
      offset_ms: fp.offset_ms,
      value: fp.center_x_pct,
      easing: "ease_in_out",
    })),
  };
  const yEnv: ParameterEnvelope = {
    parameter: "placement.y_pct",
    points: focalPoints.map((fp) => ({
      offset_ms: fp.offset_ms,
      value: fp.center_y_pct,
      easing: "ease_in_out",
    })),
  };

  const startCx = Number(evaluateEnvelopeAt(xEnv, localStartMs).toFixed(2));
  const endCx = Number(evaluateEnvelopeAt(xEnv, localEndMs).toFixed(2));
  const startCy = Number(evaluateEnvelopeAt(yEnv, localStartMs).toFixed(2));
  const endCy = Number(evaluateEnvelopeAt(yEnv, localEndMs).toFixed(2));

  const raw: SpineClip["treatments"]["reframe"]["focal_points"] = [
    { offset_ms: 0, center_x_pct: startCx, center_y_pct: startCy, confidence: focalPoints[0].confidence },
  ];
  for (const fp of focalPoints) {
    if (fp.offset_ms > localStartMs && fp.offset_ms < localEndMs) {
      raw.push({
        offset_ms: Math.max(0, Math.min(newDurationMs, Math.round(fp.offset_ms - localStartMs))),
        center_x_pct: fp.center_x_pct,
        center_y_pct: fp.center_y_pct,
        confidence: fp.confidence,
      });
    }
  }
  if (newDurationMs > 0) {
    raw.push({
      offset_ms: newDurationMs,
      center_x_pct: endCx,
      center_y_pct: endCy,
      confidence: focalPoints[focalPoints.length - 1].confidence,
    });
  }
  raw.sort((a, b) => a.offset_ms - b.offset_ms);
  const deduped: SpineClip["treatments"]["reframe"]["focal_points"] = [];
  for (const pt of raw) {
    if (deduped.length > 0 && deduped[deduped.length - 1].offset_ms === pt.offset_ms) {
      deduped[deduped.length - 1] = pt;
    } else {
      deduped.push(pt);
    }
  }
  return deduped;
}
