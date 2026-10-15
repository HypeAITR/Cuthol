/**
 * Cuthol Explainable Automation (`decision_trace`) Schema & Builders (`src/core/decision_trace.ts`).
 *
 * Ensures AI agents never have to read Cuthol's source code to understand WHY an automated
 * heuristic (`mix duck`, `speech cleanup`, `mix beat-align`, `speech captions`, `mix normalize`)
 * accepted, rejected, merged, or clamped a given time window or clip.
 */

export type DecisionFeatureKind =
  | "ducking"
  | "silence_cut"
  | "beat_align"
  | "auto_caption"
  | "loudness_normalize";

export type DecisionActionKind =
  | "applied"
  | "rejected"
  | "merged"
  | "shifted"
  | "clamped"
  | "skipped";

export interface DecisionTraceItem {
  id: string;
  span: [number, number];
  action: DecisionActionKind;
  reason_code: string;
  measured?: Record<string, number | string>;
  threshold?: Record<string, number | string>;
  margin?: number;
  note?: string;
  refs?: string[];
}

export interface DecisionTrace {
  trace_id: string;
  feature: DecisionFeatureKind;
  algorithm: {
    id: string;
    version: string;
  };
  revision: number;
  params: Record<
    string,
    {
      value: unknown;
      default: unknown;
      unit?: string;
      source: "default" | "user" | "preset";
    }
  >;
  rules: string[];
  summary: {
    text: string;
    candidates: number;
    accepted: number;
    rejected: number;
    by_reason: Record<string, number>;
    effect: Record<string, number | string>;
  };
  decisions: DecisionTraceItem[];
  near_misses: DecisionTraceItem[];
}
