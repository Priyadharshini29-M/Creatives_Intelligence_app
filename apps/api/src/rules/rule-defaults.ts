// Flat rule shape the Rule Editor UI lists/edits (Milestone 8) — matches the
// whiteboard's Rule Editor box exactly: {name, weight, category, enabled}.
// Canonical storage is the filesystem (rules.json under
// CREATIVE_INTELLIGENCE_DATA_DIR), not the database — see rules.service.ts.
export interface Rule {
  id: string;
  name: string;
  category: 'pillar' | 'creative_quality' | 'audience_fit' | 'conversion_safety' | 'gate';
  weight: number;
  enabled: boolean;
}

// Weights the Tribe v2 scoring engine (pipeline.processor.ts's
// runTribeAnalysis) actually consumes — reduced from the flat Rule[] above.
// A disabled rule contributes 0 rather than triggering a renormalization of
// its siblings — simpler, and a reasonable reading of "toggle this off":
// the factor stops influencing the score instead of its weight being
// redistributed elsewhere.
export interface RuleWeights {
  pillars: { creativeQuality: number; audienceFit: number; conversionSafety: number };
  creativeQuality: {
    attentionHold: number;
    colourBalance: number;
    typography: number;
    subjectPlacement: number;
  };
  audienceFit: { regionalLanguage: number; aspectFit: number; demographic: number };
  conversionSafety: {
    ctaClarity: number;
    claimSafety: number;
    offerStrength: number;
    ctaSignal: number;
  };
  humanGate: {
    readabilityMin: number;
    oneSecondClarityMin: number;
    actionClarityMin: number;
    scoreCap: number;
  };
}

// Seed values: pillar split (60/30/10) and human-gate thresholds/cap from
// D:\Creative-Intelligence\Creatival_01\creative-approval-score's
// ANALYSIS_RULES.md (treated as canonical over app.js's internal 78/68
// copy — see the approved plan). Sub-pillar weights ported from
// creatival-web/lib/scoring/combine.ts's creativeQuality/audienceFit/
// conversionSafety formulas (each pillar's weights sum to 1).
export const DEFAULT_RULES: Rule[] = [
  { id: 'pillar-creative-quality', name: 'Creative Quality', category: 'pillar', weight: 60, enabled: true },
  { id: 'pillar-audience-fit', name: 'Audience & Persona Fit', category: 'pillar', weight: 30, enabled: true },
  { id: 'pillar-conversion-safety', name: 'Conversion Safety', category: 'pillar', weight: 10, enabled: true },

  { id: 'cq-attention-hold', name: 'Attention Hold', category: 'creative_quality', weight: 0.3, enabled: true },
  { id: 'cq-colour-balance', name: '60/30/10 Colour Balance', category: 'creative_quality', weight: 0.25, enabled: true },
  { id: 'cq-typography', name: 'Typography Contrast', category: 'creative_quality', weight: 0.25, enabled: true },
  { id: 'cq-subject-placement', name: 'Subject Placement', category: 'creative_quality', weight: 0.2, enabled: true },

  { id: 'af-regional-language', name: 'Regional Language Fit', category: 'audience_fit', weight: 0.4, enabled: true },
  { id: 'af-aspect-fit', name: 'Aspect Ratio / Format Fit', category: 'audience_fit', weight: 0.3, enabled: true },
  { id: 'af-demographic', name: 'Demographic & Vertical Fit', category: 'audience_fit', weight: 0.3, enabled: true },

  { id: 'cs-cta-clarity', name: 'CTA Clarity', category: 'conversion_safety', weight: 0.3, enabled: true },
  { id: 'cs-claim-safety', name: 'Claim Risk Safety', category: 'conversion_safety', weight: 0.25, enabled: true },
  { id: 'cs-offer-strength', name: 'Offer Strength', category: 'conversion_safety', weight: 0.25, enabled: true },
  { id: 'cs-cta-signal', name: 'On-Screen CTA Visual Signal', category: 'conversion_safety', weight: 0.2, enabled: true },

  { id: 'gate-readability-min', name: 'Human Gate: Readability Minimum', category: 'gate', weight: 48, enabled: true },
  { id: 'gate-one-second-clarity-min', name: 'Human Gate: One-Second Clarity Minimum', category: 'gate', weight: 48, enabled: true },
  { id: 'gate-action-clarity-min', name: 'Human Gate: Action Clarity Minimum', category: 'gate', weight: 45, enabled: true },
  { id: 'gate-score-cap', name: 'Human Gate: Score Cap On Failure', category: 'gate', weight: 67, enabled: true },
];

function weightOf(rules: Rule[], id: string, fallback: number): number {
  const rule = rules.find((r) => r.id === id);
  if (!rule) return fallback;
  return rule.enabled ? rule.weight : 0;
}

export function reduceToWeights(rules: Rule[]): RuleWeights {
  return {
    pillars: {
      creativeQuality: weightOf(rules, 'pillar-creative-quality', 60),
      audienceFit: weightOf(rules, 'pillar-audience-fit', 30),
      conversionSafety: weightOf(rules, 'pillar-conversion-safety', 10),
    },
    creativeQuality: {
      attentionHold: weightOf(rules, 'cq-attention-hold', 0.3),
      colourBalance: weightOf(rules, 'cq-colour-balance', 0.25),
      typography: weightOf(rules, 'cq-typography', 0.25),
      subjectPlacement: weightOf(rules, 'cq-subject-placement', 0.2),
    },
    audienceFit: {
      regionalLanguage: weightOf(rules, 'af-regional-language', 0.4),
      aspectFit: weightOf(rules, 'af-aspect-fit', 0.3),
      demographic: weightOf(rules, 'af-demographic', 0.3),
    },
    conversionSafety: {
      ctaClarity: weightOf(rules, 'cs-cta-clarity', 0.3),
      claimSafety: weightOf(rules, 'cs-claim-safety', 0.25),
      offerStrength: weightOf(rules, 'cs-offer-strength', 0.25),
      ctaSignal: weightOf(rules, 'cs-cta-signal', 0.2),
    },
    humanGate: {
      readabilityMin: weightOf(rules, 'gate-readability-min', 48),
      oneSecondClarityMin: weightOf(rules, 'gate-one-second-clarity-min', 48),
      actionClarityMin: weightOf(rules, 'gate-action-clarity-min', 45),
      scoreCap: weightOf(rules, 'gate-score-cap', 67),
    },
  };
}
