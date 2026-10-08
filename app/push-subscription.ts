export function decodeVapidKey(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

export function subscriptionNeedsRenewal(subscription: Pick<PushSubscription, "expirationTime" | "options">, publicKey: string) {
  if (subscription.expirationTime !== null && subscription.expirationTime <= Date.now()) return true;
  const current = subscription.options.applicationServerKey;
  if (!current) return true;
  const expected = decodeVapidKey(publicKey), actual = new Uint8Array(current);
  return expected.length !== actual.length || expected.some((byte, index) => byte !== actual[index]);
}

export type PushStatus = "checking" | "enabled" | "disabled" | "renewal" | "unknown" | "unsupported";

// A failed check says nothing about whether the device is still subscribed.
// Inspection must never unsubscribe or create a replacement subscription.
export async function checkPushSubscription(
  registration: Pick<ServiceWorkerRegistration, "pushManager">,
  deviceId: string,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<"enabled" | "disabled" | "renewal" | "unknown"> {
  try {
    const subscription = await registration.pushManager.getSubscription();
    signal.throwIfAborted();
    if (!subscription) return "disabled";
    const keyResponse = await request("/api/push/public-key", { cache: "no-store", signal });
    const keyData = await keyResponse.json();
    if (!keyResponse.ok || keyResponse.redirected || typeof keyData.publicKey !== "string" || !keyData.publicKey) return "unknown";
    if (subscriptionNeedsRenewal(subscription, keyData.publicKey)) return "renewal";
    const response = await request("/api/push/subscriptions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: subscription.toJSON(), deviceId }), signal,
    });
    signal.throwIfAborted();
    return response.ok && !response.redirected ? "enabled" : "unknown";
  } catch {
    signal.throwIfAborted();
    return "unknown";
  }
}
