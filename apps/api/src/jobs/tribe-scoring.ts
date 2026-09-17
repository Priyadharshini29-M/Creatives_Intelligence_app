import { RuleWeights } from '../rules/rule-defaults';
import { ColourAnalysis, CopyAnalysis, SceneAnalysis, SubjectAnalysis } from './ai-client.service';

/**
 * The Tribe v2 scoring engine — combines the 4 parallel analyzer outputs
 * into the pillar scores ANALYSIS_RULES.md defines (60% Creative Quality +
 * 30% Audience & Persona Fit + 10% Conversion Safety), using live weights
 * from RulesService instead of hardcoded constants.
 *
 * This is the "swappable interface" scoring engine from the approved plan —
 * a heuristic implementation, not the real vendored TRIBE v2 model (CC
 * BY-NC 4.0, never wired into any request path in either prototype). Every
 * sub-score below is a coarse, clearly-labeled proxy from signals this
 * pipeline actually has; a few (regionalLanguage, demographic) are flat
 * neutral defaults pending real language/vertical detectors — a known gap,
 * not a bug, since no such detector exists anywhere in this codebase or the
 * prototypes to port. A real trained model can replace this file's combine
 * step later without touching any caller.
 */

export interface TribeSubScores {
  attentionHold: number; // 0-1
  colourBalance: number; // 0-1
  typography: number; // 0-1
  subjectPlacement: number; // 0-1
  regionalLanguage: number; // 0-1
  aspectFit: number; // 0-1
  demographic: number; // 0-1
  ctaClarity: number; // 0-1
  claimSafety: number; // 0-1
  offerStrength: number; // 0-1
  ctaSignal: number; // 0-1
}

