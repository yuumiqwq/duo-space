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
