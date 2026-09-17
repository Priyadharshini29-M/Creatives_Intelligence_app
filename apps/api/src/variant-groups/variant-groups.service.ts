import { Injectable, NotFoundException } from '@nestjs/common';
import { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { CreateVariantGroupDto } from './dto/create-variant-group.dto';

@Injectable()
export class VariantGroupsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(user: AuthenticatedUser, dto: CreateVariantGroupDto) {
    return this.prisma.variantGroup.create({
      data: { name: dto.name, teamId: user.teamId },
    });
  }

  async list(user: AuthenticatedUser) {
    return this.prisma.variantGroup.findMany({
      where: { teamId: user.teamId },
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { videos: true } },
        // Just enough per video to pick a best-performer badge on the list
        // card — the full comparison (all predictions/recommendations)
        // only loads on the group detail page.
        videos: {
          select: {
            id: true,
            title: true,
            variantLabel: true,
            predictions: { where: { kind: 'ENGAGEMENT' }, select: { score: true } },
          },
        },
      },
    });
  }

  /** Group + every variant with the analytics/predictions/recommendations
   * needed to compare them side by side in a single request. */
  async getById(user: AuthenticatedUser, groupId: string) {
    const group = await this.prisma.variantGroup.findFirst({
      where: { id: groupId, teamId: user.teamId },
      include: {
        videos: {
          orderBy: { createdAt: 'asc' },
          include: {
            analytics: true,
            predictions: true,
            recommendations: { orderBy: { priority: 'desc' } },
          },
        },
      },
    });
    if (!group) throw new NotFoundException('Variant group not found');
    return group;
  }
}
