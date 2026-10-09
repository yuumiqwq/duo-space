"use client";

import { useCallback,useEffect,useRef,useState } from "react";
import { createChatSyncRequest } from "../chat-sync-request";
import { checkPushSubscription,decodeVapidKey,type PushStatus } from "../push-subscription";

type Options = {
  identityId: string;
};

export function useRoomNotifications({ identityId }: Options) {

  const [pushStatus, setPushStatus] = useState<PushStatus>("checking");
  const [pushCheckVersion, setPushCheckVersion] = useState(0);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushTesting, setPushTesting] = useState(false);
  const [pushTestMessage, setPushTestMessage] = useState("");
  const [pushMessage, setPushMessage] = useState("");
  const notificationAudioContextRef = useRef<AudioContext | null>(null);
  const pushDeviceIdRef = useRef("");
  const notifiedMessageIdsRef = useRef(new Set<string>());

  const playNotificationSound = useCallback((messageId: string) => {
    if (notifiedMessageIdsRef.current.has(messageId)) return;
    if (notifiedMessageIdsRef.current.size > 500) notifiedMessageIdsRef.current.clear();
    notifiedMessageIdsRef.current.add(messageId);
    try {
      const context = notificationAudioContextRef.current || new window.AudioContext();
      notificationAudioContextRef.current = context;
      void context.resume().then(() => {
        const start = context.currentTime;
        const gain = context.createGain();
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.12, start + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.34);
        gain.connect(context.destination);
        [659.25, 880].forEach((frequency, index) => {
          const oscillator = context.createOscillator();
          oscillator.type = "sine";
          oscillator.frequency.setValueAtTime(frequency, start + index * 0.08);
          oscillator.connect(gain);
          oscillator.start(start + index * 0.08);
          oscillator.stop(start + 0.34);
        });
      }).catch(() => undefined);
    } catch { /* Audio may be unavailable until the browser allows playback. */ }
  }, []);

  useEffect(() => {
    const unlockAudio = () => {
      try {
        const context = notificationAudioContextRef.current || new window.AudioContext();
        notificationAudioContextRef.current = context;
        if (context.state === "suspended") void context.resume();
      } catch { /* Web Audio is optional. */ }
    };
    window.addEventListener("pointerdown", unlockAudio, { once: true });
    window.addEventListener("keydown", unlockAudio, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("keydown", unlockAudio);
      void notificationAudioContextRef.current?.close();
      notificationAudioContextRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!identityId || pushBusy) return;
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const requests = createChatSyncRequest();
    const initializePush = async () => {
      clearTimeout(retryTimer);
      if (document.visibilityState !== "visible") { requests.cancel(); return; }
      if (disposed) return;
      const request = requests.begin();
      if (!request) return;
      setPushStatus("checking");
      setPushTestMessage("");
      const unavailable = () => {
        setPushStatus("unknown");
        setPushMessage("暂时无法确认后台提醒状态，请检查网络后重试。");
        retryTimer = setTimeout(() => void initializePush(), 30_000);
      };
      try {
        if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
          setPushStatus("unsupported");
          setPushMessage("");
          return;
        }
        if (Notification.permission !== "granted") {
          setPushStatus("disabled");
          setPushMessage("");
          return;
        }
        pushDeviceIdRef.current = window.localStorage.getItem("11scat-push-device-id") || crypto.randomUUID();
        window.localStorage.setItem("11scat-push-device-id", pushDeviceIdRef.current);
        const registration = await navigator.serviceWorker.register("/sw.js");
        const status = await checkPushSubscription(registration, pushDeviceIdRef.current, request.signal);
        if (disposed || !request.isCurrent()) return;
        if (status === "unknown") {
          unavailable();
        } else {
          setPushStatus(status);
          setPushMessage(status === "renewal" ? "订阅已失效，请重新开启提醒。" : "");
        }
      } catch {
        if (!disposed && request.isLatest()) unavailable();
      } finally { request.finish(); }
    };
    void initializePush();
    document.addEventListener("visibilitychange", initializePush);
    window.addEventListener("online", initializePush);
    window.addEventListener("pageshow", initializePush);
    return () => {
      disposed = true; requests.cancel();
      clearTimeout(retryTimer);
      document.removeEventListener("visibilitychange", initializePush);
      window.removeEventListener("online", initializePush);
      window.removeEventListener("pageshow", initializePush);
    };
  }, [identityId, pushBusy, pushCheckVersion]);

  const enablePushNotifications = async () => {
    setPushBusy(true);
    setPushTestMessage("");
    setPushMessage("");
    try {
      const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
      const isStandalone = window.matchMedia("(display-mode: standalone)").matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
      if (isIos && !isStandalone) throw new Error("iPhone 的 Safari 和 Edge 普通标签页都不能开启网页通知。请点“分享”→“添加到主屏幕”，关闭当前页面，再从手机桌面的 11scat 图标打开并开启提醒。");
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) throw new Error("当前浏览器或系统版本不支持网页消息提醒");
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("需要允许通知，iPhone 和 Apple Watch 才能收到提醒");
      const keyResponse = await fetch("/api/push/public-key", { cache: "no-store", signal: AbortSignal.timeout(10_000) });
      const keyData = await keyResponse.json().catch(() => ({})) as { publicKey?: string; error?: string };
      if (!keyResponse.ok || !keyData.publicKey) throw new Error(keyData.error || "推送服务尚未配置");
      await navigator.serviceWorker.register("/sw.js");
      const registration = await navigator.serviceWorker.ready;
      let existing = await registration.pushManager.getSubscription();
      // A revoked provider subscription can still look valid locally. An explicit
      // enable action must rebuild it, not re-save the same dead endpoint.
      if (existing) {
        if (!await existing.unsubscribe()) throw new Error("旧订阅移除失败，请重试。");
        existing = null;
      }
      const subscription = existing || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeVapidKey(keyData.publicKey) });
      if (!pushDeviceIdRef.current) {
        pushDeviceIdRef.current = window.localStorage.getItem("11scat-push-device-id") || crypto.randomUUID();
        window.localStorage.setItem("11scat-push-device-id", pushDeviceIdRef.current);
      }
      const response = await fetch("/api/push/subscriptions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: subscription.toJSON(), deviceId: pushDeviceIdRef.current }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok || response.redirected) throw new Error("通知订阅保存失败，请检查登录状态后重试");
      setPushStatus("enabled");
      setPushMessage("提醒已开启。");
    } catch (error) {
      setPushMessage(error instanceof Error ? error.message : "开启消息提醒失败");
    } finally {
      setPushBusy(false);
    }
  };

  const disablePushNotifications = async () => {
    setPushBusy(true);
    setPushTestMessage("");
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        const response = await fetch("/api/push/subscriptions", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: subscription.endpoint }), signal: AbortSignal.timeout(10_000) });
        if (!response.ok || response.redirected) throw new Error("取消订阅失败");
        if (!await subscription.unsubscribe()) throw new Error("设备取消订阅失败");
      }
      setPushStatus("disabled");
      setPushMessage("此设备的消息提醒已关闭。");
    } catch {
      setPushMessage("关闭失败，请在系统通知设置中关闭 11scat。");
    } finally {
      setPushBusy(false);
    }
  };

  const testPushNotifications = async () => {
    setPushTesting(true);
    setPushTestMessage("");
    try {
      if (!("Notification" in window) || Notification.permission !== "granted") throw new Error("此浏览器尚未允许通知，请在地址栏的网站设置中允许通知后重新开启提醒。");
      const registration = await navigator.serviceWorker.getRegistration("/");
      const subscription = await registration?.pushManager.getSubscription();
      if (!subscription) throw new Error("此设备没有有效订阅，请重新开启提醒。");
      const response = await fetch("/api/push/test", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: subscription.endpoint }), signal: AbortSignal.timeout(15_000),
      });
      const data = await response.json().catch(() => ({})) as { accepted?: boolean; error?: string };
      if (!response.ok || !data.accepted) throw new Error(data.error || "测试未成功，请检查登录状态后重试。");
      setPushTestMessage("推送服务已接受；设备显示待确认。");
    } catch (error) {
      setPushTestMessage(error instanceof Error ? error.message : "测试提醒失败");
    } finally { setPushTesting(false); }
  };
  return { pushStatus, setPushStatus, setPushCheckVersion, pushBusy, pushTesting, pushTestMessage, pushMessage, pushDeviceIdRef, playNotificationSound, enablePushNotifications, disablePushNotifications, testPushNotifications };
}
