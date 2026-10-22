"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import Link from "next/link";

// 伝票上の店舗の並び順(左から右)。60が50・51より左にある点に注意。
const STORES = [
  { code: "20", name: "小原" },
  { code: "30", name: "武山" },
  { code: "35", name: "佐原" },
  { code: "40", name: "平作" },
  { code: "45", name: "衣笠" },
  { code: "60", name: "平成町" },
  { code: "50", name: "新鶴見" },
  { code: "51", name: "南部市場" },
  { code: "77", name: "りんかんモール" },
  { code: "78", name: "南町田" },
  { code: "90", name: "ARAI" },
];

const SUPPLIERS = [
  { code: "185091", name: "横須賀青果物" },
  { code: "133401", name: "駿河屋" },
  { code: "125021", name: "港南商事" },
  { code: "145145", name: "TOKYOフレッシュ大田" },
  { code: "122185", name: "かねはら" },
  { code: "113001", name: "昭島松源" },
];

// 数量入力欄の見た目。上下の増減ボタン(スピナー)を消して、3桁以上でも数字が見えるようにしている。
const NUM_INPUT =
  "border border-gray-300 rounded px-1 text-right " +
  "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";

type StoreQty = { store_code: string; pack_size: number; case_count: number };

// AI(OCR)から返ってくる1行分のデータ
type OcrLine = {
  eos_code: string;
  item_name: string;
  origin: string;
  spec: string;
  store_qty: StoreQty[];
  total_display: string;
  total_qty: number;
};
type OcrResultRaw = {
  supplier_code: string | null;
  target_date: string | null;
  page_no: number;
  lines: OcrLine[];
};

// 画面で扱う1行分。OCRの結果に、品目マスタとの照合用の補助項目(画面だけで使い、DBには保存しない)を足している。
type Line = OcrLine & {
  ocr_item_name: string; // OCRが読み取った品名(元の値)
  master_name: string | null; // 品目マスタに登録されている品名(未登録ならnull)
  looked_up_code: string; // 最後にマスタ照合したEOSコード
};
type OcrResult = Omit<OcrResultRaw, "lines"> & { lines: Line[] };

type OcrErrorDetail = {
  error: string;
  parse_error_message?: string;
  stop_reason?: string;
  raw_length?: number;
  raw_tail?: string;
};

// 画像を長辺2000px・JPEGに縮小してから送る(Vercelの送信サイズ上限を超えないようにするため)
async function fileToBase64(file: File): Promise<{ data: string; mediaType: string }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("画像を読み込めませんでした"));
      i.src = url;
    });
    const MAX = 2000;
    const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("画像を処理できませんでした");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    return { data: dataUrl.split(",")[1], mediaType: "image/jpeg" };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// 店舗別数量から実個数の合計を計算する(自動検算用)
function sumQty(storeQty: StoreQty[]): number {
  return storeQty.reduce((acc, s) => acc + s.pack_size * s.case_count, 0);
}

