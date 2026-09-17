import { Injectable, NotFoundException } from '@nestjs/common';
import { ChatRole, VideoStatus } from '@vip/database';
import { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { answer } from './strategist.engine';

@Injectable()
export class ChatService {
  constructor(private readonly prisma: PrismaService) {}

  listSessions(user: AuthenticatedUser) {
    return this.prisma.chatSession.findMany({
      where: { userId: user.id },
      orderBy: { updatedAt: 'desc' },
      take: 30,
    });
  }

  createSession(user: AuthenticatedUser) {
    return this.prisma.chatSession.create({ data: { userId: user.id } });
  }

  async getSession(user: AuthenticatedUser, id: string) {
    const session = await this.prisma.chatSession.findFirst({
      where: { id, userId: user.id },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!session) throw new NotFoundException('Chat session not found');
    return session;
  }

  async sendMessage(user: AuthenticatedUser, sessionId: string, content: string) {
    const session = await this.getSession(user, sessionId); // ownership check
    const isFirstMessage = session.messages.length === 0;

    const videos = await this.prisma.video.findMany({
      where: { teamId: user.teamId, status: VideoStatus.ANALYZED },
      orderBy: { createdAt: 'desc' },
      include: {
        analytics: true,
        predictions: true,
        recommendations: { orderBy: { priority: 'desc' } },
      },
    });

    const reply = answer(content, { videos });

    const [userMessage, assistantMessage] = await this.prisma.$transaction([
      this.prisma.chatMessage.create({
        data: { sessionId, role: ChatRole.USER, content },
      }),
      this.prisma.chatMessage.create({
        data: {
          sessionId,
          role: ChatRole.ASSISTANT,
          content: reply.content,
          citations: reply.citations,
        },
      }),
      this.prisma.chatSession.update({
        where: { id: sessionId },
        data: {
          updatedAt: new Date(),
          // First user message names the session.
          ...(isFirstMessage ? { title: content.slice(0, 60) } : {}),
        },
      }),
    ]);

    return { userMessage, assistantMessage };
  }
}
