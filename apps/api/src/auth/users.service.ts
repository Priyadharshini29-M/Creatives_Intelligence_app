import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from './auth.types';
import { VerifiedIdentity } from './auth-client.service';

const DEV_USER = {
  supabaseId: 'dev_local_user',
  email: 'dev@digifyce.local',
  firstName: 'Dev',
  lastName: 'User',
};

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Find-or-create the platform user for a verified Supabase session, along
   * with a personal team + subscription on first sign-in. Supabase doesn't
   * split first/last name out of the access token the way Clerk's claims
   * did, so those start null and get filled in from Settings later.
   */
  async resolveFromSupabaseUser(
    identity: VerifiedIdentity,
  ): Promise<AuthenticatedUser> {
    if (!identity.sub) throw new UnauthorizedException('Token has no subject');

    return this.findOrProvision({
      supabaseId: identity.sub,
      email: identity.email ?? `${identity.sub}@unknown.supabase`,
      firstName: null,
      lastName: null,
    });
  }

  async resolveDevUser(): Promise<AuthenticatedUser> {
    return this.findOrProvision({ ...DEV_USER });
  }

  private async findOrProvision(input: {
    supabaseId: string;
    email: string;
    firstName?: string | null;
    lastName?: string | null;
  }): Promise<AuthenticatedUser> {
    const existing = await this.prisma.user.findUnique({
      where: { supabaseId: input.supabaseId },
      include: { memberships: { take: 1, orderBy: { joinedAt: 'asc' } } },
    });

    if (existing && existing.memberships.length > 0) {
      return {
        id: existing.id,
        supabaseId: existing.supabaseId,
        email: existing.email,
        teamId: existing.memberships[0].teamId,
        role: existing.memberships[0].role,
      };
    }

    // First sign-in: provision user + personal team + subscription atomically.
    const user = await this.prisma.$transaction(async (tx) => {
      const user =
        existing ??
        (await tx.user.create({
          data: {
            supabaseId: input.supabaseId,
            email: input.email,
            firstName: input.firstName,
            lastName: input.lastName,
          },
        }));

      const team = await tx.team.create({
        data: {
          name: input.firstName ? `${input.firstName}'s Team` : 'Personal Team',
          slug: `team-${user.id.slice(-8)}`,
          members: { create: { userId: user.id, role: 'OWNER' } },
          subscription: { create: {} },
        },
      });

      return { user, teamId: team.id };
    });

    return {
      id: user.user.id,
      supabaseId: user.user.supabaseId,
      email: user.user.email,
      teamId: user.teamId,
      role: 'OWNER',
    };
  }
}
