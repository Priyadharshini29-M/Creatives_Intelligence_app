import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { ChatModule } from './chat/chat.module';
import { CreativeModule } from './creative/creative.module';
import { Env, validateEnv } from './config/env.validation';
import { DashboardModule } from './dashboard/dashboard.module';
import { ExportsModule } from './exports/exports.module';
import { InsightsModule } from './insights/insights.module';
import { LanguageIntelligenceModule } from './language-intelligence/language-intelligence.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ReportsModule } from './reports/reports.module';
import { WorkspaceModule } from './workspace/workspace.module';
import { HealthController } from './health/health.controller';
import { JobsModule } from './jobs/jobs.module';
import { PrismaModule } from './prisma/prisma.module';
import { StorageModule } from './storage/storage.module';
import { TrainingModule } from './training/training.module';
import { VariantGroupsModule } from './variant-groups/variant-groups.module';
import { VideosModule } from './videos/videos.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        connection: {
          host: config.get('REDIS_HOST', { infer: true }),
          port: config.get('REDIS_PORT', { infer: true }),
        },
      }),
    }),
    PrismaModule,
    AuthModule,
    StorageModule,
    JobsModule,
    VideosModule,
    VariantGroupsModule,
    DashboardModule,
    NotificationsModule,
    InsightsModule,
    ChatModule,
    WorkspaceModule,
    CreativeModule,
    TrainingModule,
    ReportsModule,
    ExportsModule,
    LanguageIntelligenceModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
