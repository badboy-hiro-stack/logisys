"use client";

import { useEffect, useState } from "react";

// Smooth Print(Android)でラベルを印刷できるかを試すための、テスト用の画面です。
// メニューには出していません。アドレス /smoothprint-test を直接開いて使います。

const OBJECTS: { key: string; label: string; kind: "text" | "barcode"; value: string }[] = [
  { key: "item", label: "品目(item)", kind: "text", value: "テスト品目" },
  { key: "store", label: "店舗(store)", kind: "text", value: "テスト店(A)" },
  { key: "qty", label: "入数×箱数(qty)", kind: "text", value: "20×3" },
  { key: "origin", label: "産地(origin)", kind: "text", value: "宮崎" },
  { key: "spec", label: "規格(spec)", kind: "text", value: "L" },
  { key: "date", label: "納品日(date)", kind: "text", value: "2026/10/16" },
  { key: "supplier", label: "仕入先(supplier)", kind: "text", value: "テスト仕入先" },
  { key: "qr", label: "QR(qr)", kind: "barcode", value: "TEST-261016-0001" },
];

export default function SmoothPrintTestPage() {
  const [filename, setFilename] = useState("");
  const [size, setSize] = useState("");
  const [extra, setExtra] = useState("");
  const [copies, setCopies] = useState("1");
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(OBJECTS.map((o) => [o.key, o.value])),
  );
  const [result, setResult] = useState("");

  useEffect(() => {
    setFilename(`${window.location.origin}/smoothprint/label.lbx`);
  }, []);

  function build(base: string): string {
    const parts: string[] = [];
    parts.push(`filename=${encodeURIComponent(filename)}`);
    if (size.trim()) parts.push(`size=${encodeURIComponent(size.trim())}`);
    parts.push(`copies=${encodeURIComponent(copies || "1")}`);
    for (const o of OBJECTS) {
      parts.push(`${o.kind}_${o.key}=${encodeURIComponent(values[o.key] ?? "")}`);
    }
    // 追加のパラメータ(例: paperType=roll&tapeWidth=102)をそのまま足せる
    if (extra.trim()) parts.push(extra.trim().replace(/^[?&]/, ""));
    return `${base}?${parts.join("&")}`;
  }

  const httpUrl = build("http://localhost:8088/print");
  const schemeUrl = build("brotherwebprint://print");

  async function printHttp() {
    setResult("接続中…");
    try {
      const res = await fetch(httpUrl, { method: "POST" });
      const text = await res.text();
      setResult(`HTTP ${res.status}\n${text}`);
    } catch (e) {
      setResult(
        "通信できませんでした: " +
          (e instanceof Error ? e.message : String(e)) +
          "\n(Smooth Print が起動していない、またはブラウザがこの通信を許可していない可能性があります)",
      );
    }
  }

  function printScheme() {
    setResult("Smooth Print を呼び出しました。アプリの画面と、ラベルが出るかを確認してください。");
    window.location.href = schemeUrl;
  }

  const input = "border border-gray-300 rounded-lg px-2 py-1 text-sm w-full";

  return (
    <div className="max-w-2xl">
      <h1 className="text-lg font-semibold mb-1">Smooth Print テスト印刷(Android)</h1>
      <p className="text-sm text-gray-600 mb-4">
        Android に Smooth Print を入れてプリンターとつないだあと、この画面から1枚だけ印刷を試します。
      </p>

      <section className="bg-white border border-gray-200 rounded-xl p-4 mb-4 space-y-3 text-sm">
        <label className="block">
          <span className="text-xs text-gray-500">テンプレート(filename)・アドレスまたは共有済みのファイル名</span>
          <input value={filename} onChange={(e) => setFilename(e.target.value)} className={input} />
        </label>
        <label className="block">
          <span className="text-xs text-gray-500">用紙(size)・用紙情報ファイル(.bin)またはサイズの指定。分からなければ空欄</span>
          <input value={size} onChange={(e) => setSize(e.target.value)} className={input} />
        </label>
        <label className="block">
          <span className="text-xs text-gray-500">追加のパラメータ(任意。例: paperType=roll&amp;tapeWidth=102)</span>
          <input value={extra} onChange={(e) => setExtra(e.target.value)} className={input} />
        </label>
        <label className="block w-32">
          <span className="text-xs text-gray-500">枚数(copies)</span>
          <input value={copies} onChange={(e) => setCopies(e.target.value)} className={input} />
        </label>
      </section>

      <section className="bg-white border border-gray-200 rounded-xl p-4 mb-4 space-y-2 text-sm">
        <h2 className="font-semibold">ラベルに入れる内容(テンプレートのオブジェクト名と同じ名前)</h2>
        {OBJECTS.map((o) => (
          <label key={o.key} className="flex items-center gap-3">
            <span className="w-40 text-xs text-gray-500">{o.label}</span>
            <input
              value={values[o.key] ?? ""}
              onChange={(e) => setValues({ ...values, [o.key]: e.target.value })}
              className={input}
            />
          </label>
        ))}
      </section>

      <div className="flex flex-wrap gap-3 mb-4">
        <button type="button" onClick={printHttp} className="bg-blue-600 text-white rounded-lg px-4 py-2 text-sm">
          ① HTTPで印刷(localhost:8088)
        </button>
        <button type="button" onClick={printScheme} className="border border-blue-600 text-blue-600 rounded-lg px-4 py-2 text-sm">
          ② URLスキームで印刷
        </button>
      </div>

      {result && (
        <pre className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-xs whitespace-pre-wrap mb-4">{result}</pre>
      )}

      <details className="text-xs text-gray-600">
        <summary className="cursor-pointer">作られるアドレスを見る</summary>
        <p className="mt-2 break-all">HTTP: {httpUrl}</p>
        <p className="mt-2 break-all">スキーム: {schemeUrl}</p>
      </details>
    </div>
  );
}
