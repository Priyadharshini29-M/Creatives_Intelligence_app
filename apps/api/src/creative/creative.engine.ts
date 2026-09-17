import { Platform, Video, VideoAnalytics } from '@vip/database';
import { AnalysisResult } from '../jobs/ai-client.service';

/**
 * Deterministic creative generator grounded in the stored analysis.
 * Every output cites the real signals it was derived from (`basis`), so
 * nothing reads as data the pipeline never produced.
 *
 * A `seed` drives template selection: same seed → same copy, new seed →
 * a fresh recombination (the UI's "Regenerate"). Swap the template layer
 * for an LLM later — the grounded context and seed contract stay identical.
 */

export interface CreativeContext {
  video: Video;
  analytics: VideoAnalytics | null;
  analysis: AnalysisResult;
  niche: string | null;
}

// ── Seeded PRNG (mulberry32) ───────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function sample<T>(rng: () => number, arr: readonly T[], n: number): T[] {
  const copy = [...arr];
  const out: T[] = [];
  while (out.length < n && copy.length > 0) {
    out.push(copy.splice(Math.floor(rng() * copy.length), 1)[0]);
  }
  return out;
}

// ── Personas ───────────────────────────────────────────────────

interface PersonaMeta {
  label: string;
  tone: string;
  hooks: ((p: string) => string)[];
  ctas: string[];
  landingHeadlines: ((p: string) => string)[];
  landingProof: string;
  landingOffer: string;
}

const PERSONAS: Record<string, PersonaMeta> = {
  gen_z: {
    label: 'Gen Z',
    tone: 'casual, fast, trend-aware',
    hooks: [
      (p) => `POV: you finally found the ${p} that actually works`,
      (p) => `no bc why did nobody tell me about this ${p}`,
      (p) => `the ${p} that broke my For You page`,
    ],
    ctas: ['Tap to see it yourself', 'Peep the link', 'Run, don’t walk'],
    landingHeadlines: [
      (p) => `The ${p} everyone keeps reposting`,
      (p) => `Yes, it’s the ${p} from the video`,
    ],
    landingProof: 'UGC clips and creator reviews above the fold',
    landingOffer: 'Low-friction first order (COD / easy returns badge)',
  },
  millennials: {
    label: 'Millennials',
    tone: 'authentic, value-first',
    hooks: [
      (p) => `We tested ${p} so you don't have to`,
      (p) => `An honest look at ${p} — no filter`,
      (p) => `Here's what a week with ${p} actually looks like`,
    ],
    ctas: ['See the full results', 'Shop the routine', 'Read real reviews'],
    landingHeadlines: [
      (p) => `Why thousands switched to ${p}`,
      (p) => `${cap(p)}: worth the hype?`,
    ],
    landingProof: 'Star-rating summary with verified-buyer count',
    landingOffer: 'Bundle-and-save framing with transparent pricing',
  },
  luxury_buyers: {
    label: 'Luxury Buyers',
    tone: 'premium, restrained',
    hooks: [
      (p) => `${cap(p)} — crafted for people who notice details`,
      (p) => `Quiet luxury, applied to ${p}`,
    ],
    ctas: ['Discover the collection', 'Experience it'],
    landingHeadlines: [
      (p) => `${cap(p)}, elevated`,
      (p) => `The considered choice in ${p}`,
    ],
    landingProof: 'Editorial photography and ingredient/material provenance',
    landingOffer: 'Complimentary shipping and premium packaging note',
  },
  fitness_audience: {
    label: 'Fitness Audience',
    tone: 'energetic, results-driven',
    hooks: [
      (p) => `Your routine is missing this ${p}`,
      (p) => `Train hard. Recover harder — with ${p}`,
    ],
    ctas: ['Start today', 'Fuel up'],
    landingHeadlines: [
      (p) => `Fuel results with ${p}`,
      (p) => `${cap(p)} for people who show up`,
    ],
    landingProof: 'Before/after metrics and expert endorsement',
    landingOffer: 'Subscription with per-serving price breakdown',
  },
  beauty_audience: {
    label: 'Beauty Audience',
    tone: 'transformation-led, personal',
    hooks: [
      (p) => `The before → after from ${p} says everything`,
      (p) => `Watch ${p} do its thing in real time`,
      (p) => `My honest ${p} glow-up`,
    ],
    ctas: ['See the transformation', 'Get the look'],
    landingHeadlines: [
      (p) => `Real results from ${p}`,
      (p) => `Your ${p} before/after starts here`,
    ],
    landingProof: 'Before/after gallery matching the ad frames',
    landingOffer: 'Routine bundle with usage guide',
  },
  tech_audience: {
    label: 'Tech Audience',
    tone: 'specific, how-it-works',
    hooks: [
      (p) => `Here's exactly how ${p} works`,
      (p) => `${cap(p)}: the breakdown nobody does`,
    ],
    ctas: ['Read the breakdown', 'See the specs'],
    landingHeadlines: [
      (p) => `${cap(p)}: what it does and how`,
      (p) => `${cap(p)}, explained properly`,
    ],
    landingProof: 'Spec/ingredient table and FAQ section',
    landingOffer: 'Comparison table against alternatives',
  },
  impulse_buyers: {
    label: 'Impulse Buyers',
    tone: 'urgent, offer-led',
    hooks: [
      (p) => `This ${p} deal won't sit around`,
      (p) => `Last call on the ${p} everyone's grabbing`,
    ],
    ctas: ['Grab it now', 'Claim yours'],
    landingHeadlines: [
      (p) => `Today's ${p} offer`,
      (p) => `${cap(p)} — while it lasts`,
    ],
    landingProof: 'Recent-purchase ticker and stock counter',
    landingOffer: 'Time-boxed discount with sticky add-to-cart',
  },
};

