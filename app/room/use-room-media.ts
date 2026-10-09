"use client";
import { Room,Track } from "livekit-client";
import type { DataConnection,MediaConnection } from "peerjs";
import type { Dispatch,RefObject,SetStateAction } from "react";
import { useEffect,useRef,useState } from "react";
import { createCameraCapture } from '../camera-capture';
import { type MediaSource } from "../media-recovery";
import { requestScreenShare } from '../screen-share';
import { isMobileBrowser,USE_LIVEKIT } from './model';
type Options = {
  outgoingCallsRef: RefObject<Map<string, MediaConnection>>;
  dataConnectionsRef: RefObject<Map<string, DataConnection>>;
  callPeerRef: RefObject<(peerId: string, media: MediaStream, source: MediaSource) => void>;
  recoverPublishedMediaRef: RefObject<(source: MediaSource) => void>;
  roomRef: RefObject<Room | null>;
  intentionalLeaveRef: RefObject<boolean>;
  setActiveMediaId: Dispatch<SetStateAction<string>>;
  joined: boolean;
};
export function useRoomMedia({ outgoingCallsRef, dataConnectionsRef, callPeerRef, recoverPublishedMediaRef, roomRef, intentionalLeaveRef, setActiveMediaId, joined }: Options) {

  const shareStartingRef = useRef(false);

  const [stream, setStream] = useState<MediaStream | null>(null);

  const [shareStarting, setShareStarting] = useState(false);

  const [remoteScreenMuted, setRemoteScreenMuted] = useState(false);

  const [pictureInPicture, setPictureInPicture] = useState(false);

  const [shareError, setShareError] = useState("");

  const [microphoneStream, setMicrophoneStream] = useState<MediaStream | null>(null);

  const microphoneStreamRef = useRef<MediaStream | null>(null);

  const microphoneBusy = useRef(false);

  const microphoneRequest = useRef(0);

  const [microphoneError, setMicrophoneError] = useState('');

  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);

  const [cameraError, setCameraError] = useState("");

  const cameraStreamRef = useRef<MediaStream | null>(null);

  const screenStreamRef = useRef<MediaStream | null>(null);


  useEffect(() => {
    const entered = () => setPictureInPicture(true);
    const left = () => setPictureInPicture(false);
    document.addEventListener("enterpictureinpicture", entered, true);
    document.addEventListener("leavepictureinpicture", left, true);
    return () => {
      document.removeEventListener("enterpictureinpicture", entered, true);
      document.removeEventListener("leavepictureinpicture", left, true);
    };
  }, []);

  useEffect(() => () => stream?.getTracks().forEach((track) => track.stop()), [stream]);


  useEffect(() => {
    cameraStreamRef.current = cameraStream;
    outgoingCallsRef.current.forEach((call, key) => {
      if (!key.startsWith("camera:")) return;
      call.close();
      outgoingCallsRef.current.delete(key);
    });
    if (cameraStream) {
      dataConnectionsRef.current.forEach((_connection, peerId) => callPeerRef.current(peerId, cameraStream, "camera"));
    }
    const track = cameraStream?.getVideoTracks()[0];
    const onUnmute = () => recoverPublishedMediaRef.current('camera');
    track?.addEventListener('unmute', onUnmute);
    return () => track?.removeEventListener('unmute', onUnmute);
  }, [cameraStream, callPeerRef, dataConnectionsRef, outgoingCallsRef, recoverPublishedMediaRef]);


  useEffect(() => {
    screenStreamRef.current = stream;
    outgoingCallsRef.current.forEach((call, key) => {
      if (!key.startsWith("screen:")) return;
      call.close();
      outgoingCallsRef.current.delete(key);
    });
    if (stream) {
      dataConnectionsRef.current.forEach((_connection, peerId) => callPeerRef.current(peerId, stream, "screen"));
    }
    const track = stream?.getVideoTracks()[0];
    const onUnmute = () => recoverPublishedMediaRef.current("screen");
    track?.addEventListener("unmute", onUnmute);
    return () => track?.removeEventListener("unmute", onUnmute);
  }, [stream, callPeerRef, dataConnectionsRef, outgoingCallsRef, recoverPublishedMediaRef]);


  const startShare = async (reveal: () => void) => {
    if (shareStartingRef.current || screenStreamRef.current) return;
    setShareError("");
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setShareError("当前浏览器不支持屏幕共享，请使用最新版 Chrome、Edge 或 Safari。");
      return;
    }
    shareStartingRef.current = true;
    setShareStarting(true);
    let captured: MediaStream | null = null;
    try {
      const nextStream = await requestScreenShare();
      captured = nextStream;
      const track = nextStream.getVideoTracks()[0];
      if (!track || track.readyState !== "live") throw new Error("No live screen track");
      track.addEventListener("ended", () => {
        nextStream.getTracks().forEach((item) => { void roomRef.current?.localParticipant.unpublishTrack(item); item.stop(); });
        if (screenStreamRef.current === nextStream) {
          screenStreamRef.current = null;
          setStream(null);
        }
      });
      if (roomRef.current) {
        await roomRef.current.localParticipant.publishTrack(track, { source: Track.Source.ScreenShare });
        const audioTrack = nextStream.getAudioTracks()[0];
        if (audioTrack) {
          audioTrack.contentHint = "music";
          await roomRef.current.localParticipant.publishTrack(audioTrack, { source: Track.Source.ScreenShareAudio });
        }
      }
      if (track.readyState !== 'live' || intentionalLeaveRef.current) throw new Error('Screen sharing ended');
      screenStreamRef.current = nextStream;
      setStream(nextStream);
      setActiveMediaId("self-screen");
      reveal();
    } catch (error) {
      captured?.getTracks().forEach(track => { void roomRef.current?.localParticipant.unpublishTrack(track); track.stop(); });
      if ((error as DOMException).name !== "NotAllowedError") setShareError("没有成功开始共享，请重新选择窗口或屏幕。");
    } finally { shareStartingRef.current = false; setShareStarting(false); }
  };


  const stopShare = () => {
    const current = screenStreamRef.current || stream;
    current?.getTracks().forEach((track) => { void roomRef.current?.localParticipant.unpublishTrack(track); track.stop(); });
    screenStreamRef.current = null;
    setStream(null);
    if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => undefined);
  };


  const toggleRemoteScreenAudio = () => setRemoteScreenMuted(current => !current);


  const togglePictureInPicture = async () => {
    setShareError("");
    try {
      const video = document.querySelector<HTMLVideoElement>("video.main-media.screen");
      if (!video) throw new Error("请先选择一个共享画面");
      const safariVideo = video as HTMLVideoElement & {
        webkitSupportsPresentationMode?: (mode: string) => boolean;
        webkitSetPresentationMode?: (mode: string) => void;
        webkitPresentationMode?: string;
      };
      if (safariVideo.webkitPresentationMode === "picture-in-picture" && safariVideo.webkitSetPresentationMode) {
        safariVideo.webkitSetPresentationMode("inline");
        setPictureInPicture(false);
        return;
      }
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        setPictureInPicture(false);
        return;
      }
      if (safariVideo.webkitSupportsPresentationMode?.("picture-in-picture") && safariVideo.webkitSetPresentationMode) {
        const syncSafariState = () => {
          const active = safariVideo.webkitPresentationMode === "picture-in-picture";
          setPictureInPicture(active);
          if (!active) video.removeEventListener("webkitpresentationmodechanged", syncSafariState);
        };
        video.addEventListener("webkitpresentationmodechanged", syncSafariState);
        void video.play().catch(() => undefined);
        safariVideo.webkitSetPresentationMode("picture-in-picture");
        setPictureInPicture(true);
        return;
      }
      await video.play();
      if (document.pictureInPictureEnabled && video.requestPictureInPicture) {
        await video.requestPictureInPicture();
        setPictureInPicture(true);
        video.addEventListener("leavepictureinpicture", () => setPictureInPicture(false), { once: true });
        return;
      }
      throw new Error(isMobileBrowser() ? "请在 iPhone 设置 → 通用 → 画中画中开启“自动开启画中画”" : "当前浏览器不支持共享画面小窗");
    } catch (error) {
      setShareError(error instanceof Error ? error.message : "小窗开启失败，请重试");
    }
  };


  useEffect(() => {
    microphoneStreamRef.current = microphoneStream;
    outgoingCallsRef.current.forEach((call,key) => { if(key.startsWith('microphone:')) {call.close();outgoingCallsRef.current.delete(key);} });
    if(microphoneStream) dataConnectionsRef.current.forEach((_connection,peerId) => callPeerRef.current(peerId,microphoneStream,'microphone'));
    const track=microphoneStream?.getAudioTracks()[0];
    const resume=()=>recoverPublishedMediaRef.current('microphone');
    track?.addEventListener('unmute',resume);
    return ()=>{track?.removeEventListener('unmute',resume);microphoneStream?.getTracks().forEach(item=>item.stop());};
  },[microphoneStream, callPeerRef, dataConnectionsRef, outgoingCallsRef, recoverPublishedMediaRef]);

  const stopMicrophone = () => {
    microphoneRequest.current += 1;
    microphoneBusy.current = false;
    microphoneStreamRef.current?.getTracks().forEach(track=>{void roomRef.current?.localParticipant.unpublishTrack(track);track.stop();});
    microphoneStreamRef.current=null;setMicrophoneStream(null);
  };

  const toggleMicrophone = async () => {
    if(microphoneStreamRef.current){stopMicrophone();return;}
    if(microphoneBusy.current || !joined)return;
    microphoneBusy.current=true;setMicrophoneError('');let capture:MediaStream|null=null;
    const request = ++microphoneRequest.current;
    const owner = roomRef.current;
    const cancelled = () => request !== microphoneRequest.current || intentionalLeaveRef.current;
    const release = () => capture?.getTracks().forEach(track => { void owner?.localParticipant.unpublishTrack(track).catch(() => undefined); track.stop(); });
    try {
      capture=await navigator.mediaDevices.getUserMedia({video:false,audio:{echoCancellation:true,noiseSuppression:true}});
      if (cancelled()) { release(); return; }
      const track=capture.getAudioTracks()[0];
      if (!track) throw new Error('没有可用音轨');
      await owner?.localParticipant.publishTrack(track,{source:Track.Source.Microphone});
      if (cancelled() || (USE_LIVEKIT && owner !== roomRef.current)) { release(); return; }
      microphoneStreamRef.current=capture;setMicrophoneStream(capture);
      track.addEventListener('ended',()=>{if(microphoneStreamRef.current===capture){void roomRef.current?.localParticipant.unpublishTrack(track);microphoneStreamRef.current=null;setMicrophoneStream(null);}});
    }catch {release();if (!cancelled()) setMicrophoneError('麦克风暂时无法开启，请检查浏览器权限与设备占用');}
    finally{if (request === microphoneRequest.current) microphoneBusy.current=false;}
  };

  useEffect(() => () => { microphoneRequest.current += 1; microphoneBusy.current = false; }, [joined]);


  // The controller stores callbacks; camera refs are read only on user actions.
  // eslint-disable-next-line react-hooks/refs
  const [cameraCapture] = useState(() => createCameraCapture({
    capture: () => navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 }, facingMode: 'user' },
      audio: false,
    }),
    publish: async media => { await roomRef.current?.localParticipant.publishTrack(media.getVideoTracks()[0], { source: Track.Source.Camera }); },
    release: media => { media.getTracks().forEach(track => { void roomRef.current?.localParticipant.unpublishTrack(track); }); },
    changed: media => {
      cameraStreamRef.current = media;
      setCameraStream(media);
      if (media) setActiveMediaId('self-camera');
    },
    error: error => setCameraError((error as DOMException)?.name === 'NotAllowedError'
      ? '摄像头权限未开启，请在浏览器地址栏允许 11scat 使用摄像头。'
      : '摄像头暂时无法开启，请确认没有被其他程序占用。'),
  }));

  useEffect(() => () => cameraCapture.stop(), [cameraCapture, joined]);

  const stopCamera = () => cameraCapture.stop();

  const toggleCamera = async (reveal: () => void) => {
    if (cameraStreamRef.current) { stopCamera(); return; }
    if (!joined || intentionalLeaveRef.current) return;
    setCameraError('');
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError('当前浏览器不支持摄像头访问，请使用最新版 Chrome、Edge 或 Safari。');
      return;
    }
    await cameraCapture.start();
    if (cameraStreamRef.current) reveal();
  };
return { microphoneStreamRef, cameraStreamRef, screenStreamRef, stream, shareStarting, remoteScreenMuted, pictureInPicture, shareError, setShareError, microphoneStream, microphoneError, cameraStream, cameraError, startShare, stopShare, toggleRemoteScreenAudio, togglePictureInPicture, stopMicrophone, toggleMicrophone, stopCamera, toggleCamera };
}
