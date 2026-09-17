import { Prediction, PredictionKind, Recommendation, Video, VideoAnalytics } from '@vip/database';
import { AnalysisResult } from '../jobs/ai-client.service';

export interface StrategistContext {
  videos: (Video & {
    analytics: VideoAnalytics | null;
    predictions: Prediction[];
    recommendations: Recommendation[];
  })[];
}

export interface StrategistReply {
  content: string;
  citations: { videoId: string; title: string }[];
}

type ContextVideo = StrategistContext['videos'][number];

const pct = (v: number | null | undefined) =>
  v == null ? '—' : `${(v * 100).toFixed(1)}%`;
const score = (video: ContextVideo, kind: PredictionKind) =>
  video.predictions.find((p) => p.kind === kind)?.score ?? null;
const fmtScore = (v: number | null) => (v == null ? '—' : `${Math.round(v)}/100`);

/**
 * Deterministic strategist: routes the question to the relevant slice of the
 * team's stored analysis and answers with the actual numbers. No text is
 * generated that is not backed by pipeline output — swap in an LLM later by
 * feeding it the same grounded context.
 */
export function answer(question: string, ctx: StrategistContext): StrategistReply {
  const q = question.toLowerCase();

  if (ctx.videos.length === 0) {
    return {
      content:
        'No analyzed videos yet — upload a video and run the pipeline, then ask me about its hook, retention, audience, conversion, or best platform.',
      citations: [],
    };
  }

  // Video reference: a title substring in the question, else the latest.
  const video =
    ctx.videos.find((v) => q.includes(v.title.toLowerCase().slice(0, 12))) ??
    ctx.videos[0];
  const analysis = (video.analytics?.rawAnalysis ?? {}) as AnalysisResult;
  const citations = [{ videoId: video.id, title: video.title }];

  if (/(retention|drop|watch time|hold)/.test(q)) {
    const curve = analysis.retention?.timeline ?? [];
    const worst = [...curve].sort((a, b) => b.drop_prob - a.drop_prob)[0];
    const pacingRecs = video.recommendations.filter((r) => r.kind === 'PACING');
    return {
      content: [
        `Retention for “${video.title}”: ${pct(video.analytics?.hookRate)} of viewers survive the first 3 seconds and ${pct(video.analytics?.holdRate)} are predicted to reach the end (avg. play time ${video.analytics?.avgPlayTimeSec ?? '—'}s).`,
        worst
          ? `The riskiest moment is around ${worst.timestamp.toFixed(1)}s, where the per-interval drop hazard peaks at ${pct(worst.drop_prob)} — usually a static or low-motion stretch.`
          : null,
        pacingRecs.length > 0
          ? `Pipeline suggestion: ${pacingRecs[0].body}`
          : 'No pacing red flags were raised for this video.',
      ]
        .filter(Boolean)
        .join('\n\n'),
      citations,
    };
  }

  if (/(hook|opening|first 3|start)/.test(q)) {
    const hook = analysis.hook;
    return {
      content: [
        `Hook score for “${video.title}”: ${fmtScore(score(video, PredictionKind.HOOK))}. ${pct(video.analytics?.hookRate)} of viewers are predicted to stay past the 3-second window.`,
        hook?.issues?.length
          ? `Issues found: ${hook.issues.join('; ')}.`
          : 'No structural issues were detected in the opening seconds.',
        hook?.recommendations?.length
          ? `To improve it: ${hook.recommendations.join(' ')}`
          : null,
      ]
        .filter(Boolean)
        .join('\n\n'),
      citations,
    };
  }

  if (/(conver|cta|purchase|sale|buy)/.test(q)) {
    const conversion = analysis.conversion;
    const ctaRecs = video.recommendations.filter((r) => r.kind === 'CTA');
    return {
      content: [
        `Conversion score for “${video.title}”: ${fmtScore(score(video, PredictionKind.CONVERSION))}.`,
        conversion?.reasons?.length
          ? `Weak signals flagged: ${conversion.reasons.join('; ')}.`
          : 'The model flagged no conversion blockers.',
        ctaRecs.length > 0 ? `Suggested fixes: ${ctaRecs.map((r) => r.body).join(' ')}` : null,
      ]
        .filter(Boolean)
        .join('\n\n'),
      citations,
    };
  }

  if (/(platform|tiktok|instagram|reels|shorts|snapchat|facebook|where)/.test(q)) {
    const breakdown =
      (video.predictions.find((p) => p.kind === PredictionKind.PLATFORM_COMPATIBILITY)
        ?.breakdown ?? {}) as Record<string, number>;
    const ranked = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);
    if (ranked.length === 0) {
      return {
        content: `No platform compatibility scores exist yet for “${video.title}” — re-run the analysis to generate them.`,
        citations,
      };
    }
    return {
      content: [
        `Platform fit for “${video.title}” (targeting ${video.targetPlatform.replace('_', ' ')}):`,
        ranked
          .map(([platform, s]) => `• ${platform.replace('_', ' ')}: ${Math.round(s)}/100`)
          .join('\n'),
        `Best fit: ${ranked[0][0].replace('_', ' ')} — driven by format, duration fit against the platform norm, and measured hook/retention.`,
      ].join('\n\n'),
      citations,
    };
  }

  if (/(audience|tribe|who|segment|demographic)/.test(q)) {
    const segments = (video.analytics?.audienceSegments ?? {}) as Record<string, number>;
    const ranked = Object.entries(segments).sort((a, b) => b[1] - a[1]);
    if (ranked.length === 0) {
      return {
        content: `No audience segmentation exists yet for “${video.title}” — re-run the analysis to generate it.`,
        citations,
      };
    }
    const signals = analysis.tribe?.signals ?? [];
    return {
      content: [
        `Top audience tribes for “${video.title}”:`,
        ranked
          .slice(0, 3)
          .map(([seg, a]) => `• ${seg.replace(/_/g, ' ')}: ${pct(a)} relative affinity`)
          .join('\n'),
        signals.length > 0 ? `Why: ${signals.slice(0, 3).join('; ')}.` : null,
      ]
        .filter(Boolean)
        .join('\n\n'),
      citations,
    };
  }

  if (/(emotion|sentiment|feel|mood)/.test(q)) {
    const emotions = (analysis.sentiment?.emotions ?? {}) as Record<string, number>;
    const ranked = Object.entries(emotions).sort((a, b) => b[1] - a[1]);
    return {
      content:
        ranked.length > 0
          ? `Emotional profile of “${video.title}”: ${ranked
              .slice(0, 4)
              .map(([emotion, v]) => `${emotion} ${pct(v)}`)
              .join(', ')}. Emotional impact score: ${fmtScore(score(video, PredictionKind.EMOTIONAL_IMPACT))}.`
          : `No sentiment data exists yet for “${video.title}”.`,
      citations,
    };
  }

  // Default: overview of the referenced video.
  return {
    content: [
      `“${video.title}” at a glance — engagement ${fmtScore(score(video, PredictionKind.ENGAGEMENT))}, hook ${fmtScore(score(video, PredictionKind.HOOK))}, retention ${fmtScore(score(video, PredictionKind.RETENTION))}, conversion ${fmtScore(score(video, PredictionKind.CONVERSION))}.`,
      `${pct(video.analytics?.hookRate)} survive the hook window and ${pct(video.analytics?.holdRate)} reach the end.`,
      video.recommendations.length > 0
        ? `Top suggestion: ${video.recommendations[0].title} — ${video.recommendations[0].body}`
        : 'No open suggestions for this video.',
      `Ask me about its retention, hook, conversion, audience tribes, emotions, or best platform.`,
    ].join('\n\n'),
    citations,
  };
}
