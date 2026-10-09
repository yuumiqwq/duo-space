import { NextResponse } from "next/server";
import { currentIdentityId } from "../../identity/session";

type RoomParticipant = {
  peerId: string;
  deviceId: string;
  name: string;
  identityId: string;
  seenAt: number;
  expiresAt: number;
};

type RoomPresenceGlobal = typeof globalThis & {
  __studyRoomPresence?: Map<string, RoomParticipant>;
};

const presenceGlobal = globalThis as RoomPresenceGlobal;
const participants = presenceGlobal.__studyRoomPresence ??= new Map<string, RoomParticipant>();
const desktopPresenceLifetime = 60_000;
const mobilePresenceLifetime = 30 * 60_000;
const peerPattern = /^[A-Za-z0-9_-]{1,64}$/;
const devicePattern = /^[A-Za-z0-9_-]{1,80}$/;

function activeParticipants(now = Date.now()) {
  for (const [deviceId, participant] of participants) {
    if (now > participant.expiresAt) participants.delete(deviceId);
  }
  return [...participants.values()].map(({ peerId, deviceId, name, identityId, expiresAt }) => ({ peerId, deviceId, name, identityId, expiresAt }));
}

export function GET() {
  return NextResponse.json({ participants: activeParticipants() }, {
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function POST(request: Request) {
  const identityId = await currentIdentityId();
  if (!identityId) return new NextResponse("Unauthorized", { status: 401 });
  const body = await request.json().catch(() => ({}));
  const peerId = typeof body.peerId === "string" ? body.peerId.trim() : "";
  const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 24) : "成员";
  const mobile = body.mobile === true;
  const background = body.background === true;
  // The member is present even while the media signaling service reconnects.
  if ((peerId !== '' && !peerPattern.test(peerId)) || !devicePattern.test(deviceId)) {
    return new NextResponse("Invalid presence", { status: 400 });
  }

  const now = Date.now();
  participants.set(deviceId, {
    peerId,
    deviceId,
    name: name || "成员",
    identityId,
    seenAt: now,
    expiresAt: now + (background ? mobilePresenceLifetime : (mobile ? mobilePresenceLifetime : desktopPresenceLifetime)),
  });
  return NextResponse.json({ participants: activeParticipants() }, {
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function DELETE(request: Request) {
  const identityId = await currentIdentityId();
  if (!identityId) return new NextResponse("Unauthorized", { status: 401 });
  const body = await request.json().catch(() => ({}));
  const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
  if (devicePattern.test(deviceId) && participants.get(deviceId)?.identityId === identityId) participants.delete(deviceId);
  return new NextResponse(null, { status: 204 });
}
