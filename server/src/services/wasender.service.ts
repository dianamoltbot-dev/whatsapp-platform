/**
 * WaSenderAPI Service
 * Replaces Baileys (whatsappWeb.service.ts) with WaSenderAPI REST calls.
 *
 * WaSenderAPI handles: QR, sessions, reconnection, IP management, rate limits.
 * We handle: sending messages via their API, receiving via webhook, AI pipeline.
 *
 * Docs: https://wasenderapi.com/api-docs
 * API Base: https://app.wasenderapi.com/api
 */

import { prisma } from '../config/database';
import { getIO } from '../config/socket';
import { env } from '../config/env';

const WASENDER_API_BASE = 'https://app.wasenderapi.com/api';

interface WaSenderSendResponse {
  success: boolean;
  messageId?: string;
  error?: string;
}

interface WaSenderWebhookMessage {
  id: string;
  from: string;
  fromName?: string;
  to: string;
  body: string;
  type: string;
  timestamp: number;
  isGroup: boolean;
  [key: string]: any;  // Allow additional dynamic fields from webhook
}

export class WaSenderService {
  private apiKey: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey || env.WASENDER_API_KEY || '';
  }

  setApiKey(key: string) {
    this.apiKey = key;
  }

  private get headers() {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
  }

  /**
   * Send a text message
   */
  async sendText(to: string, text: string): Promise<string | null> {
    try {
      // Ensure number format (no + prefix, just digits)
      const phone = to.replace(/[^0-9]/g, '');

      const response = await fetch(`${WASENDER_API_BASE}/send-message`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          to: phone,
          text: text,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        console.error('[WaSender] Send error:', response.status, errorBody);
        return null;
      }

      const data = await response.json() as WaSenderSendResponse;
      console.log(`[WaSender] Message sent to ${phone}, id: ${data.messageId}`);
      return data.messageId || `wasender_${Date.now()}`;
    } catch (err) {
      console.error('[WaSender] Send exception:', err);
      return null;
    }
  }

  /**
   * Send an image with optional caption
   */
  async sendImage(to: string, imageUrl: string, caption?: string): Promise<string | null> {
    try {
      const phone = to.replace(/[^0-9]/g, '');

      const response = await fetch(`${WASENDER_API_BASE}/send-image`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          to: phone,
          image: imageUrl,
          caption: caption || '',
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        console.error('[WaSender] Send image error:', response.status, errorBody);
        return null;
      }

      const data = await response.json() as WaSenderSendResponse;
      return data.messageId || null;
    } catch (err) {
      console.error('[WaSender] Send image exception:', err);
      return null;
    }
  }

  /**
   * Send a document
   */
  async sendDocument(to: string, documentUrl: string, filename?: string): Promise<string | null> {
    try {
      const phone = to.replace(/[^0-9]/g, '');

      const response = await fetch(`${WASENDER_API_BASE}/send-document`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          to: phone,
          document: documentUrl,
          filename: filename || 'document',
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        console.error('[WaSender] Send document error:', response.status, errorBody);
        return null;
      }

      const data = await response.json() as WaSenderSendResponse;
      return data.messageId || null;
    } catch (err) {
      console.error('[WaSender] Send document exception:', err);
      return null;
    }
  }

  /**
   * Process incoming webhook from WaSenderAPI
   * This is called when WaSender receives a message on your number
   */
  async processWebhook(payload: any): Promise<void> {
    try {
      // WaSenderAPI webhook payload structure
      const message = {
        id: String(payload.id || payload.messageId || `wa_${Date.now()}`),
        from: String(payload.from || payload.sender || ''),
        fromName: String(payload.fromName || payload.pushName || payload.senderName || ''),
        to: String(payload.to || payload.recipient || ''),
        body: String(payload.body || payload.text || payload.message || ''),
        type: String(payload.type || 'text'),
        timestamp: Number(payload.timestamp || Math.floor(Date.now() / 1000)),
        isGroup: Boolean(payload.isGroup),
        groupId: String(payload.groupId || ''),
        groupName: String(payload.groupName || ''),
      };

      // Skip non-text for now (can extend later)
      if (message.type !== 'text' || !message.body) {
        console.log(`[WaSender] Skipping non-text message type: ${message.type}`);
        return;
      }

      // Skip group messages (can enable later)
      if (message.isGroup) {
        console.log(`[WaSender] Skipping group message from ${message.groupName}`);
        return;
      }

      // Clean phone number
      const from = message.from.replace(/[^0-9]/g, '');
      console.log(`[WaSender] Incoming from ${from} (${message.fromName}): ${message.body.substring(0, 80)}...`);

      // Find active bot config for this organization
      // For now, use the first active bot config
      const botConfig = await prisma.botConfig.findFirst({
        where: { isActive: true },
        include: { organization: true },
      });

      if (!botConfig) {
        console.warn('[WaSender] No active bot config found');
        return;
      }

      // Import conversation service
      const { conversationService } = await import('./conversation.service');

      // Find or create client and conversation
      const { client, conversation } = await conversationService.findOrCreateForClient(
        from,
        message.fromName,
        botConfig.organizationId,
        botConfig.id
      );

      // Check for duplicate message
      const existingMsg = await prisma.message.findFirst({
        where: { waMessageId: message.id },
      });
      if (existingMsg) {
        console.log(`[WaSender] Duplicate message ${message.id}, skipping`);
        return;
      }

      // Store incoming message
      const incomingMsg = await prisma.message.create({
        data: {
          conversationId: conversation.id,
          senderType: 'CLIENT',
          content: message.body,
          waMessageId: message.id,
          timestamp: new Date(message.timestamp * 1000),
        },
      });

      // Update conversation
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { updatedAt: new Date() },
      });

      // Emit real-time events
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

      // If BOT mode, generate AI response
      if (conversation.mode === 'BOT') {
        console.log(`[WaSender] Generating bot response for conv ${conversation.id}`);
        await this.generateAndSendResponse(conversation.id, from, botConfig);
      }
    } catch (err) {
      console.error('[WaSender] Webhook processing error:', err);
    }
  }

  /**
   * Generate AI response and send via WaSenderAPI
   */
  private async generateAndSendResponse(
    conversationId: string,
    to: string,
    botConfig: any
  ): Promise<void> {
    const { openaiService } = await import('./openai.service');

    // Get conversation history
    const recentMessages = await prisma.message.findMany({
      where: { conversationId },
      orderBy: { timestamp: 'desc' },
      take: 20,
    });

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: botConfig.systemPrompt },
    ];

    for (const msg of recentMessages.reverse()) {
      messages.push({
        role: msg.senderType === 'CLIENT' ? 'user' : 'assistant',
        content: msg.content,
      });
    }

    // Generate AI response
    console.log(`[WaSender] Calling AI for conv ${conversationId}...`);
    const aiResult = await openaiService.generateResponse({
      messages,
      model: botConfig.model,
      temperature: botConfig.temperature,
      maxTokens: botConfig.maxTokens,
    });
    console.log(`[WaSender] AI response: ${aiResult.content.length} chars`);

    // Send via WaSenderAPI
    const waMessageId = await this.sendText(to, aiResult.content);

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
    await openaiService.recordTokenUsage(conversationId, botMessage.id, aiResult);

    // Emit events
    const io = getIO();
    io.to(`conversation:${conversationId}`).emit('new_message', botMessage);
    io.emit('conversation_updated', {
      conversationId,
      lastMessage: botMessage,
    });
  }

  /**
   * Get connection status from WaSenderAPI
   */
  async getStatus(): Promise<{ connected: boolean; phone?: string }> {
    try {
      const response = await fetch(`${WASENDER_API_BASE}/status`, {
        headers: this.headers,
      });

      if (!response.ok) {
        return { connected: false };
      }

      const data = await response.json() as any;
      return {
        connected: data.connected || data.status === 'connected',
        phone: data.phone || data.phoneNumber,
      };
    } catch {
      return { connected: false };
    }
  }
}

export const wasenderService = new WaSenderService();
