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
// 追加した機能:
//  ・paused=true の間は、カメラを完全に停止する(誤って別のQRを読み込まないため)。
//    paused が false に戻ると、カメラを自動で再起動する。
//  ・ライト(トーチ)のON/OFFボタンを表示する。
//    端末が「対応」と申告していなくても(Windowsなど)、試しに表示する。
//    押して制御できなかった場合は、メッセージを出してボタンを隠す。
//
// ※ スマートフォンでカメラを使うには、HTTPS(または localhost)での接続が必要。

type BarcodeDetectorLike = {
  detect: (source: CanvasImageSource) => Promise<{ rawValue: string }[]>;
};

export default function QrScanner({
  onScan,
  paused = false,
}: {
  onScan: (text: string) => void;
  paused?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const onScanRef = useRef(onScan);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const torchOnRef = useRef(false); // ライトをつけたい状態(カメラを再起動しても引き継ぐ)
  const [error, setError] = useState<string | null>(null);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [torchMsg, setTorchMsg] = useState<string | null>(null);

  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  useEffect(() => {
    // 一時停止中は、カメラを起動しない(前の状態の後始末で、カメラは止まっている)
    if (paused) return;

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

        const track = stream.getVideoTracks()[0];
        trackRef.current = track;

        // 対応していれば、連続オートフォーカスにする(小さなQRをはっきり映すため)
        try {
          const caps = (track.getCapabilities?.() ?? {}) as { focusMode?: string[] };
          if (caps.focusMode?.includes("continuous")) {
            await track.applyConstraints({
              advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet],
            });
          }
        } catch {
          // 対応していない端末では何もしない
        }

        // ライト(トーチ)のボタンを表示する。
        // 端末が「対応」と申告していなくても(Windowsなど)、試しに表示する。
        // 押して失敗したら、ボタンを隠す
        try {
          setTorchSupported(true);
          // 再起動のときは、直前のライトの状態を引き継ぐ
          if (torchOnRef.current) {
            await track.applyConstraints({
              advanced: [{ torch: true } as unknown as MediaTrackConstraintSet],
            });
          }
        } catch {
          setTorchSupported(false);
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

          // 読み取り中に停止されていたら、結果は捨てる
          if (found && !stopped) emit(found);
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
      trackRef.current = null;
    };
  }, [paused]);

  // ライトのON/OFFを切り替える
  async function toggleTorch() {
    const track = trackRef.current;
    if (!track) return;
    const next = !torchOnRef.current;
    try {
      await track.applyConstraints({
        advanced: [{ torch: next } as unknown as MediaTrackConstraintSet],
      });
      torchOnRef.current = next;
      setTorchOn(next);
      setTorchMsg(null);
    } catch {
      // 切り替えられない端末では、ボタンを隠して、理由を表示する
      setTorchSupported(false);
      setTorchMsg("この端末・ブラウザでは、ライトを制御できませんでした");
    }
  }

  return (
    <div>
      {error ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : (
        <div className="relative rounded-lg overflow-hidden bg-black aspect-[4/3] max-w-md">
          <video ref={videoRef} playsInline muted className="w-full h-full object-cover" />
          {!paused && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="w-2/3 aspect-square border-2 border-white/80 rounded-lg" />
            </div>
          )}
          {paused && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/70 text-white text-base">
              カメラ停止中
            </div>
          )}
          {!paused && torchSupported && (
            <button
              type="button"
              onClick={toggleTorch}
              className={
                "absolute top-2 right-2 rounded-full px-4 py-2 text-base font-medium shadow " +
                (torchOn ? "bg-yellow-300 text-black" : "bg-black/60 text-white border border-white/60")
              }
            >
              ライト {torchOn ? "ON" : "OFF"}
            </button>
          )}
          {!paused && torchMsg && (
            <p className="absolute top-2 left-2 right-2 rounded bg-black/70 text-white text-xs px-2 py-1">
              {torchMsg}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
