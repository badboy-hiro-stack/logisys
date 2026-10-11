-- =====================================================================
-- マイグレーション 003:出荷検品のための追加
--   1. ラベルの情報をまとめて参照するためのビュー(v_labels)
--   2. 店舗ごとの「配送OK」を記録するテーブル(t_store_dispatch)
--   3. ラベルの積込確定を、順番に1件ずつ確実に処理する関数(confirm_outbound_label)
--
-- Supabaseの SQL Editor に、この内容をそのまま貼り付けて実行してください。
-- 何度実行しても問題ありません。
-- =====================================================================

-- 1. ラベルの情報をまとめたビュー --------------------------------------
-- 店舗・品目・納品日・仕入先・確定した担当者を、1行にまとめて見られるようにする。
-- security_invoker により、ログインしているユーザーの権限で参照される。
create or replace view v_labels
with (security_invoker = true) as
select
  l.label_id,
  l.status,
  l.pack_size,
  l.case_count,
  l.qty,
  l.issued_at,
  l.reissue_of_label_id,
  sq.id as store_qty_id,
  sq.store_code,
  s.store_name,
  s.sign as store_sign,
  ol.order_line_id,
  ol.item_code,
  i.item_name,
  ol.spec,
  ol.origin,
  o.target_date,
  o.supplier_code,
  sp.supplier_name,
  oi.confirmed_by,
  oi.confirmed_at,
  u.user_name as confirmed_by_name
from t_labels l
join t_order_line_store_qty sq on sq.id = l.order_line_store_qty_id
join m_stores s on s.store_code = sq.store_code
join t_order_lines ol on ol.order_line_id = sq.order_line_id
join m_items i on i.item_code = ol.item_code
join t_orders o on o.order_id = ol.order_id
join m_suppliers sp on sp.supplier_code = o.supplier_code
left join lateral (
  select x.confirmed_by, x.confirmed_at
  from t_outbound_inspections x
  where x.label_id = l.label_id and x.status = '確定済'
  order by x.confirmed_at desc
  limit 1
) oi on true
left join m_users u on u.user_id = oi.confirmed_by;

revoke all on v_labels from anon;
grant select on v_labels to authenticated;

-- 2. 店舗ごとの「配送OK」 -----------------------------------------------
create table if not exists t_store_dispatch (
  target_date date not null,
  store_code text not null references m_stores (store_code),
  completed_by uuid references m_users (user_id),
  completed_at timestamptz not null default now(),
  location_id int references m_locations (location_id),
  primary key (target_date, store_code)
);

alter table t_store_dispatch enable row level security;

drop policy if exists "authenticated can access store_dispatch" on t_store_dispatch;
create policy "authenticated can access store_dispatch" on t_store_dispatch
  for all to authenticated using (true) with check (true);

-- 3. ラベルの積込確定 ---------------------------------------------------
-- 戻り値(result):
--   ok                 確定した
--   already_confirmed  既に確定済み(確定した担当者名・時刻も返す)
--   store_mismatch     ラベルの店舗が、検品中の店舗と違う(確定せず、不一致の記録だけ残す)
--   void               無効なラベル(再発行で置き換えられた)
--   not_found          そのラベル番号は登録されていない
-- 同じラベルを複数の端末がほぼ同時に確定しようとしても、for update で順番に処理されるので、
-- 確定されるのは1回だけになる。
create or replace function confirm_outbound_label(
  p_label_id text,
  p_target_store text,
  p_location_id int
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_status text;
  v_label_store text;
  v_user uuid := auth.uid();
  v_at timestamptz;
  v_name text;
begin
  select l.status, sq.store_code
    into v_status, v_label_store
  from t_labels l
  join t_order_line_store_qty sq on sq.id = l.order_line_store_qty_id
  where l.label_id = p_label_id
  for update of l;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  if v_label_store <> p_target_store then
    insert into t_outbound_inspections (label_id, target_store_code, status, confirmed_by, location_id)
    values (p_label_id, p_target_store, '店舗不一致エラー', v_user, p_location_id);
    return jsonb_build_object('result', 'store_mismatch', 'label_store_code', v_label_store);
  end if;

  if v_status = '無効' then
    return jsonb_build_object('result', 'void');
  end if;

  if v_status = '検品済' then
    select x.confirmed_at, u.user_name
      into v_at, v_name
    from t_outbound_inspections x
    left join m_users u on u.user_id = x.confirmed_by
    where x.label_id = p_label_id and x.status = '確定済'
    order by x.confirmed_at desc
    limit 1;
    return jsonb_build_object(
      'result', 'already_confirmed',
      'confirmed_at', v_at,
      'confirmed_by_name', v_name
    );
  end if;

  update t_labels set status = '検品済' where label_id = p_label_id;

  insert into t_outbound_inspections (label_id, target_store_code, status, confirmed_by, location_id)
  values (p_label_id, p_target_store, '確定済', v_user, p_location_id);

  return jsonb_build_object('result', 'ok');
end;
$$;

revoke all on function confirm_outbound_label(text, text, int) from public, anon;
grant execute on function confirm_outbound_label(text, text, int) to authenticated;
