"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { one } from "@/lib/inbound";
import { errorText, formatStoreLabel, printLabel } from "@/lib/label";
import { formatTime, getLocationId, storeTitle, type LabelView } from "@/lib/outbound";
import QrScanner from "@/components/QrScanner";

const REASONS = ["汚損・破損", "印刷エラー", "印字内容の誤り", "その他"] as const;
type Reason = (typeof REASONS)[number];

type ReissueRow = {
  reissue_id: number;
  old_label_id: string;
  new_label_id: string;
  reason: string;
  reissued_at: string;
  m_users: { user_name: string } | { user_name: string }[] | null;
};

// 再発行が終わったあとの表示(印刷に失敗した場合は、もう一度印刷できるようにする)
type Done = { newId: string; printed: boolean; printError: string | null };

// ラベルに印字する納品日の書き方。
// 通常のラベル(入荷画面で発行するもの)と書き方が違う場合は、ここだけを直す。
function formatLabelDate(d: string): string {
  const [y, m, day] = d.split("-");
  return `${y}/${m}/${day}`;
}

export default function ReissuePage() {
  const supabase = createClient();

  const [cameraOn, setCameraOn] = useState(false);
  const [manual, setManual] = useState("");
  const [looking, setLooking] = useState(false);
  const [target, setTarget] = useState<LabelView | null>(null);
  const [notFoundId, setNotFoundId] = useState<string | null>(null);

  const [reason, setReason] = useState<Reason | "">("");
  const [allowInspected, setAllowInspected] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  const [list, setList] = useState<ReissueRow[]>([]);
  const [printingId, setPrintingId] = useState<string | null>(null);
  const [listMessage, setListMessage] = useState<string | null>(null);

  // ---- 本日の再発行履歴 ------------------------------------------------
  const loadList = useCallback(async () => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const { data, error: e } = await supabase
      .from("t_label_reissues")
      .select("reissue_id, old_label_id, new_label_id, reason, reissued_at, m_users(user_name)")
      .gte("reissued_at", start.toISOString())
      .order("reissued_at", { ascending: false });
    if (!e) setList((data ?? []) as unknown as ReissueRow[]);
  }, [supabase]);

  useEffect(() => {
    loadList();
  }, [loadList]);

  // ---- ラベルの検索 ----------------------------------------------------
  async function lookup(raw: string) {
    const id = raw.trim();
    if (!id) return;
    setLooking(true);
    setError(null);
    setDone(null);
    setNotFoundId(null);
    setAllowInspected(false);
    const { data, error: e } = await supabase
      .from("v_labels")
      .select("*")
      .eq("label_id", id)
      .maybeSingle();
    setLooking(false);
    if (e) {
      setError("ラベルの検索に失敗しました: " + e.message);
      return;
    }
    if (!data) {
      setTarget(null);
      setNotFoundId(id);
      return;
    }
    setTarget(data as unknown as LabelView);
    setCameraOn(false);
  }

  // ---- 印刷(ラベル番号を指定して、データベースの内容で印刷する) -------
  async function printById(labelId: string): Promise<void> {
    const { data, error: e } = await supabase
      .from("v_labels")
      .select("*")
      .eq("label_id", labelId)
      .maybeSingle();
    if (e || !data) throw new Error("印刷するラベルの情報を取得できませんでした");
    const l = data as unknown as LabelView;
    await printLabel({
      item: l.item_name,
      store: formatStoreLabel(l.store_name, l.store_sign),
      qty: l.qty_text ?? `${l.pack_size}×${l.case_count}`,
      origin: l.origin ?? "",
      spec: l.spec ?? "",
      date: formatLabelDate(l.target_date),
      supplier: l.supplier_name,
      qr: l.label_id,
    });
  }

  // ---- 再発行 ----------------------------------------------------------
  async function reissue() {
    if (!target || !reason) return;
    setWorking(true);
    setError(null);
    const { data, error: e } = await supabase.rpc("reissue_label", {
      p_old_label_id: target.label_id,
      p_reason: reason,
      p_location_id: getLocationId(),
      p_allow_inspected: allowInspected,
    });
    if (e) {
      setWorking(false);
      setError("再発行に失敗しました: " + e.message);
      return;
    }
    const res = data as { result: string; new_label_id?: string } | null;
    if (!res || res.result !== "ok" || !res.new_label_id) {
      setWorking(false);
      const msg: Record<string, string> = {
        not_found: "そのラベル番号は登録されていません。",
        void: "このラベルは既に無効です(再発行済みです)。新しいラベルを使ってください。",
        already_inspected:
          "このラベルは出荷検品が済んでいます。再発行する場合は、下の確認にチェックを入れてください。",
      };
      setError(msg[res?.result ?? ""] ?? "再発行できませんでした。");
      return;
    }

    // 再発行できた。続けて新しいラベルを印刷する
    const newId = res.new_label_id;
    try {
      await printById(newId);
      setDone({ newId, printed: true, printError: null });
    } catch (pe) {
      setDone({ newId, printed: false, printError: errorText(pe) });
    }
    setWorking(false);
    setTarget(null);
    setManual("");
    setReason("");
    setAllowInspected(false);
    loadList();
  }

  async function reprint(labelId: string, from: "done" | "list") {
    setPrintingId(labelId);
    setListMessage(null);
    try {
      await printById(labelId);
      if (from === "done") setDone((d) => (d ? { ...d, printed: true, printError: null } : d));
      else setListMessage(`${labelId} を印刷しました。出てきたラベルを確認してください。`);
    } catch (pe) {
      if (from === "done") setDone((d) => (d ? { ...d, printError: errorText(pe) } : d));
      else setListMessage("印刷できませんでした: " + errorText(pe));
    }
    setPrintingId(null);
  }

  const isInspected = target?.status === "検品済";
  const isVoid = target?.status === "無効";
  const canReissue = !!target && !isVoid && !!reason && (!isInspected || allowInspected) && !working;

  return (
    <div className="max-w-2xl">
      <h1 className="text-lg font-semibold mb-1">ラベル再発行</h1>
      <p className="text-sm text-gray-600 mb-4">
        汚れ・破れ・印字ミスなどのラベルを、新しい番号で出し直します。元のラベルは自動で無効になり、
        出荷検品では読み取れなくなります。
      </p>

      {/* 1. ラベルを探す */}
      <section className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
        <h2 className="text-sm font-semibold mb-2">1. 再発行するラベルを探す</h2>
        <div className="flex gap-2 mb-2">
          <button
            type="button"
            onClick={() => setCameraOn((v) => !v)}
            className="bg-blue-600 text-white text-sm px-4 py-2 rounded-lg hover:bg-blue-700"
          >
            {cameraOn ? "カメラを閉じる" : "カメラで読み取る"}
          </button>
        </div>
        {cameraOn && (
          <div className="mb-3">
            <QrScanner onScan={lookup} />
          </div>
        )}
        <div className="flex gap-2">
          <input
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") lookup(manual);
            }}
            placeholder="ラベル番号を入力(例: 185091-260924-0001)"
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={() => lookup(manual)}
            disabled={looking || !manual.trim()}
            className="border border-blue-600 text-blue-600 text-sm px-4 py-2 rounded-lg disabled:opacity-40"
          >
            検索
          </button>
        </div>
        {notFoundId && (
          <p className="text-sm text-red-600 mt-2">
            「{notFoundId}」は登録されていません。番号をご確認ください。
          </p>
        )}
      </section>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3 mb-4">
          {error}
        </div>
      )}

      {/* 2. 内容の確認と理由の選択 */}
      {target && (
        <section className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
          <h2 className="text-sm font-semibold mb-2">2. 内容を確認して、理由を選ぶ</h2>
          <div className="border border-gray-200 rounded-lg p-3 mb-3 text-sm space-y-1">
            <div className="text-xs text-gray-500">{target.label_id}</div>
            <div className="font-semibold text-base">{target.item_name}</div>
            <div>
              {storeTitle(target.store_code, target.store_name, target.store_sign)}　/　
              <span className="font-semibold">
                {target.qty_text ?? `${target.pack_size}×${target.case_count}`}
              </span>
            </div>
            <div className="text-gray-600">
              {target.supplier_name}　納品日 {formatLabelDate(target.target_date)}
              {target.origin ? `　産地 ${target.origin}` : ""}
              {target.spec ? `　${target.spec}` : ""}
            </div>
            <div>
              状態:{" "}
              <span
                className={
                  target.status === "未検品"
                    ? "text-gray-700"
                    : target.status === "検品済"
                      ? "text-green-700 font-semibold"
                      : "text-red-600 font-semibold"
                }
              >
                {target.status}
              </span>
              {isInspected && target.confirmed_by_name
                ? `(${target.confirmed_by_name} ${formatTime(target.confirmed_at)})`
                : ""}
            </div>
          </div>

          {isVoid && (
            <p className="text-sm text-red-600 mb-3">
              このラベルは既に無効です(再発行済み)。新しいラベルを使ってください。
            </p>
          )}

          {isInspected && (
            <label className="flex items-start gap-2 text-sm bg-amber-50 border border-amber-200 rounded-lg p-3 mb-3">
              <input
                type="checkbox"
                checked={allowInspected}
                onChange={(e) => setAllowInspected(e.target.checked)}
                className="mt-1"
              />
              <span>
                このラベルは<b>出荷検品が済んでいます</b>。再発行すると新しいラベルは未検品になり、
                出荷検品をやり直す必要があります。それでも再発行する。
              </span>
            </label>
          )}

          {!isVoid && (
            <>
              <div className="text-sm mb-1">再発行の理由</div>
              <div className="grid grid-cols-2 gap-2 mb-3">
                {REASONS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setReason(r)}
                    className={
                      "border rounded-lg px-3 py-2 text-sm " +
                      (reason === r
                        ? "border-blue-600 bg-blue-50 text-blue-700 font-semibold"
                        : "border-gray-300 text-gray-700")
                    }
                  >
                    {r}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={reissue}
                disabled={!canReissue}
                className="w-full bg-blue-600 text-white text-sm font-semibold px-4 py-3 rounded-lg disabled:opacity-40"
              >
                {working ? "再発行しています…" : "再発行して印刷する"}
              </button>
              <p className="text-xs text-gray-500 mt-2">
                ※ 印刷はFZ-M1(ラベルプリンターをつないだ端末)で行います。スマートフォンで再発行した場合は、
                下の「本日の再発行」から、FZ-M1で「再印刷」を押してください。
              </p>
            </>
          )}
        </section>
      )}

      {/* 3. 結果 */}
      {done && (
        <section
          className={
            "rounded-xl p-4 mb-4 border " +
            (done.printed ? "bg-green-50 border-green-200" : "bg-amber-50 border-amber-200")
          }
        >
          <div className="text-sm font-semibold mb-1">
            {done.printed ? "再発行して、印刷しました" : "再発行しました(印刷は未完了)"}
          </div>
          <div className="text-sm">
            新しいラベル番号: <span className="font-mono">{done.newId}</span>
          </div>
          {done.printed ? (
            <p className="text-xs text-gray-600 mt-1">
              出てきたラベルを確認してください。元のラベルは剥がして処分してください。
            </p>
          ) : (
            <>
              <p className="text-sm text-amber-800 mt-2">
                印刷できませんでした: {done.printError}
              </p>
              <p className="text-xs text-gray-600 mt-1">
                新しいラベルの番号は登録済みです。FZ-M1で下のボタン(または「本日の再発行」)から
                印刷してください。
              </p>
              <button
                type="button"
                onClick={() => reprint(done.newId, "done")}
                disabled={printingId === done.newId}
                className="mt-2 bg-blue-600 text-white text-sm px-4 py-2 rounded-lg disabled:opacity-40"
              >
                {printingId === done.newId ? "印刷中…" : "もう一度印刷する"}
              </button>
            </>
          )}
        </section>
      )}

      {/* 本日の再発行 */}
      <section className="bg-white border border-gray-200 rounded-xl p-4">
        <h2 className="text-sm font-semibold mb-2">本日の再発行({list.length}件)</h2>
        {listMessage && <p className="text-sm text-gray-700 mb-2">{listMessage}</p>}
        {list.length === 0 ? (
          <p className="text-sm text-gray-500">本日の再発行はまだありません。</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {list.map((r) => (
              <li key={r.reissue_id} className="py-2 text-sm flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-gray-500">
                    {formatTime(r.reissued_at)}　{one(r.m_users)?.user_name ?? ""}　{r.reason}
                  </div>
                  <div className="font-mono text-xs break-all">
                    {r.old_label_id} → <b>{r.new_label_id}</b>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => reprint(r.new_label_id, "list")}
                  disabled={printingId === r.new_label_id}
                  className="shrink-0 border border-blue-600 text-blue-600 text-xs px-3 py-1.5 rounded-lg disabled:opacity-40"
                >
                  {printingId === r.new_label_id ? "印刷中…" : "再印刷"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