const PLATFORM_TAGS: Record<Platform, string[]> = {
  TIKTOK: ['#fyp', '#tiktokmademebuyit'],
  INSTAGRAM_REELS: ['#reels', '#instagood'],
  YOUTUBE_SHORTS: ['#shorts'],
  FACEBOOK_REELS: ['#reels'],
  SNAPCHAT: [],
  OTHER: [],
};

const STOPWORDS = new Set([
  'video', 'insta', 'instagram', 'reel', 'reels', 'tiktok', 'shorts', 'final',
  'edit', 'v1', 'v2', 'the', 'and', 'for', 'new', 'mp4',
]);

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Product phrase from the title, stripped of platform/file noise. */
export function productName(video: Video): string {
  const words = video.title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w));
  return words.slice(0, 4).join(' ') || video.title;
}

export function adKeywords(ctx: CreativeContext): string[] {
  const fromTitle = productName(ctx.video).split(' ');
  const fromTranscript = ctx.analysis.transcript?.keywords ?? [];
  const emotional = ctx.analysis.transcript?.emotional_keywords ?? [];
  return [...new Set([...fromTitle, ...fromTranscript, ...emotional])].slice(0, 20);
}

export function topPersonas(ctx: CreativeContext, count = 3) {
  const segments = (ctx.analytics?.audienceSegments ?? {}) as Record<string, number>;
  return Object.entries(segments)
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .filter(([key]) => PERSONAS[key])
    .map(([key, affinity]) => ({ key, affinity, meta: PERSONAS[key] }));
}

function topEmotion(ctx: CreativeContext): string | null {
  const emotions = ctx.analysis.sentiment?.emotions ?? {};
  const ranked = Object.entries(emotions).sort((a, b) => b[1] - a[1]);
  return ranked[0]?.[0] ?? null;
}

// ── Primary text ───────────────────────────────────────────────

