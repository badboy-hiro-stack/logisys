"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Field = {
  key: string;
  label: string;
  type: "text" | "int";
  required?: boolean;
  width?: string;
  auto?: boolean; // 自動採番(追加時は入力不要・編集不可)
};

type Row = Record<string, string | number | null>;

type Config = {
  title: string;
  table: string;
  codeKey: string;
  orderBy: string;
  fields: Field[];
};

const CONFIGS: Record<string, Config> = {
  suppliers: {
    title: "仕入先",
    table: "m_suppliers",
    codeKey: "supplier_code",
    orderBy: "supplier_code",
    fields: [
      { key: "supplier_code", label: "仕入先コード", type: "text", required: true, width: "w-32" },
      { key: "supplier_name", label: "仕入先名", type: "text", required: true },
    ],
  },
  stores: {
    title: "店舗",
    table: "m_stores",
    codeKey: "store_code",
    orderBy: "store_code",
    fields: [
      { key: "store_code", label: "店舗コード", type: "text", required: true, width: "w-28" },
      { key: "store_name", label: "店舗名", type: "text", required: true },
      { key: "sign", label: "ラベル表記(任意)", type: "text", width: "w-36" },
    ],
  },
  items: {
    title: "品目",
    table: "m_items",
    codeKey: "item_code",
    orderBy: "item_code",
    fields: [
      { key: "item_code", label: "EOSコード", type: "text", required: true, width: "w-32" },
      { key: "item_name", label: "品名", type: "text", required: true },
      { key: "default_spec", label: "標準規格", type: "text", width: "w-32" },
      { key: "default_pack_size", label: "標準入数", type: "int", width: "w-24" },
      { key: "loose_case_size", label: "ケース入数(株数管理品のみ)", type: "int", width: "w-40" },
      { key: "bundle_group", label: "まとめグループ(任意)", type: "text", width: "w-36" },
    ],
  },
};

CONFIGS.locations = {
  title: "拠点",
  table: "m_locations",
  codeKey: "location_id",
  orderBy: "location_id",
  fields: [
    { key: "location_id", label: "拠点ID(自動)", type: "int", auto: true, width: "w-28" },
    { key: "location_name", label: "拠点名", type: "text", required: true },
  ],
};

