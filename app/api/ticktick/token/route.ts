import { NextResponse } from "next/server";
import { clearAccessToken, saveAccessToken } from "../store";
import { tickInboxData, TickApiError } from "../client";

const COOKIE = "tt_access";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) return new NextResponse("Missing token", { status: 400 });

  try { await tickInboxData(token); }
  catch (error) { return new NextResponse('Task read failed', { status: error instanceof TickApiError && [401, 403].includes(error.status) ? 401 : 502 }); }

  if (!(await saveAccessToken(token))) return new NextResponse("Unauthorized", { status: 401 });
  const response = NextResponse.json({ ok: true });
  response.cookies.set(COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
  return response;
}

export async function DELETE() {
  if (!(await clearAccessToken())) return new NextResponse("Unauthorized", { status: 401 });
  const response = NextResponse.json({ ok: true });
  response.cookies.set(COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
  return response;
}
