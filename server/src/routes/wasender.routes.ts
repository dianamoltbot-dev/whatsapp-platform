import { Router, Request, Response } from 'express';
import { wasenderService } from '../services/wasender.service';
import { env } from '../config/env';
import * as crypto from 'crypto';

const router = Router();

/**
 * Verify WaSenderAPI webhook signature
 */
function verifyWebhookSignature(req: Request): boolean {
  const secret = env.WASENDER_WEBHOOK_SECRET;
  if (!secret) return true; // Skip verification if no secret configured

  const signature = req.headers['x-webhook-signature'] || req.headers['x-signature'] || '';
  if (!signature) {
    console.warn('[WaSender Webhook] No signature header found, allowing (check docs for header name)');
    return true; // Be permissive initially until we know exact header
  }

  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(req.body))
    .digest('hex');

  return signature === expectedSig;
}

/**
 * POST /api/wasender/webhook
 * Webhook endpoint for WaSenderAPI — receives incoming messages
 * Configure this URL in your WaSenderAPI dashboard
 */
router.post('/webhook', async (req: Request, res: Response) => {
  try {
    console.log('[WaSender Webhook] Received:', JSON.stringify(req.body).substring(0, 500));

    // Verify signature
    if (!verifyWebhookSignature(req)) {
      console.error('[WaSender Webhook] Invalid signature, rejecting');
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    // Immediately respond 200 to WaSender (they expect fast response)
    res.status(200).json({ received: true });

    // Process async
    await wasenderService.processWebhook(req.body);
  } catch (err) {
    console.error('[WaSender Webhook] Error:', err);
    // Still return 200 to avoid retries
    if (!res.headersSent) {
      res.status(200).json({ received: true });
    }
  }
});

/**
 * GET /api/wasender/webhook
 * Webhook verification (some providers send GET to verify)
 */
router.get('/webhook', (req: Request, res: Response) => {
  const challenge = req.query.challenge || req.query['hub.challenge'] || 'ok';
  res.status(200).send(challenge);
});

/**
 * POST /api/wasender/send
 * Manual send endpoint (for agent/dashboard use)
 */
router.post('/send', async (req: Request, res: Response) => {
  try {
    const { to, text } = req.body;
    if (!to || !text) {
      res.status(400).json({ error: 'to and text are required' });
      return;
    }

    const messageId = await wasenderService.sendText(to, text);
    res.json({ success: !!messageId, messageId });
  } catch (err: any) {
    console.error('[WaSender Send] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/wasender/status
 * Check WaSenderAPI connection status
 */
router.get('/status', async (_req: Request, res: Response) => {
  try {
    const status = await wasenderService.getStatus();
    res.json(status);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
