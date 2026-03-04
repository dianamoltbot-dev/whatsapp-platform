import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  WASocket,
  proto,
  makeCacheableSignalKeyStore,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import * as path from 'path';
import * as fs from 'fs';
import * as QRCode from 'qrcode';
import { prisma } from '../config/database';
import { getIO } from '../config/socket';
import { botPipelineService } from './botPipeline.service';

// Minimal pino-compatible logger for Baileys
const logger = {
  level: 'silent' as const,
  info: (..._args: any[]) => {},
  debug: (..._args: any[]) => {},
  warn: (..._args: any[]) => {},
  error: (...args: any[]) => { console.error('[Baileys]', ...args); },
  trace: (..._args: any[]) => {},
  fatal: (...args: any[]) => { console.error('[Baileys FATAL]', ...args); },
  child: () => logger,
};

export type ConnectionStatus = 'disconnected' | 'connecting' | 'qr' | 'connected';

interface WebSession {
  socket: WASocket | null;
  status: ConnectionStatus;
  qrCode: string | null;  // base64 data URI
  botConfigId: string;
  phoneNumber: string | null;
  retryCount: number;
}

class WhatsAppWebService {
  private sessions: Map<string, WebSession> = new Map();
  private authBasePath: string;

  constructor() {
    this.authBasePath = path.join(process.cwd(), '.wa-sessions');
    if (!fs.existsSync(this.authBasePath)) {
      fs.mkdirSync(this.authBasePath, { recursive: true });
    }
  }

  private getAuthPath(botConfigId: string): string {
    return path.join(this.authBasePath, botConfigId);
  }

  getSession(botConfigId: string): WebSession | null {
    return this.sessions.get(botConfigId) || null;
  }

  getStatus(botConfigId: string): { status: ConnectionStatus; qrCode: string | null; phoneNumber: string | null } {
    const session = this.sessions.get(botConfigId);
    if (!session) {
      // Check if auth files exist (previous session)
      const authPath = this.getAuthPath(botConfigId);
      const hasAuth = fs.existsSync(authPath) && fs.readdirSync(authPath).length > 0;
      return {
        status: hasAuth ? 'disconnected' : 'disconnected',
        qrCode: null,
        phoneNumber: null,
      };
    }
    return {
      status: session.status,
      qrCode: session.qrCode,
      phoneNumber: session.phoneNumber,
    };
  }

  async connect(botConfigId: string): Promise<{ status: ConnectionStatus; qrCode: string | null }> {
    // If already connected, return status
    const existing = this.sessions.get(botConfigId);
    if (existing && existing.status === 'connected') {
      return { status: 'connected', qrCode: null };
    }

    // If already connecting/waiting for QR, return current state
    if (existing && (existing.status === 'connecting' || existing.status === 'qr')) {
      return { status: existing.status, qrCode: existing.qrCode };
    }

    // Verify bot config exists
    const botConfig = await prisma.botConfig.findUnique({
      where: { id: botConfigId },
      include: { organization: true },
    });

    if (!botConfig) {
      throw new Error('Bot config not found');
    }

    // Initialize session
    const session: WebSession = {
      socket: null,
      status: 'connecting',
      qrCode: null,
      botConfigId,
      phoneNumber: null,
      retryCount: 0,
    };
    this.sessions.set(botConfigId, session);

    // Emit status update
    this.emitStatus(botConfigId, 'connecting');

    // Start connection
    await this.initSocket(botConfigId);

    return { status: session.status, qrCode: session.qrCode };
  }

