import { NextRequest, NextResponse } from "next/server";
import { currentIdentityId } from "../../identity/session";
import { sendDeviceTestPush } from "../store";
import { isSamePushOrigin } from "../origin";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!isSamePushOrigin(request)) return new NextResponse("Forbidden", { status: 403 });
  const identityId = await currentIdentityId();
  if (!identityId) return new NextResponse("Unauthorized", { status: 401 });
  const body = await request.json().catch(() => ({}));
  if (typeof body.endpoint !== "string" || body.endpoint.length > 2048) {
    return NextResponse.json({ error: "设备订阅无效" }, { status: 400 });
  }
  // Only an already registered endpoint belonging to this identity may be tested.
  const result = await sendDeviceTestPush(identityId, body.endpoint);
  return NextResponse.json(result.status === 200 ? { accepted: true } : { error: result.error }, {
    status: result.status, headers: { "Cache-Control": "no-store" },
  });
}
