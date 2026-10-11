"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { one } from "@/lib/inbound";
import { errorText } from "@/lib/label";
import { formatTime, getLocationId, storeTitle, type LabelView } from "@/lib/outbound";
import QrScanner from "@/components/QrScanner";

type Store = { store_name: string; sign: string | null };
type Dispatch = { completed_at: string; name: string | null };

// 読み取った(または手入力した)ラベルの照合結果
type Current =
  | { kind: "ready"; label: LabelView } // 確定できる
  | { kind: "confirmed"; label: LabelView } // 既に確定済み
  | { kind: "store_mismatch"; label: LabelView } // 他の店舗向け
  | { kind: "void"; label: LabelView } // 無効(再発行で置き換えられた)
  | { kind: "date_mismatch"; label: LabelView } // 納品日が違う
  | { kind: "not_found"; id: string }; // 登録されていない

export default function OutboundStorePage() {
  const supabase = createClient();
  const params = useParams<{ date: string; storeCode: string }>();
  const date = params.date;
  const storeCode = params.storeCode;

  const [store, setStore] = useState<Store | null>(null);
  const [rows, setRows] = useState<LabelView[]>([]);
  const [dispatch, setDispatch] = useState<Dispatch | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [cameraOn, setCameraOn] = useState(false);
  const [manual, setManual] = useState("");
  const [current, setCurrent] = useState<Current | null>(null);
  const [looking, setLooking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // ---- データの取得 ----------------------------------------------------
  const loadAll = useCallback(async () => {
    const [st, lab, disp] = await Promise.all([
      supabase.from("m_stores").select("store_name, sign").eq("store_code", storeCode).maybeSingle(),
      supabase
        .from("v_labels")
        .select("*")
        .eq("target_date", date)
        .eq("store_code", storeCode)
        .neq("status", "無効")
        .order("label_id"),
      supabase
        .from("t_store_dispatch")
        .select("completed_at, m_users(user_name)")
        .eq("target_date", date)
        .eq("store_code", storeCode)
        .maybeSingle(),
    ]);
    if (lab.error) {
      setLoadError("ラベルの取得に失敗しました: " + lab.error.message);
      return;
    }
    setLoadError(null);
    setStore((st.data ?? null) as unknown as Store | null);
    setRows((lab.data ?? []) as unknown as LabelView[]);
    const d = disp.data as unknown as {
      completed_at: string;
      m_users: { user_name: string } | { user_name: string }[] | null;
    } | null;
    setDispatch(d ? { completed_at: d.completed_at, name: one(d.m_users)?.user_name ?? null } : null);
  }, [supabase, date, storeCode]);

  useEffect(() => {
    (async () => {
      await loadAll();
      setLoading(false);
    })();
    // 他の担当者の確定も反映されるよう、8秒ごとに自動で更新する
    const t = setInterval(loadAll, 8000);
    return () => clearInterval(t);
  }, [loadAll]);

  // 「確定しました」の表示は、少ししたら消す
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 3000);
    return () => clearTimeout(t);
  }, [flash]);

  // ---- 集計 ------------------------------------------------------------
  const total = rows.length;
  const done = rows.filter((r) => r.status === "検品済").length;
  const pending = total - done;
  const complete = total > 0 && pending === 0;

  // 未確定のラベルを先に、確定済みを後に並べる
  const sorted = useMemo(
    () =>
      [...rows].sort((a, b) => {
        const pa = a.status === "検品済" ? 1 : 0;
        const pb = b.status === "検品済" ? 1 : 0;
        return pa - pb || a.supplier_code.localeCompare(b.supplier_code) || a.label_id.localeCompare(b.label_id);
      }),
    [rows]
  );
  const staffNames = Array.from(
    new Set(rows.map((r) => r.confirmed_by_name).filter((n): n is string => !!n))
  );

  // ---- ラベルの照合(読み取り・手入力) ---------------------------------
  const lookup = useCallback(
    async (raw: string) => {
      // 全角で入力されても照合できるように、半角に直す
      const id = raw.normalize("NFKC").trim();
      if (!id) return;
      setActionError(null);
      setLooking(true);
      try {
        const { data, error } = await supabase
          .from("v_labels")
          .select("*")
          .eq("label_id", id)
          .maybeSingle();
        if (error) throw error;
        if (!data) {
          setCurrent({ kind: "not_found", id });
          return;
        }
        const label = data as unknown as LabelView;
        if (label.store_code !== storeCode) {
          setCurrent({ kind: "store_mismatch", label });
          // 他店の商品が紛れていた記録を残す(確定はされない)
          supabase
            .rpc("confirm_outbound_label", {
              p_label_id: id,
              p_target_store: storeCode,
              p_location_id: getLocationId(),
            })
            .then(() => undefined);
        } else if (label.status === "無効") {
          setCurrent({ kind: "void", label });
        } else if (label.target_date !== date) {
          setCurrent({ kind: "date_mismatch", label });
        } else if (label.status === "検品済") {
          setCurrent({ kind: "confirmed", label });
        } else {
          setCurrent({ kind: "ready", label });
        }
      } catch (e) {
        setActionError("ラベルの照合に失敗しました: " + errorText(e));
      } finally {
        setLooking(false);
      }
    },
    [supabase, storeCode, date]
  );

  function submitManual() {
    const v = manual;
    setManual("");
    lookup(v);
  }

  // ---- 積込確定 --------------------------------------------------------
  async function confirmCurrent() {
    if (!current || current.kind !== "ready") return;
    const label = current.label;
    setConfirming(true);
    setActionError(null);
    try {
      const { data, error } = await supabase.rpc("confirm_outbound_label", {
        p_label_id: label.label_id,
        p_target_store: storeCode,
        p_location_id: getLocationId(),
      });
      if (error) throw error;
      const res = data as {
        result: string;
        confirmed_at?: string;
        confirmed_by_name?: string;
      };
      if (res.result === "ok") {
        setFlash(`確定しました:${label.item_name} ${label.pack_size}×${label.case_count}`);
        setCurrent(null);
      } else if (res.result === "already_confirmed") {
        // 他の担当者が先に確定していた
        setCurrent({
          kind: "confirmed",
          label: {
            ...label,
            status: "検品済",
            confirmed_at: res.confirmed_at ?? null,
            confirmed_by_name: res.confirmed_by_name ?? null,
          },
        });
      } else if (res.result === "store_mismatch") {
        setCurrent({ kind: "store_mismatch", label });
      } else if (res.result === "void") {
        setCurrent({ kind: "void", label });
      } else {
        setCurrent({ kind: "not_found", id: label.label_id });
      }
      await loadAll();
    } catch (e) {
      setActionError("確定に失敗しました: " + errorText(e));
    } finally {
      setConfirming(false);
    }
  }

  // ---- 配送OK ----------------------------------------------------------
  async function markDispatchOk() {
    setConfirming(true);
    setActionError(null);
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const { error } = await supabase.from("t_store_dispatch").upsert({
        target_date: date,
        store_code: storeCode,
        completed_by: user?.id ?? null,
        completed_at: new Date().toISOString(),
        location_id: getLocationId(),
      });
      if (error) throw error;
      await loadAll();
    } catch (e) {
      setActionError("配送OKの登録に失敗しました: " + errorText(e));
    } finally {
      setConfirming(false);
    }
  }

  async function undoDispatchOk() {
    if (!window.confirm("配送OKを取り消します。よろしいですか?")) return;
    setConfirming(true);
    try {
      const { error } = await supabase
        .from("t_store_dispatch")
        .delete()
        .eq("target_date", date)
        .eq("store_code", storeCode);
      if (error) throw error;
      await loadAll();
    } catch (e) {
      setActionError("取り消しに失敗しました: " + errorText(e));
    } finally {
      setConfirming(false);
    }
  }

  // ---- 表示 ------------------------------------------------------------
  const title = store ? storeTitle(storeCode, store.store_name, store.sign) : storeCode;

  function onLeave(e: React.MouseEvent) {
    if (pending > 0 && !dispatch) {
      if (!window.confirm(`未確定のラベルが${pending}件あります。店舗の選択に戻りますか?`)) {
        e.preventDefault();
      }
    }
  }

  function renderCurrent(c: Current) {
    if (c.kind === "not_found") {
      return (
        <div className="rounded-xl border-2 border-red-300 bg-red-50 p-4">
          <p className="font-semibold text-red-700">登録されていないラベルです</p>
          <p className="text-sm text-red-700 mt-1">番号:{c.id}</p>
          <p className="text-xs text-red-600 mt-2">読み取り直すか、番号をご確認ください</p>
        </div>
      );
    }
    const l = c.label;
    const detail = (
      <div className="text-sm space-y-0.5 mt-2">
        <p>
          <span className="text-gray-500">品目:</span>
          <span className="font-semibold text-base">
            {l.item_name}
            {l.spec ? ` ${l.spec}` : ""}
          </span>
        </p>
        <p>
          <span className="text-gray-500">数量:</span>
          <span className="font-semibold text-base">
            {l.pack_size}×{l.case_count}
          </span>
          <span className="text-gray-400 ml-2">({l.qty}個)</span>
        </p>
        <p>
          <span className="text-gray-500">店舗:</span>
          {storeTitle(l.store_code, l.store_name, l.store_sign)}
        </p>
        <p className="text-xs text-gray-500">
          {l.supplier_name} / {l.label_id}
        </p>
      </div>
    );

    if (c.kind === "store_mismatch") {
      return (
        <div className="rounded-xl border-2 border-red-400 bg-red-50 p-4">
          <p className="font-bold text-red-700 text-lg">⚠ 他の店舗の商品です</p>
          <p className="text-red-700 mt-1">
            これは <b>{storeTitle(l.store_code, l.store_name, l.store_sign)}</b> 向けです。
            検品中の {title} には確定できません。
          </p>
          {detail}
          <p className="text-xs text-red-600 mt-2">正しい店舗の荷物へ移してください(不一致として記録されます)</p>
        </div>
      );
    }
    if (c.kind === "void") {
      return (
        <div className="rounded-xl border-2 border-red-300 bg-red-50 p-4">
          <p className="font-bold text-red-700">このラベルは無効です</p>
          <p className="text-sm text-red-700 mt-1">再発行で新しいラベルに置き換えられています。新しいラベルを読み取ってください</p>
          {detail}
        </div>
      );
    }
    if (c.kind === "date_mismatch") {
      return (
        <div className="rounded-xl border-2 border-red-300 bg-red-50 p-4">
          <p className="font-bold text-red-700">納品日が違うラベルです</p>
          <p className="text-sm text-red-700 mt-1">
            ラベルの納品日は {l.target_date.replace(/-/g, "/")}、検品中は {date.replace(/-/g, "/")} です。古いラベルの可能性があります
          </p>
          {detail}
        </div>
      );
    }
    if (c.kind === "confirmed") {
      return (
        <div className="rounded-xl border-2 border-amber-300 bg-amber-50 p-4">
          <p className="font-bold text-amber-800">このラベルは確定済みです</p>
          <p className="text-sm text-amber-800 mt-1">
            {l.confirmed_by_name ?? "担当者不明"}
            {l.confirmed_at ? `(${formatTime(l.confirmed_at)})` : ""} が確定しました
          </p>
          {detail}
        </div>
      );
    }
    // ready
    return (
      <div className="rounded-xl border-2 border-green-400 bg-green-50 p-4">
        <p className="font-bold text-green-700">✓ 店舗が一致しています。内容を現物と見比べてください</p>
        {detail}
        {l.origin ? (
          <div className="mt-3 rounded-lg bg-blue-50 border border-blue-200 px-3 py-2">
            <p className="text-sm text-blue-800">
              産地指定:<b className="text-base">{l.origin}</b>
              <span className="text-xs ml-2">現物の産地を確認してください</span>
            </p>
          </div>
        ) : (
          <p className="mt-3 text-xs text-gray-500">産地の指定なし</p>
        )}
        <button
          onClick={confirmCurrent}
          disabled={confirming}
          className="mt-4 w-full bg-brand text-white rounded-xl py-3.5 text-base font-semibold disabled:opacity-50"
        >
          {confirming ? "確定中…" : "積込確定"}
        </button>
      </div>
    );
  }

  if (loading) return <p className="text-sm text-gray-500">読み込み中…</p>;

  return (
    <div className="max-w-xl">
      <Link href="/outbound" onClick={onLeave} className="text-sm text-brand underline">
        ← 店舗の選択へ
      </Link>

      {/* 検品中の店舗を、画面の上部に固定して表示する */}
      <div className="sticky top-0 z-10 bg-gray-50 pt-2 pb-3">
        <div className="bg-white border border-gray-200 rounded-xl px-4 py-3">
          <div className="flex items-baseline justify-between gap-2">
            <h1 className="text-lg font-bold">{title}</h1>
            <span className="text-xs text-gray-500">納品日 {date.replace(/-/g, "/")}</span>
          </div>
          <div className="flex items-center gap-3 mt-2">
            <div className="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
              <div
                className={"h-full " + (complete ? "bg-green-500" : "bg-amber-500")}
                style={{ width: total === 0 ? "0%" : `${(done / total) * 100}%` }}
              />
            </div>
            <span className="text-sm font-medium">
              {done}/{total}件
            </span>
          </div>
        </div>
      </div>

      {loadError && <p className="text-sm text-red-600 mb-3">{loadError}</p>}
      {actionError && (
        <p className="text-sm text-red-700 bg-red-50 rounded-lg px-3 py-2 mb-3">{actionError}</p>
      )}
      {flash && (
        <p className="text-sm text-green-700 bg-green-50 rounded-lg px-3 py-2 mb-3">{flash}</p>
      )}

      {total === 0 && (
        <p className="text-sm text-gray-500">
          この店舗・納品日の、発行済みのラベルはありません。
        </p>
      )}

      {/* 全件確定:完了の画面 */}
      {complete && (
        <div className="rounded-xl border border-green-200 bg-green-50 p-5 text-center mb-4">
          <p className="text-4xl text-green-600">✓</p>
          <p className="text-lg font-bold mt-1">{title} 検品完了</p>
          <p className="text-sm text-gray-600 mt-1">{done}/{total}件すべて確定しました</p>
          <div className="text-sm text-gray-600 mt-3 space-y-0.5">
            {staffNames.length > 0 && <p>担当者:{staffNames.join("・")}</p>}
          </div>
          {dispatch ? (
            <div className="mt-4">
              <p className="text-green-700 font-semibold">
                配送OK済み({formatTime(dispatch.completed_at)}
                {dispatch.name ? ` / ${dispatch.name}` : ""})
              </p>
              <button onClick={undoDispatchOk} disabled={confirming} className="text-xs text-gray-500 underline mt-2">
                配送OKを取り消す
              </button>
            </div>
          ) : (
            <button
              onClick={markDispatchOk}
              disabled={confirming}
              className="mt-4 w-full bg-brand text-white rounded-xl py-3.5 text-base font-semibold disabled:opacity-50"
            >
              配送OKにする
            </button>
          )}
          <Link href="/outbound" className="block text-sm text-brand underline mt-3">
            店舗の選択に戻る
          </Link>
        </div>
      )}

      {/* 読み取り・手入力(未確定のラベルが残っているとき) */}
      {!complete && total > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold">ラベルを読み取る</h2>
            <button
              onClick={() => setCameraOn((v) => !v)}
              className="text-sm border border-gray-300 rounded-lg px-3 py-1.5"
            >
              {cameraOn ? "カメラを止める" : "カメラを起動"}
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
                if (e.key === "Enter") submitManual();
              }}
              placeholder="読み取れない場合:ラベル番号を入力(例:185091-260924-0001)"
              className="flex-1 min-w-0 border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
            <button
              onClick={submitManual}
              disabled={looking || !manual.trim()}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm disabled:opacity-40"
            >
              照合
            </button>
          </div>
          {looking && <p className="text-xs text-gray-500 mt-2">照合中…</p>}
        </div>
      )}

      {current && <div className="mb-4">{renderCurrent(current)}</div>}

      {/* この店舗のラベルの一覧 */}
      {total > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl p-4 mb-10">
          <h2 className="text-sm font-semibold mb-2">この店舗のラベル(未確定が上)</h2>
          <ul>
            {sorted.map((r) => {
              const isDone = r.status === "検品済";
              return (
                <li
                  key={r.label_id}
                  className={"flex items-center gap-3 py-2 border-b border-gray-100 text-sm " + (isDone ? "text-gray-400" : "")}
                >
                  <span className={"w-5 text-center " + (isDone ? "text-green-600" : "text-gray-300")}>
                    {isDone ? "✓" : "○"}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block truncate">
                      {r.item_name}
                      {r.spec ? ` ${r.spec}` : ""}
                    </span>
                    <span className="block text-xs text-gray-400">
                      {r.supplier_name} / {r.label_id.slice(-4)}
                      {r.origin ? ` / 産地:${r.origin}` : ""}
                    </span>
                  </span>
                  <span className="font-medium">
                    {r.pack_size}×{r.case_count}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