  private async initSocket(botConfigId: string): Promise<void> {
    const session = this.sessions.get(botConfigId);
    if (!session) return;

    const authPath = this.getAuthPath(botConfigId);
    const { state, saveCreds } = await useMultiFileAuthState(authPath);

    const socket = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger as any),
      },
      logger: logger as any,
      printQRInTerminal: false,
      generateHighQualityLinkPreview: false,
      defaultQueryTimeoutMs: 60000,
      browser: ['Spark101', 'Chrome', '120.0.0'],
    });

    session.socket = socket;

    // Handle credentials update
    socket.ev.on('creds.update', saveCreds);

    // Handle connection update
    socket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        // Generate QR code as data URI
        try {
          const qrDataUri = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
          session.qrCode = qrDataUri;
          session.status = 'qr';
          this.emitStatus(botConfigId, 'qr', qrDataUri);
          console.log(`[WA-Web] QR code generated for bot ${botConfigId}`);
        } catch (err) {
          console.error('[WA-Web] QR generation error:', err);
        }
      }

      if (connection === 'close') {
        const shouldReconnect =
          (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;

        console.log(`[WA-Web] Connection closed for ${botConfigId}. Reconnect: ${shouldReconnect}`);

        session.status = 'disconnected';
        session.qrCode = null;
        session.socket = null;
        this.emitStatus(botConfigId, 'disconnected');

        if (shouldReconnect && session.retryCount < 5) {
          session.retryCount++;
          console.log(`[WA-Web] Reconnecting (attempt ${session.retryCount})...`);
          setTimeout(() => this.initSocket(botConfigId), 3000 * session.retryCount);
        } else if (!shouldReconnect) {
          // Logged out — clear auth
          console.log(`[WA-Web] Logged out, clearing session for ${botConfigId}`);
          this.clearAuth(botConfigId);
          this.sessions.delete(botConfigId);
        }
      }

      if (connection === 'open') {
        console.log(`[WA-Web] Connected for bot ${botConfigId}`);
        session.status = 'connected';
        session.qrCode = null;
        session.retryCount = 0;

        // Get phone number from socket
        const me = socket.user;
        if (me) {
          session.phoneNumber = me.id.split(':')[0] || me.id.split('@')[0];
          console.log(`[WA-Web] Phone: ${session.phoneNumber}`);
        }

        this.emitStatus(botConfigId, 'connected');
      }
    });

    // Handle incoming messages
    socket.ev.on('messages.upsert', async ({ messages: waMessages, type }) => {
      if (type !== 'notify') return;

      for (const msg of waMessages) {
        // Skip messages sent by us
        if (msg.key.fromMe) continue;

        // Skip status broadcasts (stories/states) and group messages
        const jid = msg.key.remoteJid || '';
        if (jid === 'status@broadcast' || jid.endsWith('@g.us') || jid.endsWith('@newsletter')) continue;

        // Skip non-text messages for now
        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text;
        if (!text) continue;

        const from = jid.replace('@s.whatsapp.net', '').replace('@lid', '');
        const contactName = msg.pushName || undefined;
        const messageId = msg.key.id || `web_${Date.now()}`;

        console.log(`[WA-Web] Message from ${from} (jid: ${jid}): ${text.substring(0, 50)}...`);

        // Process through the same bot pipeline
        try {
          await this.processIncomingWebMessage({
            botConfigId,
            from,
            replyJid: jid, // Keep original JID for sending replies
            messageId,
            text,
            contactName,
            timestamp: `${msg.messageTimestamp || Math.floor(Date.now() / 1000)}`,
          });
        } catch (err) {
          console.error('[WA-Web] Error processing message:', err);
        }
      }
    });
  }

  private async processIncomingWebMessage(params: {
    botConfigId: string;
    from: string;
    replyJid: string; // Full JID for sending replies (may be @lid or @s.whatsapp.net)
    messageId: string;
    text: string;
    contactName?: string;
    timestamp: string;
  }) {
    const { botConfigId, from, replyJid, messageId, text, contactName, timestamp } = params;

    const botConfig = await prisma.botConfig.findUnique({
      where: { id: botConfigId },
      include: { organization: true },
    });

    if (!botConfig) {
      console.error(`[WA-Web] Bot config not found: ${botConfigId}`);
      return;
    }

    const { conversationService } = await import('./conversation.service');

    // Find or create client and conversation
    const { client, conversation } = await conversationService.findOrCreateForClient(
      from,
      contactName,
      botConfig.organizationId,
      botConfig.id
    );

    // Check for duplicate
    const existingMsg = await prisma.message.findFirst({
      where: { waMessageId: messageId },
    });
    if (existingMsg) return;

    // Store incoming message
    const incomingMsg = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        senderType: 'CLIENT',
        content: text,
        waMessageId: messageId,
        timestamp: new Date(parseInt(timestamp) * 1000),
      },
    });

    // Update conversation timestamp
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

    // If BOT mode, generate AI response and send via WhatsApp Web
    if (conversation.mode === 'BOT') {
      console.log(`[WA-Web] Generating bot response for conv ${conversation.id}, replyJid: ${replyJid}`);
      await this.generateAndSendBotResponse(conversation.id, replyJid, botConfig);
    }
  }

  private async generateAndSendBotResponse(
    conversationId: string,
    phoneNumber: string,
    botConfig: any
  ) {
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
    console.log(`[WA-Web] Calling OpenAI for conv ${conversationId}...`);
    const aiResult = await openaiService.generateResponse({
      messages,
      model: botConfig.model,
      temperature: botConfig.temperature,
      maxTokens: botConfig.maxTokens,
    });
    console.log(`[WA-Web] AI response generated (${aiResult.content.length} chars)`);

    // Send via WhatsApp Web — phoneNumber is now the full JID
    const waMessageId = await this.sendMessage(botConfig.id, phoneNumber, aiResult.content);

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

  async sendMessage(botConfigId: string, to: string, text: string): Promise<string | null> {
    const session = this.sessions.get(botConfigId);
    if (!session || !session.socket || session.status !== 'connected') {
      console.warn(`[WA-Web] Cannot send: session not connected for ${botConfigId}`);
      return null;
    }

    try {
      // Use full JID if provided, otherwise construct it
      const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
      console.log(`[WA-Web] Sending message to JID: ${jid}`);
      const result = await session.socket.sendMessage(jid, { text });
      console.log(`[WA-Web] Message sent, id: ${result?.key?.id}`);
      return result?.key?.id || null;
    } catch (err) {
      console.error('[WA-Web] Error sending message:', err);
      return null;
    }
  }

  async disconnect(botConfigId: string): Promise<void> {
    const session = this.sessions.get(botConfigId);
    if (session?.socket) {
      await session.socket.logout().catch(() => {});
      session.socket = null;
    }
    session && (session.status = 'disconnected');
    session && (session.qrCode = null);
    this.clearAuth(botConfigId);
    this.sessions.delete(botConfigId);
    this.emitStatus(botConfigId, 'disconnected');
  }

  private clearAuth(botConfigId: string): void {
    const authPath = this.getAuthPath(botConfigId);
    if (fs.existsSync(authPath)) {
      fs.rmSync(authPath, { recursive: true, force: true });
    }
  }

  private emitStatus(botConfigId: string, status: ConnectionStatus, qrCode?: string): void {
    try {
      const io = getIO();
      io.emit('wa_web_status', { botConfigId, status, qrCode: qrCode || null });
    } catch {
      // Socket not ready yet
    }
  }

  // Reconnect all bots that have saved sessions on server start
  async reconnectSavedSessions(): Promise<void> {
    if (!fs.existsSync(this.authBasePath)) return;

    const dirs = fs.readdirSync(this.authBasePath).filter((d) =>
      fs.statSync(path.join(this.authBasePath, d)).isDirectory()
    );

    for (const botConfigId of dirs) {
      const authPath = path.join(this.authBasePath, botConfigId);
      const hasFiles = fs.readdirSync(authPath).length > 0;

      if (hasFiles) {
        console.log(`[WA-Web] Reconnecting saved session: ${botConfigId}`);
        try {
          await this.connect(botConfigId);
        } catch (err) {
          console.error(`[WA-Web] Failed to reconnect ${botConfigId}:`, err);
        }
      }
    }
  }
}

export const whatsappWebService = new WhatsAppWebService();
