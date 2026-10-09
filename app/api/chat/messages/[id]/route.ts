import { NextResponse } from "next/server";
import { currentIdentityId } from "../../../identity/session";
import { findMessage, recallMessage } from "../../store";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const identityId = await currentIdentityId();
  if (!identityId) return new NextResponse("Unauthorized", { status: 401 });
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse("Not found", { status: 404 });
  const message = await findMessage(id, identityId);
  return NextResponse.json({ message }, { status: message ? 200 : 404, headers: { "Cache-Control": "private, no-store" } });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const identityId = await currentIdentityId();
  if (!identityId) return new NextResponse("Unauthorized", { status: 401 });
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(null, { status: await recallMessage(id, identityId) ? 204 : 404 });
}
