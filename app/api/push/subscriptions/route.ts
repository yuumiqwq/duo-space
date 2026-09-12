import { NextRequest, NextResponse } from "next/server";
import { currentIdentityId } from "../../identity/session";
import { removePushSubscription, savePushSubscription } from "../store";

function validEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try { return new URL(value).protocol === "https:"; } catch { return false; }
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (origin && origin !== request.nextUrl.origin) return new NextResponse("Forbidden", { status: 403 });
  const identityId = await currentIdentityId();
  if (!identityId) return new NextResponse("Unauthorized", { status: 401 });
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    return NextResponse.json({ error: "消息推送尚未配置" }, { status: 503 });
  }
  const body = await request.json().catch(() => ({})) as { subscription?: PushSubscriptionJSON; deviceId?: unknown };
  const subscription = body.subscription;
  const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim().slice(0, 80) : "";
  if (!subscription || !validEndpoint(subscription.endpoint)
    || typeof subscription.keys?.p256dh !== "string" || !/^[\w-]{87}=?$/.test(subscription.keys.p256dh)
    || typeof subscription.keys.auth !== "string" || !/^[\w-]{22}(==)?$/.test(subscription.keys.auth)
    || (subscription.expirationTime != null && (!Number.isFinite(subscription.expirationTime) || subscription.expirationTime <= Date.now()))
    || !deviceId) {
    return NextResponse.json({ error: "推送订阅无效" }, { status: 400 });
  }
  await savePushSubscription({
    endpoint: subscription.endpoint,
    expirationTime: subscription.expirationTime ?? null,
    keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
    identityId,
    deviceId,
    updatedAt: Date.now(),
  });
  return NextResponse.json({ enabled: true });
}

export async function DELETE(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (origin && origin !== request.nextUrl.origin) return new NextResponse("Forbidden", { status: 403 });
  const identityId = await currentIdentityId();
  if (!identityId) return new NextResponse("Unauthorized", { status: 401 });
  const body = await request.json().catch(() => ({})) as { endpoint?: unknown };
  if (!validEndpoint(body.endpoint)) return NextResponse.json({ error: "推送订阅无效" }, { status: 400 });
  await removePushSubscription(body.endpoint, identityId);
  return NextResponse.json({ enabled: false });
}