// 同じ行の中で店舗が重複しているコードを返す(店舗を手で直したときの入力ミス防止)
function duplicateStoreCodes(storeQty: StoreQty[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  storeQty.forEach((s) => {
    if (seen.has(s.store_code)) dup.add(s.store_code);
    seen.add(s.store_code);
  });
  return Array.from(dup);
}

export default function CapturePage() {
  const router = useRouter();
  const supabase = createClient();

  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorDetail, setErrorDetail] = useState<OcrErrorDetail | null>(null);
  const [result, setResult] = useState<OcrResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // EOSコードから、品目マスタに登録されている品名を取得する
  async function fetchMasterNames(codes: string[]): Promise<Record<string, string>> {
    const unique = Array.from(new Set(codes.filter(Boolean)));
    if (unique.length === 0) return {};
    const { data } = await supabase
      .from("m_items")
      .select("item_code, item_name")
      .in("item_code", unique);
    const map: Record<string, string> = {};
    (data ?? []).forEach((r) => {
      map[r.item_code as string] = r.item_name as string;
    });
    return map;
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";          // ← 追加(同じ写真を続けて選んでも反応するようにする)

    setErrorDetail(null);
    setSaveError(null);
    setResult(null);
    setImagePreview(URL.createObjectURL(file));
    setLoading(true);

    try {
      const { data, mediaType } = await fileToBase64(file);
      const res = await fetch("/api/ocr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64: data, mediaType }),
      });
      const text = await res.text();
      let json: any;
      try {
	      json = JSON.parse(text);
      } catch {
	      throw new Error(`サーバーの応答が不正です(HTTP ${res.status}): ${text.slice(0, 150)}`);
      }
      if (!res.ok) {
        setErrorDetail(json as OcrErrorDetail);
      } else {
        const raw = json.result as OcrResultRaw;

        // EOSコードは品名より大きく読みやすい文字なので、マスタに登録があれば
        // マスタの品名を優先して使う(小さい文字の品名の読み間違いを防ぐ)
        const masterNames = await fetchMasterNames(raw.lines.map((l) => l.eos_code));
        const lines: Line[] = raw.lines.map((l) => {
          const master = masterNames[l.eos_code] ?? null;
          return {
            ...l,
            ocr_item_name: l.item_name,
            master_name: master,
            looked_up_code: l.eos_code,
            item_name: master ?? l.item_name,
          };
        });
        setResult({ ...raw, lines });
      }
    } catch (err) {
      setErrorDetail({ error: "読み取り中にエラーが発生しました: " + (err as Error).message });
    } finally {
      setLoading(false);
    }
  }

  function updateLine(index: number, patch: Partial<Line>) {
    setResult((prev) => {
      if (!prev) return prev;
      const lines = [...prev.lines];
      lines[index] = { ...lines[index], ...patch };
      return { ...prev, lines };
    });
  }

  function updateStoreQty(lineIndex: number, storeIndex: number, patch: Partial<StoreQty>) {
    setResult((prev) => {
      if (!prev) return prev;
      const lines = [...prev.lines];
      const storeQty = [...lines[lineIndex].store_qty];
      storeQty[storeIndex] = { ...storeQty[storeIndex], ...patch };
      lines[lineIndex] = { ...lines[lineIndex], store_qty: storeQty };
      return { ...prev, lines };
    });
  }

    // 店舗の行を削除する
  function removeStoreQty(li: number, si: number) {
    if (!result) return;
    const next = result.lines[li].store_qty.filter((_, i) => i !== si);
    updateLine(li, { store_qty: next });
  }

  // 店舗の行を追加する(まだ使っていない店舗を、最初の候補にする)
  function addStoreQty(li: number) {
    if (!result) return;
    const line = result.lines[li];
    const used = new Set(line.store_qty.map((s) => s.store_code));
    const candidate = STORES.find((s) => !used.has(s.code)) ?? STORES[0];
    const last = line.store_qty[line.store_qty.length - 1];
    updateLine(li, {
      store_qty: [
        ...line.store_qty,
        { store_code: candidate.code, pack_size: last?.pack_size ?? 0, case_count: 0 },
      ],
    });
  }

  // EOSコードを手で直したとき、入力欄から離れたタイミングでマスタを再照合する
  async function handleEosBlur(lineIndex: number) {
    const target = result?.lines[lineIndex];
    if (!target || target.looked_up_code === target.eos_code) return;

    const code = target.eos_code;
    const names = await fetchMasterNames([code]);
    const master = names[code] ?? null;
    setResult((prev) => {
      if (!prev) return prev;
      const lines = [...prev.lines];
      const cur = lines[lineIndex];
      if (cur.eos_code !== code) return prev; // 照合中にさらに書き換えられた場合は何もしない
      lines[lineIndex] = {
        ...cur,
        master_name: master,
        looked_up_code: code,
        item_name: master ?? cur.item_name,
      };
      return { ...prev, lines };
    });
  }

  const hasDuplicate = result
    ? result.lines.some((l) => duplicateStoreCodes(l.store_qty).length > 0)
    : false;

  async function handleSave() {
    if (!result) return;
    if (!result.supplier_code) {
      setSaveError("仕入先が特定できていません。先に仕入先を選択してください");
      return;
    }
    if (hasDuplicate) {
      setSaveError("店舗が重複している品目があります。店舗を修正してください");
      return;
    }
    setSaving(true);
    setSaveError(null);

    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      const targetDate = result.target_date || new Date().toISOString().slice(0, 10);
      const orderId = `${result.supplier_code}-${targetDate}-${result.page_no || 1}`;

      // 同じ仕入先・日付・ページが既に登録済みなら、確認のうえ置き換える(二重登録の防止)
      const { data: existing } = await supabase
        .from("t_orders")
        .select("order_id")
        .eq("order_id", orderId)
        .maybeSingle();
      if (existing) {
        const ok = window.confirm(
          "同じ仕入先・対象日・ページの発注データが既に登録されています。\n" +
            "今回の内容で置き換えますか?"
        );
        if (!ok) {
          setSaving(false);
          return;
        }
        // 既存の明細を削除(店舗別数量・変更履歴も連動して削除される)。
        // ラベル発行済みなどで削除できない場合は、エラーとして表示される。
        const { error: delErr } = await supabase
          .from("t_order_lines")
          .delete()
          .eq("order_id", orderId);
        if (delErr) throw delErr;
      }

      // 1. 品目マスタに登録(発注明細はマスタに存在するEOSコードしか登録できないため、先に行う)
      //    既に登録済みの品目は上書きしない(品名の修正は品目マスタ側で行う)
      const itemMap = new Map<string, { item_code: string; item_name: string; default_spec: string | null }>();
      result.lines.forEach((l) => {
        if (!itemMap.has(l.eos_code)) {
          itemMap.set(l.eos_code, {
            item_code: l.eos_code,
            item_name: l.item_name,
            default_spec: l.spec || null,
          });
        }
      });
      const { error: itemErr } = await supabase
        .from("m_items")
        .upsert(Array.from(itemMap.values()), { onConflict: "item_code", ignoreDuplicates: true });
      if (itemErr) throw itemErr;

      // 2. 発注ヘッダ
      const { error: orderErr } = await supabase.from("t_orders").upsert({
        order_id: orderId,
        supplier_code: result.supplier_code,
        target_date: targetDate,
        page_no: result.page_no || 1,
        status: "確定済",
        confirmed_by: user?.id,
        confirmed_at: new Date().toISOString(),
      });
      if (orderErr) throw orderErr;

      // 3. 品目ごとの行と、店舗別数量(数量が0の店舗は保存しない)
      for (const line of result.lines) {
        const { data: lineRow, error: lineErr } = await supabase
          .from("t_order_lines")
          .insert({
            order_id: orderId,
            item_code: line.eos_code,
            origin: line.origin || null,
            spec: line.spec || null,
            total_display: line.total_display,
            total_qty: line.total_qty,
          })
          .select("order_line_id")
          .single();
        if (lineErr) throw lineErr;

        const rows = line.store_qty
          .filter((sq) => sq.pack_size > 0 && sq.case_count > 0)
          .map((sq) => ({
            order_line_id: lineRow.order_line_id,
            store_code: sq.store_code,
            pack_size: sq.pack_size,
            case_count: sq.case_count,
          }));
        if (rows.length > 0) {
          const { error: qtyErr } = await supabase.from("t_order_line_store_qty").insert(rows);
          if (qtyErr) throw qtyErr;
        }
      }

      router.push("/inbound");
    } catch (err) {
      // Supabaseのエラーは Error ではなく {message, details, hint} 形式のオブジェクトで返ってくる
      const e = err as { message?: string; details?: string; hint?: string };
      const msg = e?.message ?? JSON.stringify(err);
      const extra = [e?.details, e?.hint].filter(Boolean).join(" / ");
      setSaveError("保存中にエラーが発生しました: " + msg + (extra ? "(" + extra + ")" : ""));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <Link href="/inbound/csv" className="text-sm text-blue-600 underline mb-3 inline-block">CSVから取り込む →</Link>
      <h1 className="text-lg font-semibold mb-4">発注データ取込(伝票撮影・OCR確認)</h1>

      <div className="bg-white border border-gray-200 rounded-xl p-6 mb-6 max-w-2xl">
        <label className="block text-sm font-medium mb-2">
          伝票の写真を選択(カメラ撮影 または 既存ファイル)
        </label>
        <div className="flex flex-wrap gap-2">
          {/* スマホ内の写真・ファイルから選ぶ */}
          <input
            id="ocr-file"
            type="file"
            accept="image/*"
            onChange={handleFileChange}
            className="hidden"
          />
          <label
            htmlFor="ocr-file"
            className="cursor-pointer inline-block bg-blue-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-blue-700"
          >
            ファイルから選ぶ
          </label>

          {/* その場でカメラ撮影する */}
          <input
            id="ocr-camera"
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handleFileChange}
            className="hidden"
          />
          <label
            htmlFor="ocr-camera"
            className="cursor-pointer inline-block bg-white border border-blue-600 text-blue-600 text-sm px-4 py-2 rounded-lg hover:bg-blue-50"
          >
            カメラで撮影
          </label>
        </div>
        {loading && (
          <p className="text-sm text-gray-500 mt-4">
            AIが読み取り中です…(数十秒〜2分ほどかかる場合があります)
          </p>
        )}

        {errorDetail && (
          <div className="mt-4 text-sm text-red-600 space-y-1">
            <p>{errorDetail.error}</p>
            {errorDetail.parse_error_message && (
              <p className="text-xs text-red-500">詳細: {errorDetail.parse_error_message}</p>
            )}
            {errorDetail.stop_reason && (
              <p className="text-xs text-red-500">
                停止理由(stop_reason): {errorDetail.stop_reason}
              </p>
            )}
            {errorDetail.raw_tail && (
              <details className="text-xs text-red-500">
                <summary className="cursor-pointer">応答の末尾500文字を表示</summary>
                <pre className="whitespace-pre-wrap bg-red-50 p-2 rounded mt-1">
                  {errorDetail.raw_tail}
                </pre>
              </details>
            )}
          </div>
        )}
      </div>

      {result && imagePreview && (
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,480px)_1fr] gap-6 items-start">
          <div className="lg:sticky lg:top-6">
            <p className="text-xs text-gray-500 mb-2">原本画像(クリックで拡大・縮小)</p>
            <img
              src={imagePreview}
              alt="撮影した伝票"
              onClick={() => setZoomed((z) => !z)}
              className={
                "rounded-lg border border-gray-200 cursor-zoom-in transition-transform " +
                (zoomed ? "w-full max-w-none" : "w-full")
              }
            />
          </div>

          <div className="bg-white border border-gray-200 rounded-xl p-6">
            <div className="flex gap-4 mb-4">
              <div>
                <label className="block text-xs text-gray-500 mb-1">仕入先</label>
                <select
                  value={result.supplier_code || ""}
                  onChange={(e) => setResult({ ...result, supplier_code: e.target.value })}
                  className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm"
                >
                  <option value="">(未特定・選択してください)</option>
                  {SUPPLIERS.map((s) => (
                    <option key={s.code} value={s.code}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">対象日</label>
                <input
                  type="date"
                  value={result.target_date || ""}
                  onChange={(e) => setResult({ ...result, target_date: e.target.value })}
                  className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">ページ</label>
                <input
                  type="number"
                  value={result.page_no}
                  onChange={(e) => setResult({ ...result, page_no: Number(e.target.value) })}
                  className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm w-20"
                />
              </div>
            </div>

            <div className="space-y-4">
              {result.lines.map((line, li) => {
                const computedTotal = sumQty(line.store_qty);
                const mismatch = computedTotal !== line.total_qty;
                const dups = duplicateStoreCodes(line.store_qty);
                const hasProblem = mismatch || dups.length > 0;
                return (
                  <div
                    key={li}
                    className={
                      "border rounded-lg p-3 " +
                      (hasProblem ? "border-red-300 bg-red-50" : "border-gray-200")
                    }
                  >
                    <div className="flex gap-2 items-center mb-1 flex-wrap">
                      <input
                        value={line.eos_code}
                        onChange={(e) => updateLine(li, { eos_code: e.target.value })}
                        onBlur={() => handleEosBlur(li)}
                        placeholder="EOS"
                        title="EOSコード(修正するとマスタの品名を再照合します)"
                        className="border border-gray-300 rounded px-2 py-1 text-sm w-20 text-gray-600"
                      />
                      <input
                        value={line.item_name}
                        onChange={(e) => updateLine(li, { item_name: e.target.value })}
                        className="border border-gray-300 rounded px-2 py-1 text-sm font-medium w-56"
                      />
                      <input
                        value={line.spec}
                        onChange={(e) => updateLine(li, { spec: e.target.value })}
                        placeholder="規格"
                        className="border border-gray-300 rounded px-2 py-1 text-sm w-24"
                      />
                      <input
                        value={line.origin}
                        onChange={(e) => updateLine(li, { origin: e.target.value })}
                        placeholder="産地(任意)"
                        className="border border-gray-300 rounded px-2 py-1 text-sm w-24"
                      />
                      <span className="text-xs text-gray-500">全店計:{line.total_display}</span>
                    </div>

                    {/* 品名と品目マスタの照合結果 */}
                    <div className="mb-2 text-xs">
                      {line.master_name === null ? (
                        <span className="text-gray-400">
                          マスタ未登録(確定すると、この品名で登録されます)
                        </span>
                      ) : line.item_name === line.master_name ? (
                        line.ocr_item_name !== line.master_name ? (
                          <span className="text-blue-600">
                            マスタの品名を使用中(OCR読取:「{line.ocr_item_name}」)
                            <button
                              type="button"
                              onClick={() => updateLine(li, { item_name: line.ocr_item_name })}
                              className="underline ml-2"
                            >
                              OCRの読取に戻す
                            </button>
                          </span>
                        ) : (
                          <span className="text-green-600">マスタの品名と一致</span>
                        )
                      ) : (
                        <span className="text-amber-600">
                          マスタの品名:「{line.master_name}」
                          <button
                            type="button"
                            onClick={() => updateLine(li, { item_name: line.master_name as string })}
                            className="underline ml-2"
                          >
                            マスタの品名を使う
                          </button>
                        </span>
                      )}
                    </div>

                    {mismatch && (
                      <p className="text-xs text-red-600 font-medium mb-2">
                        ⚠ 店舗別の合計は{computedTotal}。全店計({line.total_qty})と不一致
                      </p>
                    )}
                    {dups.length > 0 && (
                      <p className="text-xs text-red-600 font-medium mb-2">
                        ⚠ 店舗が重複しています({dups.join("、")})。店舗を修正してください
                      </p>
                    )}

                    <div className="flex flex-wrap gap-2">
                      {line.store_qty.map((sq, si) => (
                        <div
                          key={si}
                          className="flex items-center gap-1 bg-gray-50 border border-gray-200 rounded px-2 py-1 text-xs"
                        >
                          <select
                            value={sq.store_code}
                            onChange={(e) => updateStoreQty(li, si, { store_code: e.target.value })}
                            title="店舗(ズレている場合はここで直せます)"
                            className="border border-gray-300 rounded px-1 py-0.5 text-xs w-24"
                          >
                            {STORES.map((s) => (
                              <option key={s.code} value={s.code}>
                                {s.code} {s.name}
                              </option>
                            ))}
                            {!STORES.some((s) => s.code === sq.store_code) && (
                              <option value={sq.store_code}>{sq.store_code}(不明)</option>
                            )}
                          </select>
                          <input
                            type="number"
                            value={sq.pack_size}
                            onChange={(e) =>
                              updateStoreQty(li, si, { pack_size: Number(e.target.value) })
                            }
                            title="入数"
                            className={NUM_INPUT + " w-12"}
                          />
                          <span>×</span>
                          <input
                            type="number"
                            value={sq.case_count}
                            onChange={(e) =>
                              updateStoreQty(li, si, { case_count: Number(e.target.value) })
                            }
                            title="箱数"
                            className={NUM_INPUT + " w-14"}
                          />
                          <button
                            type="button"
                            onClick={() => removeStoreQty(li, si)}
                            title="この店舗の行を削除"
                            className="ml-1 text-gray-400 hover:text-red-600 font-bold px-1"
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={() => addStoreQty(li)}
                      className="mt-1 text-xs text-blue-600 hover:underline"
                    >
                      + 店舗を追加
                    </button>
                  </div>
                );
              })}
            </div>

            {saveError && <p className="text-sm text-red-600 mt-4">{saveError}</p>}

            <button
              onClick={handleSave}
              disabled={saving || hasDuplicate}
              className="mt-6 bg-brand text-white rounded-lg px-5 py-2.5 text-sm font-medium disabled:opacity-50"
            >
              {saving ? "保存中..." : "この内容で確定する"}
            </button>
            {hasDuplicate && (
              <p className="text-xs text-red-600 mt-2">
                店舗が重複している品目(赤枠)を修正すると、確定できるようになります
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
