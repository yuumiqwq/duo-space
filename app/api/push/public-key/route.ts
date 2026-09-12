import { NextResponse } from "next/server";
import { currentIdentityId } from "../../identity/session";

export async function GET() {
  if (!(await currentIdentityId())) return new NextResponse("Unauthorized", { status: 401 });
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  if (!publicKey || !process.env.VAPID_PRIVATE_KEY) return NextResponse.json({ error: "消息推送尚未配置" }, { status: 503 });
  return NextResponse.json({ publicKey }, { headers: { "Cache-Control": "private, max-age=3600" } });
}
