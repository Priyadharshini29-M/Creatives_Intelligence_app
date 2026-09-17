import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthenticatedUser } from '../auth/auth.types';
import { Env } from '../config/env.validation';
import { AnalysisResult } from '../jobs/ai-client.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  adKeywords,
  adVariations,
  CreativeContext,
  personaLandingPages,
  primaryText,
  productName,
  retentionIdeas,
} from './creative.engine';

/** Shape returned by the AI service's /v1/web/analyze endpoint. */
export interface PageAnalysis {
  url: string;
  title: string;
  meta_description: string;
  h1: string[];
  h2: string[];
  image_count: number;
  has_price: boolean;
  cta_found: string[];
  word_count: number;
  matched_keywords: string[];
  missing_keywords: string[];
  relevance: number | null;
}

@Injectable()
export class CreativeService {
  private readonly aiServiceUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.aiServiceUrl = config.get('AI_SERVICE_URL', { infer: true });
  }

  private async context(user: AuthenticatedUser, videoId: string): Promise<CreativeContext> {
    const video = await this.prisma.video.findFirst({
      where: { id: videoId, teamId: user.teamId },
      include: { analytics: true, team: { select: { niche: true } } },
    });
    if (!video) throw new NotFoundException('Video not found');
    return {
      video,
      analytics: video.analytics,
      analysis: (video.analytics?.rawAnalysis ?? {}) as AnalysisResult,
      niche: video.team.niche,
    };
  }

  /** Primary text + retention ideas + persona ad variations, one payload.
   * The seed drives template selection — the UI's "Regenerate" sends a new
   * one for a fresh recombination over the same grounded facts. */
  async brief(user: AuthenticatedUser, videoId: string, seed: number) {
    const ctx = await this.context(user, videoId);
    return {
      product: productName(ctx.video),
      primaryText: primaryText(ctx, seed),
      retentionIdeas: retentionIdeas(ctx, seed),
      adVariations: adVariations(ctx, seed),
      seed,
      generator: 'grounded-templates-v1', // becomes the LLM model id later
    };
  }

  /** Fetch + analyze a landing/product page against this video's ad content. */
  async landingPage(user: AuthenticatedUser, videoId: string, url: string, seed: number) {
    const ctx = await this.context(user, videoId);
    const keywords = adKeywords(ctx);

    const res = await fetch(`${this.aiServiceUrl}/v1/web/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, keywords }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = `Page analysis failed (${res.status})`;
      try {
        detail = (JSON.parse(text) as { detail?: string }).detail ?? detail;
      } catch {
        // keep default
      }
      throw new NotFoundException(detail);
    }
    const page = JSON.parse(text) as PageAnalysis;

    const product = productName(ctx.video);
    const hook = primaryText(ctx, seed).caption.hook;
    const enhancements: { title: string; detail: string; basis: string }[] = [];

    if (page.relevance != null && page.relevance < 0.5) {
      enhancements.push({
        title: 'Page and ad are talking about different things',
        detail: `The page never mentions: ${page.missing_keywords.join(', ')}. Mirror the ad's wording in the hero section so visitors instantly recognize what they clicked.`,
        basis: `Only ${page.matched_keywords.length}/${page.matched_keywords.length + page.missing_keywords.length} ad keywords found on the page.`,
      });
    }
    enhancements.push({
      title: 'Mirror the ad hook in the hero',
      detail: `Use the ad's opening line (“${hook}”) — or the video's first frame — as the hero headline/visual so the scent from ad to page is unbroken.`,
      basis: 'Ad-to-page message match is the strongest post-click conversion lever.',
    });
    if (page.cta_found.length === 0) {
      enhancements.push({
        title: 'No clear call-to-action found',
        detail: 'Add a primary button (e.g. “Add to cart”) visible without scrolling, and repeat it after the proof section.',
        basis: 'None of the standard CTA phrases were found in the page copy.',
      });
    }
    if (!page.has_price) {
      enhancements.push({
        title: 'Show the price up front',
        detail: `Display ${product}'s price near the primary CTA — hiding it adds friction and inflates bounce.`,
        basis: 'No price pattern was detected on the page.',
      });
    }
    if (page.h1.length === 0) {
      enhancements.push({
        title: 'Add a product headline (H1)',
        detail: `The page has no top-level heading. Add one naming ${product} and its main benefit.`,
        basis: 'No <h1> element was found.',
      });
    }
    if (page.image_count < 3) {
      enhancements.push({
        title: 'Add visuals from the ad',
        detail: 'Reuse the video (or its strongest frames) on the page — visitors should see the same product moment that stopped their scroll.',
        basis: `Only ${page.image_count} image${page.image_count === 1 ? '' : 's'} detected on the page.`,
      });
    }
    if (page.word_count < 150) {
      enhancements.push({
        title: 'Thin page content',
        detail: 'Add benefit bullets, usage steps, and an FAQ so the page can answer objections the ad creates.',
        basis: `Page body is only ~${page.word_count} words.`,
      });
    }

    return {
      page,
      keywords,
      enhancements,
      personaPages: personaLandingPages(ctx, seed),
    };
  }
}
