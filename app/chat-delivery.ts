export type DeliveryResult = { message: unknown; recalled?: boolean };

class DeliveryError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) { super(message); this.retryable = retryable; }
}

// Reuse the message id for every attempt: a lost HTTP response must never
// create a second message. Read-back confirms durable writes before retrying.
export async function confirmChatDelivery(
  payload: { id: string; body: string; attachment?: unknown; replyTo?: unknown },
  deviceId: string,
  options: { request?: typeof fetch; wait?: (ms: number) => Promise<void>; confirmed?: () => boolean } = {},
): Promise<DeliveryResult | null> {
  const request = options.request || fetch;
  const wait = options.wait || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let failure: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (options.confirmed?.()) return null;
    try {
      const response = await request('/api/chat/messages', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-device-id': deviceId },
        signal: AbortSignal.timeout(20_000), body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => null);
      if (response.ok && !response.redirected && result?.message?.id === payload.id) return { message: result.message, recalled: result.message.recalled === true };
      throw new DeliveryError(typeof result?.error === 'string' ? result.error : '发送未确认，请重试',
        response.ok || [408, 429, 500, 502, 503, 504].includes(response.status));
    } catch (error) {
      failure = error;
      if (options.confirmed?.()) return null;
      if (error instanceof DeliveryError && !error.retryable) throw error;
      try {
        const response = await request(`/api/chat/messages/${encodeURIComponent(payload.id)}`, {
          cache: 'no-store', signal: AbortSignal.timeout(8000),
        });
        const result = await response.json().catch(() => null);
        if (response.ok && !response.redirected && result?.message?.id === payload.id) return { message: result.message, recalled: result.message.recalled === true };
      } catch { /* The same id remains safe to retry after a lost read-back. */ }
      if (attempt < 2) await wait(750 * 2 ** attempt);
    }
  }
  if (options.confirmed?.()) return null;
  throw failure instanceof Error ? failure : new Error('发送未确认，请重试');
}