function MasterTable({ cfg }: { cfg: Config }) {
  const supabase = createClient();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // 編集中の行のコード
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState<Record<string, string> | null>(null);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    const { data, error: e } = await supabase
      .from(cfg.table)
      .select("*")
      .order(cfg.orderBy);
    if (e) {
      setError("取得に失敗しました: " + e.message);
      return;
    }
    setError(null);
    setRows(data as Row[]);
  }, [supabase, cfg]);

  useEffect(() => {
    setRows(null);
    setEditing(null);
    setAdding(null);
    setMessage(null);
    load();
  }, [load]);

  function toPayload(values: Record<string, string>): { payload: Row; err: string | null } {
    const payload: Row = {};
    for (const f of cfg.fields) {
      if (f.auto) continue;
      const v = (values[f.key] ?? "").trim();
      if (f.required && !v) return { payload, err: `${f.label}を入力してください` };
      if (f.type === "int") {
        if (v === "") payload[f.key] = null;
        else if (!/^\d+$/.test(v)) return { payload, err: `${f.label}は数字で入力してください` };
        else payload[f.key] = Number(v);
      } else {
        payload[f.key] = v === "" ? null : v;
      }
    }
    return { payload, err: null };
  }

  async function save(isNew: boolean) {
    const values = isNew ? (adding ?? {}) : draft;
    const { payload, err } = toPayload(values);
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    setMessage(null);
    if (isNew) {
      const { error: e } = await supabase.from(cfg.table).insert(payload);
      if (e) {
        setError(
          e.code === "23505" ? "同じコードがすでに登録されています" : "追加に失敗しました: " + e.message,
        );
        return;
      }
      setAdding(null);
      setMessage("追加しました");
    } else {
      const rest = { ...payload };
      delete rest[cfg.codeKey];
      const { error: e } = await supabase.from(cfg.table).update(rest).eq(cfg.codeKey, editing!);
      if (e) {
        setError("更新に失敗しました: " + e.message);
        return;
      }
      setEditing(null);
      setMessage("更新しました");
    }
    await load();
  }

  async function remove(code: string) {
    if (!window.confirm(`${cfg.title} ${code} を削除します。よろしいですか?`)) return;
    const { error: e } = await supabase.from(cfg.table).delete().eq(cfg.codeKey, code);
    if (e) {
      setError(
        e.code === "23503"
          ? "すでにラベル・入荷などの記録やユーザーで使われているため削除できません(名前の修正は可能です)"
          : "削除に失敗しました: " + e.message,
      );
      return;
    }
    setError(null);
    setMessage("削除しました");
    await load();
  }

  const q = query.trim().toLowerCase();
  const shown = (rows ?? []).filter(
    (r) => !q || cfg.fields.some((f) => String(r[f.key] ?? "").toLowerCase().includes(q)),
  );

  const input = (
    f: Field,
    values: Record<string, string>,
    set: (v: Record<string, string>) => void,
    disabled = false,
  ) => (
    <input
      value={values[f.key] ?? ""}
      disabled={disabled}
      inputMode={f.type === "int" ? "numeric" : undefined}
      onChange={(e) => set({ ...values, [f.key]: e.target.value })}
      className={`border border-gray-300 rounded-lg px-2 py-1 text-sm w-full disabled:bg-gray-100 ${f.width ?? ""}`}
    />
  );

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`${cfg.title}を検索`}
          className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm w-56"
        />
        <span className="text-xs text-gray-500">{rows ? `${shown.length} / ${rows.length}件` : ""}</span>
        <button
          type="button"
          onClick={() => {
            setAdding({});
            setEditing(null);
          }}
          className="ml-auto bg-blue-600 text-white text-sm px-3 py-1.5 rounded-lg"
        >
          ＋ {cfg.title}を追加
        </button>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3 mb-3">{error}</div>}
      {message && <div className="bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg p-3 mb-3">{message}</div>}
      {!rows && !error && <p className="text-sm text-gray-500">読み込み中…</p>}

      {rows && (
        <div className="bg-white border border-gray-200 rounded-xl p-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-500 text-left">
                {cfg.fields.map((f) => (
                  <th key={f.key} className="py-1 pr-2 font-normal">{f.label}</th>
                ))}
                <th className="py-1 font-normal text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {adding && (
                <tr className="border-t border-gray-100 bg-blue-50">
                  {cfg.fields.map((f) => (
                    <td key={f.key} className="py-2 pr-2">
                      {f.auto ? <span className="text-gray-400">自動</span> : input(f, adding, setAdding)}
                    </td>
                  ))}
                  <td className="py-2 text-right whitespace-nowrap">
                    <button type="button" onClick={() => save(true)} className="text-blue-600 mr-3">保存</button>
                    <button type="button" onClick={() => setAdding(null)} className="text-gray-500">取消</button>
                  </td>
                </tr>
              )}
              {shown.map((r) => {
                const code = String(r[cfg.codeKey]);
                const isEdit = editing === code;
                return (
                  <tr key={code} className="border-t border-gray-100">
                    {cfg.fields.map((f) => (
                      <td key={f.key} className="py-2 pr-2">
                        {isEdit ? input(f, draft, setDraft, f.key === cfg.codeKey || !!f.auto) : (r[f.key] ?? "")}
                      </td>
                    ))}
                    <td className="py-2 text-right whitespace-nowrap">
                      {isEdit ? (
                        <>
                          <button type="button" onClick={() => save(false)} className="text-blue-600 mr-3">保存</button>
                          <button type="button" onClick={() => setEditing(null)} className="text-gray-500">取消</button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              setEditing(code);
                              setAdding(null);
                              setDraft(
                                Object.fromEntries(cfg.fields.map((f) => [f.key, String(r[f.key] ?? "")])),
                              );
                            }}
                            className="text-blue-600 mr-3"
                          >
                            編集
                          </button>
                          <button type="button" onClick={() => remove(code)} className="text-red-600">削除</button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
              {shown.length === 0 && !adding && (
                <tr><td colSpan={cfg.fields.length + 1} className="py-3 text-gray-500">該当なし</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

type UserRow = {
  user_id: string;
  user_name: string;
  role: "検品担当者" | "管理者";
  is_active: boolean;
  location_id: number | null;
};

function UsersTable() {
  const supabase = createClient();
  const [rows, setRows] = useState<UserRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [me, setMe] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: e } = await supabase.from("m_users").select("*").order("user_name");
    if (e) {
      setError("取得に失敗しました: " + e.message);
      return;
    }
    setError(null);
    setRows(data as UserRow[]);
  }, [supabase]);

  useEffect(() => {
    load();
    supabase.auth.getUser().then(({ data }) => setMe(data.user?.id ?? null));
  }, [load, supabase]);

  async function update(u: UserRow, patch: Partial<UserRow>) {
    setMessage(null);
    const { error: e } = await supabase.from("m_users").update(patch).eq("user_id", u.user_id);
    if (e) {
      setError("更新に失敗しました: " + e.message);
      return;
    }
    setError(null);
    setMessage(`${patch.user_name ?? u.user_name} を更新しました`);
    await load();
  }

  return (
    <div>
      <p className="text-sm text-gray-600 mb-3">
        氏名・権限・有効/無効を変更できます。退職者などは削除せず「無効」にしてください(過去の実績が残ります)。
        新しいユーザーの追加とパスワード再設定は、Supabase の Authentication 画面で行います。
      </p>
      {error && <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3 mb-3">{error}</div>}
      {message && <div className="bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg p-3 mb-3">{message}</div>}
      {!rows && !error && <p className="text-sm text-gray-500">読み込み中…</p>}
      {rows && (
        <div className="bg-white border border-gray-200 rounded-xl p-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-500 text-left">
                <th className="py-1 pr-2 font-normal">氏名</th>
                <th className="py-1 pr-2 font-normal">権限</th>
                <th className="py-1 pr-2 font-normal">状態</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.user_id} className={"border-t border-gray-100 " + (u.is_active ? "" : "text-gray-400")}>
                  <td className="py-2 pr-2">
                    <input
                      defaultValue={u.user_name}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v && v !== u.user_name) update(u, { user_name: v });
                        else e.target.value = u.user_name;
                      }}
                      className="border border-gray-300 rounded-lg px-2 py-1 text-sm w-44"
                    />
                    {u.user_id === me && <span className="text-xs text-blue-600 ml-2">(自分)</span>}
                  </td>
                  <td className="py-2 pr-2">
                    <select
                      value={u.role}
                      onChange={(e) => update(u, { role: e.target.value as UserRow["role"] })}
                      disabled={u.user_id === me}
                      title={u.user_id === me ? "自分の権限は変更できません" : ""}
                      className="border border-gray-300 rounded-lg px-2 py-1 text-sm disabled:bg-gray-100"
                    >
                      <option value="検品担当者">検品担当者</option>
                      <option value="管理者">管理者</option>
                    </select>
                  </td>
                  <td className="py-2 pr-2">
                    <button
                      type="button"
                      disabled={u.user_id === me}
                      onClick={() => update(u, { is_active: !u.is_active })}
                      className={
                        "text-sm px-3 py-1 rounded-lg border disabled:opacity-40 " +
                        (u.is_active ? "border-green-600 text-green-700" : "border-gray-400 text-gray-500")
                      }
                    >
                      {u.is_active ? "有効" : "無効"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const TABS = [
  { id: "suppliers", label: "仕入先" },
  { id: "stores", label: "店舗" },
  { id: "items", label: "品目" },
  { id: "locations", label: "拠点" },
  { id: "users", label: "ユーザー" },
] as const;

export default function MasterPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("suppliers");
  return (
    <div className="max-w-5xl">
      <h1 className="text-lg font-semibold mb-3">マスタ管理</h1>
      <div className="flex gap-1 mb-4 border-b border-gray-200">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={
              "px-4 py-2 text-sm -mb-px border-b-2 " +
              (tab === t.id ? "border-blue-600 text-blue-600 font-semibold" : "border-transparent text-gray-500")
            }
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "users" ? <UsersTable /> : <MasterTable key={tab} cfg={CONFIGS[tab]} />}
    </div>
  );
}
