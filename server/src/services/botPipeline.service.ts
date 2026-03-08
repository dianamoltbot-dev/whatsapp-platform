import { BotConfig } from '@prisma/client';
import { prisma } from '../config/database';
import { getIO } from '../config/socket';
import { llmService, AiProvider } from './llm.service';
import { whatsappService, ParsedIncomingMessage } from './whatsapp.service';
import { wasenderService } from './wasender.service';
import { conversationService } from './conversation.service';
import { WhatsAppCredentials } from '../types';

function getBotCredentials(botConfig: BotConfig): WhatsAppCredentials | null {
  if (!botConfig.whatsappPhoneNumberId || !botConfig.whatsappApiToken) {
    return null;
  }
  return {
    phoneNumberId: botConfig.whatsappPhoneNumberId,
    apiToken: botConfig.whatsappApiToken,
    verifyToken: botConfig.whatsappVerifyToken ?? '',
    businessAccountId: botConfig.whatsappBusinessAccountId ?? undefined,
  };
}

export class BotPipelineService {
  // Track processed message IDs to prevent duplicates from Meta webhook retries
  private processedMessages = new Set<string>();

  async processIncomingMessage(incoming: ParsedIncomingMessage) {
    // Deduplicate: skip if we already processed this message
    if (this.processedMessages.has(incoming.messageId)) {
      console.log(`Skipping duplicate message: ${incoming.messageId}`);
      return null;
    }
    this.processedMessages.add(incoming.messageId);

    // Clean up old entries (keep last 1000)
    if (this.processedMessages.size > 1000) {
      const entries = Array.from(this.processedMessages);
      entries.slice(0, entries.length - 1000).forEach(id => this.processedMessages.delete(id));
    }

    // Also check database for duplicates (in case server restarted)
    const existingMsg = await prisma.message.findFirst({
      where: { waMessageId: incoming.messageId },
    });
    if (existingMsg) {
      console.log(`Skipping already-stored message: ${incoming.messageId}`);
      return null;
    }

    // 1. Find which bot this message is for based on recipient phone number
    const botConfig = await prisma.botConfig.findFirst({
      where: { whatsappPhoneNumberId: incoming.recipientPhoneNumberId },
      include: { organization: true },
    });

    if (!botConfig) {
      console.error(`No bot found for phone number ID: ${incoming.recipientPhoneNumberId}`);
      return null;
    }

    // 2. Find or create client and conversation scoped to organization
    const { client, conversation } = await conversationService.findOrCreateForClient(
      incoming.from,
      incoming.contactName,
      botConfig.organizationId,
      botConfig.id
    );

    // 3. Store incoming message
    const incomingMsg = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        senderType: 'CLIENT',
        content: incoming.text,
        waMessageId: incoming.messageId,
        timestamp: new Date(parseInt(incoming.timestamp) * 1000),
      },
    });

    // 4. Update conversation timestamp
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() },
    });

    // 5. Emit real-time event for the new message
    const io = getIO();
    io.to(`conversation:${conversation.id}`).emit('new_message', {
      ...incomingMsg,
      conversation: { id: conversation.id, clientId: client.id },
    });
    io.emit('conversation_updated', {
      conversationId: conversation.id,
      lastMessage: incomingMsg,
      client,
    });

    // 6. If in BOT mode, generate and send AI response
    if (conversation.mode === 'BOT') {
      await this.generateBotResponse(conversation.id, client.phoneNumber, botConfig);
    }

    return { client, conversation, message: incomingMsg };
  }

  async generateBotResponse(conversationId: string, phoneNumber: string, botConfig: BotConfig) {
    const credentials = getBotCredentials(botConfig);

    // Check if we have any way to send (Cloud API or WaSender)
    const hasCloudAPI = !!credentials;
    const hasWaSender = !!wasenderService;

    if (!hasCloudAPI && !hasWaSender) {
      console.warn('No WhatsApp sending method available');
      return null;
    }

    // Get conversation history for context
    const recentMessages = await prisma.message.findMany({
      where: { conversationId },
      orderBy: { timestamp: 'desc' },
      take: 20,
    });

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: botConfig.systemPrompt },
    ];

    // Add messages in chronological order
    for (const msg of recentMessages.reverse()) {
      messages.push({
        role: msg.senderType === 'CLIENT' ? 'user' : 'assistant',
        content: msg.content,
      });
    }

    // Generate AI response using configured provider
    const aiResult = await llmService.generateResponse({
      messages,
      model: botConfig.model,
      temperature: botConfig.temperature,
      maxTokens: botConfig.maxTokens,
      provider: (botConfig.aiProvider as AiProvider) || 'openai',
      apiKey: botConfig.aiApiKey || null,
    });

    // Send via WhatsApp — Cloud API first, then WaSender fallback
    let waMessageId: string | null = null;
    if (hasCloudAPI) {
      waMessageId = await whatsappService.sendMessage(phoneNumber, aiResult.content, credentials!);
    } else {
      waMessageId = await wasenderService.sendText(phoneNumber, aiResult.content);
    }

    // Store bot response
    const botMessage = await prisma.message.create({
      data: {
        conversationId,
        senderType: 'BOT',
        content: aiResult.content,
        waMessageId,
      },
    });

    // Record token usage
    await llmService.recordTokenUsage(conversationId, botMessage.id, aiResult);

    // Emit real-time event
    const io = getIO();
    io.to(`conversation:${conversationId}`).emit('new_message', botMessage);
    io.emit('conversation_updated', {
      conversationId,
      lastMessage: botMessage,
    });

    return botMessage;
  }

  async sendAgentMessage(conversationId: string, content: string, agentId: string) {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { client: true, botConfig: true },
    });

    if (!conversation) {
      throw new Error('Conversation not found');
    }

    // Try sending via WhatsApp — Cloud API first, then Web fallback
    const credentials = conversation.botConfig ? getBotCredentials(conversation.botConfig) : null;

    let waMessageId: string | null = null;
    if (credentials) {
      // Send via Cloud API
      waMessageId = await whatsappService.sendMessage(
        conversation.client.phoneNumber,
        content,
        credentials
      );
    } else {
      // Fallback to WaSender
      waMessageId = await wasenderService.sendText(
        conversation.client.phoneNumber,
        content
      );
    }

    // Store agent message
    const agentMessage = await prisma.message.create({
      data: {
        conversationId,
        senderType: 'AGENT',
        content,
        waMessageId,
        metadata: { agentId },
      },
    });

    // Update conversation
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });

    // Emit real-time event
    const io = getIO();
    io.to(`conversation:${conversationId}`).emit('new_message', agentMessage);
    io.emit('conversation_updated', {
      conversationId,
      lastMessage: agentMessage,
    });

    return agentMessage;
  }
}

export const botPipelineService = new BotPipelineService();