export function primaryText(ctx: CreativeContext, seed: number) {
  const rng = mulberry32(seed);
  const product = productName(ctx.video);
  const duration = Math.round(ctx.video.durationSec ?? 0);
  const emotion = topEmotion(ctx);
  const personas = topPersonas(ctx, 1);
  const persona = personas[0]?.meta;
  const basis: string[] = [];

  const titlePool = [
    `The ${product} result nobody expects`,
    duration > 0
      ? `${cap(product)} — the ${duration}-second proof`
      : `${cap(product)} — the proof in one watch`,
    `Watch what ${product} does in one use`,
    `${cap(product)}: seeing is believing`,
    `We put ${product} on camera. No edits.`,
    `The truth about ${product}, in one take`,
    `Don't scroll past this ${product}`,
  ];
  const titles = sample(rng, titlePool, 3);
  if (persona) {
    titles.push(pick(rng, persona.hooks)(product));
    basis.push(
      `Lead persona: ${persona.label} (${((personas[0].affinity ?? 0) * 100).toFixed(1)}% affinity)`,
    );
  }
  if (emotion) basis.push(`Dominant detected emotion: ${emotion}`);
  if (ctx.analytics?.hookRate != null) {
    basis.push(
      `${(ctx.analytics.hookRate * 100).toFixed(1)}% predicted to survive the hook window`,
    );
  }

  const hashtags = [
    ...product.split(' ').map((w) => `#${w.replace(/\s/g, '')}`),
    ...(ctx.niche ? [`#${ctx.niche.toLowerCase().replace(/[^a-z0-9]/g, '')}`] : []),
    ...PLATFORM_TAGS[ctx.video.targetPlatform],
  ].slice(0, 8);

  const bodyPool = [
    `Show, don't tell: the video already carries ${emotion ?? 'a neutral'} tone — keep the caption short and let the visual result of ${product} do the selling.`,
    `Let the clip carry the ${emotion ?? 'neutral'} tone and use the caption for one concrete detail about ${product} viewers can't get from the visuals.`,
    `Lead with the outcome, not the product: one line about what changes after ${product}, then stop — the video does the rest.`,
  ];

  const hookLine = persona
    ? pick(rng, persona.hooks)(product)
    : `Stop scrolling — ${product}.`;
  const cta = ctx.analysis.transcript?.cta_detected
    ? 'Reinforce the spoken CTA: put the same offer in the first comment and bio link.'
    : `Add a clear CTA — the transcript has none. Suggested: “${
        persona ? pick(rng, persona.ctas) : 'Shop now'
      } → link in bio.”`;

  return {
    titles,
    caption: { hook: hookLine, body: pick(rng, bodyPool), cta, hashtags },
    basis,
  };
}

// ── Retention content ideas ────────────────────────────────────

export function retentionIdeas(ctx: CreativeContext, seed: number) {
  const rng = mulberry32(seed);
  const ideas: { title: string; detail: string; basis: string }[] = [];
  const timeline = ctx.analysis.retention?.timeline ?? [];
  const product = productName(ctx.video);

  const recutDetails = [
    'Tighten or replace this stretch: add a scene change, camera move, or on-screen text so the pacing resets before viewers bail.',
    'Split the shot here — insert a close-up, a caption card, or a jump cut so the rhythm changes exactly where attention sags.',
  ];
  const worst = [...timeline].sort((a, b) => b.drop_prob - a.drop_prob).slice(0, 2);
  for (const point of worst) {
    ideas.push({
      title: `Re-cut around ${point.timestamp.toFixed(1)}s`,
      detail: pick(rng, recutDetails),
      basis: `Drop hazard peaks at ${(point.drop_prob * 100).toFixed(1)}% here — the riskiest moment on the survival curve.`,
    });
  }

  const scrollSignals = ctx.analysis.scroll?.signals ?? [];
  if (scrollSignals.some((s) => s.toLowerCase().includes('static opening'))) {
    ideas.push({
      title: 'Open with motion, not a static frame',
      detail: pick(rng, [
        `Start mid-action or on the end result of ${product}, then rewind to the story — a moving first second interrupts the feed scroll.`,
        `Open on the most kinetic moment you have of ${product} — even a whip-pan or hands-in-frame beats a locked-off opening shot.`,
      ]),
      basis: 'Scroll model flagged a static opening with little to interrupt the scroll.',
    });
  }

  for (const rec of ctx.analysis.hook?.recommendations ?? []) {
    ideas.push({
      title: 'Strengthen the first 3 seconds',
      detail: rec,
      basis: `Hook score ${((ctx.analysis.hook?.score ?? 0) * 100).toFixed(0)}/100; issues: ${
        (ctx.analysis.hook?.issues ?? []).join('; ') || 'none listed'
      }.`,
    });
  }

  if ((ctx.analysis.transcript?.word_count ?? 0) === 0) {
    ideas.push({
      title: 'Add a voiceover or captions pass',
      detail:
        'A short spoken benefit line (or burned-in captions) gives sound-off viewers a second reason to stay and unlocks transcript-driven suggestions.',
      basis: 'Whisper detected no speech in the audio track.',
    });
  }

  if (ctx.analytics?.holdRate != null) {
    ideas.push({
      title: 'Tease the ending up front',
      detail: pick(rng, [
        'Flash the final result for half a second at the start (“wait for it”), then play the sequence — classic open-loop structure lifts completion.',
        'Cold-open on the payoff frame with a “here’s how” caption, then restart from the beginning — viewers stay to close the loop.',
      ]),
      basis: `${(ctx.analytics.holdRate * 100).toFixed(1)}% currently predicted to reach the end.`,
    });
    ideas.push({
      title: 'Cut a shorter variant and A/B it',
      detail: `Publish a tighter cut (roughly the first ${Math.max(
        8,
        Math.round((ctx.video.durationSec ?? 15) * 0.6),
      )}s ending on the strongest frame) and compare hold rates after launch.`,
      basis: `Expected watch time is ${ctx.analytics.avgPlayTimeSec ?? '—'}s of a ${Math.round(
        ctx.video.durationSec ?? 0,
      )}s video.`,
    });
  }

  // Fresh order per regeneration; the grounded facts stay the same.
  return sample(rng, ideas, ideas.length);
}

