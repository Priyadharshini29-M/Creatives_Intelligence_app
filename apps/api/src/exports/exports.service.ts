import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import * as path from 'path';
import PDFDocument from 'pdfkit';
import { AuthenticatedUser } from '../auth/auth.types';
import { Env } from '../config/env.validation';
import { ReportsService, VideoReport } from '../reports/reports.service';

export interface ExportResult {
  filePath: string;
  content: Buffer;
}

@Injectable()
export class ExportsService {
  private readonly dataDir: string;

  constructor(
    private readonly reports: ReportsService,
    config: ConfigService<Env, true>,
  ) {
    this.dataDir = config.get('CREATIVE_INTELLIGENCE_DATA_DIR', { infer: true });
  }

  async exportJson(user: AuthenticatedUser, videoId: string): Promise<ExportResult> {
    const report = await this.reports.getReport(user, videoId);
    const content = Buffer.from(JSON.stringify(report, null, 2), 'utf-8');
    const filePath = await this.writeExportFile(videoId, 'report.json', content);
    return { filePath, content };
  }

  async exportPdf(user: AuthenticatedUser, videoId: string): Promise<ExportResult> {
    const report = await this.reports.getReport(user, videoId);
    const content = await this.renderPdf(report);
    const filePath = await this.writeExportFile(videoId, 'report.pdf', content);
    return { filePath, content };
  }

  private async writeExportFile(
    videoId: string,
    filename: string,
    content: Buffer,
  ): Promise<string> {
    const dir = path.join(this.dataDir, 'exports', videoId);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, filename);
    await fs.writeFile(filePath, content);
    return filePath;
  }

  /** Renders the report as a one-page PDF brief — score cards, attention
   * signals, copy corrections, and next actions.
   *
   * Doesn't (yet) include the Meta 10-point ad-standards checklist from
   * creative-approval-score/src/app.js's evaluateMetaChecklist — that's a
   * separate, fairly elaborate rubric (authentic-visuals check, payload
   * size, format/duration norms, etc.) this pipeline hasn't ported. Flagged
   * as a known gap rather than half-rendered with fabricated pass/fail
   * results.
   */
  private renderPdf(report: VideoReport): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50 });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const pct = (v: number | null) => (v != null ? `${v.toFixed(1)}` : 'N/A');
      const pct100 = (v: number | null) => (v != null ? `${(v * 100).toFixed(1)}%` : 'N/A');

      doc.fontSize(20).fillColor('#000').text(report.video.title);
      doc
        .fontSize(10)
        .fillColor('#666')
        .text(`${report.video.mediaType} · ${report.video.targetPlatform} · ${report.video.status}`);
      doc.moveDown(1.5);

      doc.fillColor('#000').fontSize(14).text('Score Cards');
      doc.fontSize(11);
      doc.text(`Approval Score: ${pct(report.scoreCards.approvalScore)}`);
      doc.text(`Meta Ad Score: ${pct(report.scoreCards.metaAdScore)}`);
      doc.text(`Creative Quality (60%): ${pct(report.scoreCards.creativeQuality)}`);
      doc.text(`Audience & Persona Fit (30%): ${pct(report.scoreCards.audienceFit)}`);
      doc.text(`Conversion Safety (10%): ${pct(report.scoreCards.conversionSafety)}`);
      if (report.scoreCards.roasEstimatePct != null) {
        doc.text(`Predicted ROAS Lift: ${report.scoreCards.roasEstimatePct.toFixed(1)}%`);
      }
      doc.moveDown(1);

      doc.fontSize(14).text('Attention Signals');
      doc.fontSize(11);
      doc.text(`Attention Peak: ${pct100(report.signals.attentionPeak)}`);
      doc.text(
        `Human Gate: ${
          report.signals.humanGatePassed == null
            ? 'N/A'
            : report.signals.humanGatePassed
              ? 'Passed'
              : 'Failed (score capped)'
        }`,
      );
      doc.text(`Claim Safety Risk: ${report.signals.claimSafetyRisk ?? 'N/A'}`);
      doc.text(`60/30/10 Colour Balance: ${pct100(report.signals.colourBalanceScore)}`);
      doc.moveDown(1);

      if (report.copyCorrections.length > 0) {
        doc.fontSize(14).text('Copy Corrections');
        doc.fontSize(11);
        for (const c of report.copyCorrections) doc.text(`• ${c}`);
        doc.moveDown(1);
      }

      if (report.nextActions.length > 0) {
        doc.fontSize(14).text('Next Actions');
        doc.fontSize(11);
        for (const a of report.nextActions) doc.text(`• ${a}`);
      }

      doc.end();
    });
  }
}
