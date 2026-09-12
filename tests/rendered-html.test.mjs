import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectFile = (path) => new URL(`../${path}`, import.meta.url);

test("retains installed PWA push delivery and restores per-device notification controls", async () => {
  const [layout, page, manifestText, serviceWorker, proxy, messageRoute, pushStore] = await Promise.all([
    readFile(projectFile("app/layout.tsx"), "utf8"),
    readFile(projectFile("app/page.tsx"), "utf8"),
    readFile(projectFile("public/manifest.webmanifest"), "utf8"),
    readFile(projectFile("public/sw.js"), "utf8"),
    readFile(projectFile("proxy.ts"), "utf8"),
    readFile(projectFile("app/api/chat/messages/route.ts"), "utf8"),
    readFile(projectFile("app/api/push/store.ts"), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);

  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.match(layout, /manifest:\s*"\/manifest\.webmanifest"/);
  assert.match(layout, /appleWebApp:\s*\{\s*capable:\s*true/);
  assert.match(page, /navigator\.serviceWorker\.register\("\/sw\.js"\)/);
  assert.match(page, /Notification\.requestPermission\(\)/);
  assert.match(page, /testPushNotifications/);
  assert.match(page, /subscriptionNeedsRenewal/);
  assert.match(serviceWorker, /addEventListener\("push"/);
  assert.match(serviceWorker, /showNotification/);
  assert.match(serviceWorker, /addEventListener\("notificationclick"/);
  assert.match(proxy, /sw\.js\|manifest\.webmanifest/);
  assert.match(messageRoute, /sendChatPush\(message/);
  assert.match(pushStore, /item\.deviceId !== senderDeviceId/);
});

test("uses native iPhone PiP and mobile-only background presence grace", async () => {
  const [page, presenceRoute] = await Promise.all([
    readFile(projectFile("app/page.tsx"), "utf8"),
    readFile(projectFile("app/api/room/presence/route.ts"), "utf8"),
  ]);

  assert.match(page, /MOBILE_BACKGROUND_GRACE_MS\s*=\s*30\s*\*\s*60\s*\*\s*1000/);
  assert.match(page, /const mobileClient = isMobileBrowser\(\)/);
  assert.match(page, /syncRoomPresence\(true\)/);
  assert.match(page, /mobilePeerIds\.has\(peerId\)\s*\?\s*MOBILE_BACKGROUND_GRACE_MS\s*:\s*10_000/);
  assert.match(page, /if \(!mobileClient \|\| intentionalLeaveRef\.current\) leaveRoomPresence\(\)/);
  assert.match(page, /disablePictureInPicture=\{false\}/);
  assert.match(page, /webkitSupportsPresentationMode\?\.\("picture-in-picture"\)/);
  assert.match(page, /webkitSetPresentationMode\("picture-in-picture"\)/);
  const pipHandler = page.slice(page.indexOf("const togglePictureInPicture ="));
  assert.ok(
    pipHandler.indexOf('webkitSetPresentationMode("picture-in-picture")') < pipHandler.indexOf("await video.play();"),
    "Safari PiP must be requested before an awaited operation consumes the tap gesture",
  );
  assert.match(presenceRoute, /mobilePresenceLifetime\s*=\s*30\s*\*\s*60_000/);
  assert.match(presenceRoute, /mobile\s*\?\s*mobilePresenceLifetime\s*:\s*desktopPresenceLifetime/);
});