// ── Ad variations per persona ──────────────────────────────────

type AngleBuilder = (
  product: string,
  meta: PersonaMeta,
  ctx: CreativeContext,
  rng: () => number,
) => { angle: string; headline: string; primaryText: string; cta: string };

const ANGLES: AngleBuilder[] = [
  (product, meta, ctx, rng) => ({
    angle: 'Benefit-led',
    headline: pick(rng, meta.landingHeadlines)(product),
    primaryText: `${pick(rng, meta.hooks)(product)}. ${cap(product)} in ${Math.round(
      ctx.video.durationSec ?? 15,
    )} seconds — no claims, just the result on screen.`,
    cta: pick(rng, meta.ctas),
  }),
  (product, meta, _ctx, rng) => ({
    angle: 'Social proof',
    headline: `The ${product} people keep sharing`,
    primaryText: `Lead with the strongest second of the video as the thumbnail, back it with a real review quote about ${product}.`,
    cta: pick(rng, meta.ctas),
  }),
  (product, meta, _ctx, rng) => ({
    angle: 'Curiosity',
    headline: `What happens after ${product}?`,
    primaryText: `${pick(rng, meta.hooks)(product)} — hold the reveal until the last second and let comments do the arguing.`,
    cta: pick(rng, meta.ctas),
  }),
  (product, meta, _ctx, rng) => ({
    angle: 'How-it-works',
    headline: `${cap(product)}, step by step`,
    primaryText: `Cut the video into a 3-step walkthrough of ${product} with numbered captions — process content earns saves, and saves earn reach.`,
    cta: pick(rng, meta.ctas),
  }),
];

export function adVariations(ctx: CreativeContext, seed: number) {
  const rng = mulberry32(seed);
  const product = productName(ctx.video);
  const emotions = ctx.analysis.sentiment?.emotions ?? {};
  const urgency = Number(emotions['urgency'] ?? 0);

  return topPersonas(ctx, 3).map(({ key, affinity, meta }) => {
    const variations = sample(rng, ANGLES, 2).map((build) =>
      build(product, meta, ctx, rng),
    );
    if (urgency > 0.15) {
      variations[1] = {
        angle: 'Urgency / offer',
        headline: `Today only: ${product}`,
        primaryText: `The video's urgency tone tested strongest — pair it with a real, dated offer for ${product} so the pressure is honest.`,
        cta: 'Claim the offer',
      };
    }
    return {
      persona: key,
      personaLabel: meta.label,
      affinity,
      tone: meta.tone,
      variations,
    };
  });
}

// ── Landing page personas ──────────────────────────────────────

export function personaLandingPages(ctx: CreativeContext, seed: number) {
  const rng = mulberry32(seed);
  const product = productName(ctx.video);
  return topPersonas(ctx, 3).map(({ key, affinity, meta }) => ({
    persona: key,
    personaLabel: meta.label,
    affinity,
    headline: pick(rng, meta.landingHeadlines)(product),
    heroCopy: pick(rng, meta.hooks)(product),
    proofElement: meta.landingProof,
    offerIdea: meta.landingOffer,
  }));
}
