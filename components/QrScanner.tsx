"use client";

import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";

// カメラの映像からQRコードを読み取る部品。
// 読み取れたら onScan に文字列を渡す。同じQRコードが続けて映っている間は、
// 何度も呼び出さないようにしている(同じ内容は3秒間は無視する)。
//
// 読み取り方式:
//  1) 端末標準のQR読み取り(BarcodeDetector)が使える場合はそれを優先(速くて小さなQRに強い)
//  2) 使えない端末(iPhoneなど)では jsQR で読み取る(縮小せず、高解像度で解析)
//
// ※ スマートフォンでカメラを使うには、HTTPS(または localhost)での接続が必要。

type BarcodeDetectorLike = {
  detect: (source: CanvasImageSource) => Promise<{ rawValue: string }[]>;
};

export default function QrScanner({ onScan }: { onScan: (text: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const onScanRef = useRef(onScan);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    let last = { text: "", at: 0 };

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    // 端末標準のQR読み取り(あれば使う)
    let detector: BarcodeDetectorLike | null = null;
    try {
      const BD = (window as unknown as {
        BarcodeDetector?: new (opts: { formats: string[] }) => BarcodeDetectorLike;
      }).BarcodeDetector;
      if (BD) detector = new BD({ formats: ["qr_code"] });
    } catch {
      detector = null;
    }

    function emit(text: string) {
      const now = Date.now();
      if (text !== last.text || now - last.at > 3000) {
        last = { text, at: now };
        onScanRef.current(text);
      }
    }

    async function start() {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          setError("このブラウザ・接続ではカメラを使えません(HTTPS接続が必要です)");
          return;
        }
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });

        // 対応していれば、連続オートフォーカスにする(小さなQRをはっきり映すため)
        try {
          const track = stream.getVideoTracks()[0];
          const caps = (track.getCapabilities?.() ?? {}) as { focusMode?: string[] };
          if (caps.focusMode?.includes("continuous")) {
            await track.applyConstraints({
              advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet],
            });
          }
        } catch {
          // 対応していない端末では何もしない
        }

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

    // 約6回/秒で、映像の1コマを調べる
    async function tick() {
      if (stopped) return;
      const video = videoRef.current;
      if (!busy && video && video.readyState >= 2 && video.videoWidth > 0) {
        busy = true;
        try {
          let found = "";

          // 1) 端末標準の読み取り
          if (detector) {
            try {
              const results = await detector.detect(video);
              if (results.length > 0 && results[0].rawValue) found = results[0].rawValue;
            } catch {
              // 失敗したら jsQR に任せる
            }
          }

          // 2) jsQR(縮小しすぎない:最大1280px)
          if (!found && ctx) {
            const scale = Math.min(1, 1280 / video.videoWidth);
            canvas.width = Math.round(video.videoWidth * scale);
            canvas.height = Math.round(video.videoHeight * scale);
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(img.data, img.width, img.height, {
              inversionAttempts: "attemptBoth",
            });
            if (code && code.data) found = code.data;
          }

          if (found) emit(found);
        } finally {
          busy = false;
        }
      }
      timer = setTimeout(tick, 160);
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
            <div className="w-2/3 aspect-square border-2 border-white/80 rounded-lg" />
          </div>
        </div>
      )}
    </div>
  );
}
