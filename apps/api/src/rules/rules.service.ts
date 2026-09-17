import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Env } from '../config/env.validation';
import { DEFAULT_RULES, reduceToWeights, Rule, RuleWeights } from './rule-defaults';

/**
 * Rule Editor backend — canonical storage is
 * `${CREATIVE_INTELLIGENCE_DATA_DIR}/rules/rules.json` on the filesystem
 * (per the user's explicit instruction), not the database. Cached in memory
 * after the first read; every write refreshes the cache so the Tribe v2
 * scoring engine (pipeline.processor.ts's runTribeAnalysis) always reads
 * live weights without a DB round trip.
 *
 * This service currently exposes only what the scoring engine needs
 * (getWeights). CRUD endpoints (add/edit/toggle a rule) and the rescore
 * trigger are added on top of this same service in Milestone 6 — brought
 * forward here because runTribeAnalysis (Milestone 4) already needs live
 * weights instead of hardcoded constants.
 */
@Injectable()
export class RulesService implements OnModuleInit {
  private readonly logger = new Logger(RulesService.name);
  private readonly rulesFilePath: string;
  private cache: Rule[] | null = null;

  constructor(config: ConfigService<Env, true>) {
    const dataDir = config.get('CREATIVE_INTELLIGENCE_DATA_DIR', { infer: true });
    this.rulesFilePath = path.join(dataDir, 'rules', 'rules.json');
  }

  async onModuleInit(): Promise<void> {
    await this.load();
  }

  async getRules(): Promise<Rule[]> {
    if (!this.cache) await this.load();
    return this.cache!;
  }

  async getWeights(): Promise<RuleWeights> {
    return reduceToWeights(await this.getRules());
  }

  async saveRules(rules: Rule[]): Promise<void> {
    await fs.mkdir(path.dirname(this.rulesFilePath), { recursive: true });
    await fs.writeFile(this.rulesFilePath, JSON.stringify(rules, null, 2), 'utf-8');
    this.cache = rules;
  }

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.rulesFilePath, 'utf-8');
      this.cache = JSON.parse(raw) as Rule[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.logger.log(
          `No rules.json found at ${this.rulesFilePath} — seeding defaults from ANALYSIS_RULES.md`,
        );
        await this.saveRules(DEFAULT_RULES);
      } else {
        this.logger.error(
          `Failed to read ${this.rulesFilePath}, using in-memory defaults: ${(err as Error).message}`,
        );
        this.cache = DEFAULT_RULES;
      }
    }
  }
}
