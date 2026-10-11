"use client";

import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";

// カメラの映像からQRコードを読み取る部品。
// 読み取れたら onScan に文字列を渡す。同じQRコードが続けて映っている間は、
// 何度も呼び出さないようにしている(同じ内容は3秒間は無視する)。
//
// ※ スマートフォンでカメラを使うには、HTTPS(または localhost)での接続が必要。
export default function QrScanner({ onScan }: { onScan: (text: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const onScanRef = useRef(onScan);
  const [error, setError] = useState<string | null>(null);

  // 最新の onScan を、カメラを起動し直さずに使えるようにしておく
  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = { text: "", at: 0 };

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    async function start() {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          setError("このブラウザ・接続ではカメラを使えません(HTTPS接続が必要です)");
          return;
        }
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        const video = videoRef.current;
        if (stopped || !video) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        video.srcObject = stream;
        await video.play();
        tick();
      } catch (e) {
        const name = (e as { name?: string })?.name;
        setError(
          name === "NotAllowedError"
            ? "カメラの使用が許可されていません。ブラウザの設定でカメラを許可してください"
            : name === "NotFoundError"
              ? "カメラが見つかりません。手入力でラベル番号を入力してください"
              : "カメラを起動できませんでした: " + String((e as { message?: string })?.message ?? e)
        );
      }
    }

    // 約7回/秒で、映像の1コマを調べる(端末の負荷を抑えるため、幅640pxに縮小して解析する)
    function tick() {
      if (stopped) return;
      const video = videoRef.current;
      if (video && ctx && video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth > 0) {
        const scale = Math.min(1, 640 / video.videoWidth);
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
        if (code && code.data) {
          const now = Date.now();
          if (code.data !== last.text || now - last.at > 3000) {
            last = { text: code.data, at: now };
            onScanRef.current(code.data);
          }
        }
      }
      timer = setTimeout(tick, 140);
    }

    start();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div>
      {error ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : (
        <div className="relative rounded-lg overflow-hidden bg-black aspect-[4/3] max-w-md">
          <video ref={videoRef} playsInline muted className="w-full h-full object-cover" />
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-1/2 aspect-square border-2 border-white/80 rounded-lg" />
          </div>
        </div>
      )}
    </div>
  );
}