export interface TribePillarScores {
  creativeQuality: number; // 0-100
  audienceFit: number; // 0-100
  conversionSafety: number; // 0-100
  weightedScore: number; // 0-100, before the human-gate cap
  approvalScore: number; // 0-100, human-gate-capped
  humanGate: {
    readability: number;
    oneSecondClarity: number;
    actionClarity: number;
    passed: boolean;
  };
  subScores: TribeSubScores;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
// Rule weights within a category are user-editable (Rule Editor) and
// nothing enforces they sum to 1 (or that pillar weights sum to 100) — a
// deliberate choice (the whole point is letting the user reweight freely),
// but every pillar/gate output is documented as 0-100 everywhere else
// (dashboard averages, score cards, PDF export, human-gate thresholds), so
// clamp before rounding rather than let an aggressive edit produce a
// >100 or <0 score downstream.
const pct100 = (v01: number) => Math.round(clamp01(v01) * 100 * 100) / 100;

// Standard placements + log-distance formula, ported from
// creatival-web/lib/scoring/aspect.ts (deliberately log-distance, not
// app.js's linear distance — see the exploration notes' flagged divergence;
// this follows the more recent/refined port).
const ASPECT_PLACEMENTS: { ratio: number; label: string }[] = [
  { ratio: 9 / 16, label: '9:16 Vertical' },
  { ratio: 4 / 5, label: '4:5 Portrait' },
  { ratio: 1, label: '1:1 Square' },
  { ratio: 16 / 9, label: '16:9 Landscape' },
];

function aspectFit(width: number | null, height: number | null): number {
  if (!width || !height) return 0.5; // unknown — neutral
  const aspect = width / height;
  let best = { distance: Infinity, label: '' };
  for (const placement of ASPECT_PLACEMENTS) {
    const distance = Math.abs(Math.log(aspect / placement.ratio));
    if (distance < best.distance) best = { distance, label: placement.label };
  }
  const bonus = best.label === '9:16 Vertical' ? 0.08 : 0;
  return clamp01(1 - best.distance * 0.9 + bonus);
}

// Superlative/absolute-claim words that read as policy-risk phrasing —
// small, local heuristic so conversionSafety doesn't have to wait on the
// Gemini sales engine (which runs *after* this step and consumes its
// output — see pipeline.processor.ts's runSalesEngine).
const CLAIM_RISK_PATTERN =
  /\b(guaranteed|100%|miracle|cure[sd]?|instant(ly)?|no risk|best ever|#1|number one|proven to)\b/i;

/**
 * Gemini's `claim_safety.risk` (from gemini_sales.py's `SalesEngineOutput`)
 * is a free-text field, not a Pydantic enum — the prompt asks for "an
 * overall risk level" without constraining wording, and observed live
 * output includes casings/words like "Moderate" that a naive
 * `=== 'medium'` check (the pre-existing one in this file's
 * `buildNextActions` caller) silently never matches. Normalize by
 * substring rather than exact match so any reasonable phrasing lands in
 * one of the 3 buckets, and unrecognized text stays `null` (caller falls
 * back to the local-only heuristic) instead of being misread as "safe".
 */
export function normalizeClaimRisk(risk: string | null | undefined): 'low' | 'medium' | 'high' | null {
  if (!risk) return null;
  const r = risk.toLowerCase();
  if (/(high|severe|elevated|significant)/.test(r)) return 'high';
  if (/(medium|moderate|some|mild)/.test(r)) return 'medium';
  if (/(low|minimal|none|safe)/.test(r)) return 'low';
  return null;
}

const GEMINI_CLAIM_RISK_SCORE: Record<'low' | 'medium' | 'high', number> = {
  low: 0.9,
  medium: 0.55,
  high: 0.25,
};

/**
 * claimSafety blends two independent signals when both are available:
 * a cheap local regex over the OCR'd on-screen copy (available the moment
 * TRIBE_ANALYSIS runs, before any Gemini call), and Gemini's own qualitative
 * claim-risk judgment (only available after SALES_ENGINE runs, since that's
 * the step that makes the call — see pipeline.processor.ts's
 * runSalesEngine, which re-invokes computeTribeScores with this once the
 * Gemini result exists so the *final* approvalScore genuinely reflects it,
 * not just a cosmetic display field). Gemini is weighted higher (65/35)
 * since it reads actual phrasing/context the regex can't; when Gemini
 * hasn't run yet (or returned unparseable risk text) this falls back to the
 * regex alone, same as before this changed.
 */
function claimSafety(copyText: string, geminiRisk?: 'low' | 'medium' | 'high' | null): number {
  const local = copyText ? (CLAIM_RISK_PATTERN.test(copyText) ? 0.4 : 0.85) : 0.7;
  if (!geminiRisk) return local;
  return clamp01(GEMINI_CLAIM_RISK_SCORE[geminiRisk] * 0.65 + local * 0.35);
}

export type ScoreBand = 'GOOD' | 'AVERAGE' | 'BAD';

// Canonical approval thresholds from
// D:\Creative-Intelligence\Creatival_01\creative-approval-score\ANALYSIS_RULES.md's
// "Approval thresholds" section (82-100 Approve for scale / 68-81 Revise one
// element / 0-67 Hold for rework) — the same numbers `gate-score-cap`
// already borrows (67, one point under the Revise floor). Reused as one
// consistent GOOD/AVERAGE/BAD read across every 0-100 score this pipeline
// shows (approval score, the 3 pillars, meta ad score) instead of a second,
// invented scale.
export function scoreBand(score: number | null | undefined): ScoreBand | null {
  if (score == null || Number.isNaN(score)) return null;
  if (score >= 82) return 'GOOD';
  if (score >= 68) return 'AVERAGE';
  return 'BAD';
}

export interface TribeScoringInput {
  weights: RuleWeights;
  scene: SceneAnalysis | null;
  copy: CopyAnalysis | null;
  colour: ColourAnalysis | null;
  subject: SubjectAnalysis | null;
  frameMotionScores: number[]; // Frame.motionScore values, already 0-1
  video: { width: number | null; height: number | null };
  // Gemini sales-engine's claim-risk read (see claimSafety() above) —
  // absent on the first TRIBE_ANALYSIS pass (Gemini hasn't run yet),
  // present when pipeline.processor.ts's runSalesEngine recomputes scores
  // after it has.
  geminiClaimRisk?: string | null;
}

export function computeTribeScores(input: TribeScoringInput): TribePillarScores {
  const { weights, scene, copy, colour, subject, frameMotionScores, video, geminiClaimRisk } = input;

  const avgMotion =
    frameMotionScores.length > 0
      ? frameMotionScores.reduce((a, b) => a + b, 0) / frameMotionScores.length
      : 0.3;
  const colourBalanceScore = colour?.balance.score ?? 0.5;
  const centerFocus = subject?.center_focus ?? 0.5;

  const sub: TribeSubScores = {
    attentionHold: clamp01(avgMotion * 0.5 + colourBalanceScore * 0.25 + centerFocus * 0.25),
    colourBalance: clamp01(colourBalanceScore),
    // Coarse proxy — real typography/contrast measurement would need
    // bounding-box-level analysis this pipeline doesn't have; presence of
    // readable on-screen copy with a detected CTA is the signal available.
    typography: copy?.text ? (copy.cta.detected ? 0.75 : 0.6) : 0.35,
    subjectPlacement: subject
      ? clamp01((subject.object_presence ?? 0) * 0.5 + centerFocus * 0.5)
      : 0.4,
    // Flat neutral defaults — no regional-language or vertical/demographic
    // detector exists in this codebase or either prototype to port; a real
    // one is a future addition, not something this heuristic pass fakes
    // confidence about.
    regionalLanguage: 0.6,
    demographic: 0.6,
    aspectFit: aspectFit(video.width, video.height),
    ctaClarity: copy?.cta.detected ? 0.75 : 0.35,
    claimSafety: claimSafety(copy?.text ?? '', normalizeClaimRisk(geminiClaimRisk)),
    offerStrength: copy && (copy.cta.has_pricing || copy.cta.has_urgency) ? 0.75 : 0.4,
    // Proximity of the on-screen accent-color share to the 10% CTA-accent
    // target from the 60/30/10 rule (colour/analyser.py already computes
    // accent_share the same way).
    ctaSignal:
      colour?.balance.accent_share != null
        ? clamp01(1 - Math.abs(colour.balance.accent_share - 0.1) * 4)
        : 0.5,
  };

  // scene.objects/layout aren't scored numerically (Gemini Vision is
  // deliberately descriptive-only per the diagram — see gemini_vision.py's
  // docstring); they still ride along on VideoAnalytics.sceneAnalysis for
  // the Report Builder (Milestone 7) even though they don't feed this combine.
  void scene;

  const creativeQuality01 =
    sub.attentionHold * weights.creativeQuality.attentionHold +
    sub.colourBalance * weights.creativeQuality.colourBalance +
    sub.typography * weights.creativeQuality.typography +
    sub.subjectPlacement * weights.creativeQuality.subjectPlacement;

  const audienceFit01 =
    sub.regionalLanguage * weights.audienceFit.regionalLanguage +
    sub.aspectFit * weights.audienceFit.aspectFit +
    sub.demographic * weights.audienceFit.demographic;

  const conversionSafety01 =
    sub.ctaClarity * weights.conversionSafety.ctaClarity +
    sub.claimSafety * weights.conversionSafety.claimSafety +
    sub.offerStrength * weights.conversionSafety.offerStrength +
    sub.ctaSignal * weights.conversionSafety.ctaSignal;

  // Not pct100 — these are already 0-100-ish sums of a user-edited weight
  // set that need not sum to 1, so clamp the sum directly instead of
  // treating it as a 0-1 fraction.
  const creativeQuality = Math.max(0, Math.min(100, Math.round(creativeQuality01 * 100 * 100) / 100));
  const audienceFit = Math.max(0, Math.min(100, Math.round(audienceFit01 * 100 * 100) / 100));
  const conversionSafety = Math.max(0, Math.min(100, Math.round(conversionSafety01 * 100 * 100) / 100));

  const weightedScoreRaw =
    creativeQuality01 * weights.pillars.creativeQuality +
    audienceFit01 * weights.pillars.audienceFit +
    conversionSafety01 * weights.pillars.conversionSafety;
  const weightedScore = Math.max(0, Math.min(100, Math.round(weightedScoreRaw * 100) / 100));

  // Blended with colourBalance (a real, independently-computed signal),
  // not typography alone — typography is a 3-value proxy gated entirely on
  // whether OCR found any on-screen text (see its definition above), so
  // with no OCR text at all it's pinned to its lowest value and readability
  // would otherwise fail identically on every single video regardless of
  // actual quality whenever Tesseract isn't installed. This keeps the gate
  // meaningful even when that one dependency is unavailable, rather than a
  // single missing binary making every video fail this check the same way.
  const readability = pct100((sub.typography + sub.colourBalance) / 2);
  const oneSecondClarity = pct100((sub.attentionHold + sub.subjectPlacement) / 2);
  const actionClarity = pct100(sub.ctaClarity);

  const humanGatePassed =
    readability >= weights.humanGate.readabilityMin &&
    oneSecondClarity >= weights.humanGate.oneSecondClarityMin &&
    actionClarity >= weights.humanGate.actionClarityMin;

  const approvalScore = humanGatePassed
    ? weightedScore
    : Math.min(weights.humanGate.scoreCap, weightedScore);

  return {
    creativeQuality,
    audienceFit,
    conversionSafety,
    weightedScore: Math.round(weightedScore * 100) / 100,
    approvalScore,
    humanGate: { readability, oneSecondClarity, actionClarity, passed: humanGatePassed },
    subScores: sub,
  };
}
