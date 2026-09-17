import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { ChatService } from './chat.service';

class SendMessageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  content!: string;
}

@Controller('chat/sessions')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.chat.listSessions(user);
  }

  @Post()
  create(@CurrentUser() user: AuthenticatedUser) {
    return this.chat.createSession(user);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.chat.getSession(user, id);
  }

  @Post(':id/messages')
  send(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: SendMessageDto,
  ) {
    return this.chat.sendMessage(user, id, body.content);
  }
}
