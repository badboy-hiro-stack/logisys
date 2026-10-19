-- =====================================================================
-- マイグレーション 014:まとめ品目(ハーブ類)
--   ・品目マスタに「まとめグループ」(bundle_group)を追加。同じグループの品目は、店舗ごとに1箱・1枚のラベルにまとめる。
--   ・t_labels に bundle_parent_label_id を追加。まとめの中身の品目ぶんのラベル(子)は印刷せず、
--     印刷する1枚(親)に紐づけて、出荷検品では親を読むと子もまとめて検品済みになる。
--   ・v_labels:子は出さない/品目名はグループ名/数量は「1箱」/中身の内訳(bundle_items)を追加。
--   ・ラベル再発行:子を新しい親につなぎ直す。担当者別実績:ラベル発行は親だけ数える。
-- ※ migration_013 を先に実行してください。何度実行しても問題ありません。
-- =====================================================================

alter table m_items add column if not exists bundle_group text;
alter table t_labels add column if not exists bundle_parent_label_id text references t_labels (label_id);
create index if not exists idx_labels_bundle_parent on t_labels (bundle_parent_label_id);

-- v_labels:まとめラベル対応(子ラベルは出さない・品目名はグループ名・内訳を持つ) --------------------------
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
  case when l.label_kind = 'まとめ' then coalesce(i.bundle_group, i.item_name) else i.item_name end as item_name,
  ol.spec,
  coalesce(sq.origin, ol.origin) as origin,
  o.target_date,
  o.supplier_code,
  sp.supplier_name,
  oi.confirmed_by,
  oi.confirmed_at,
  u.user_name as confirmed_by_name,
  l.label_kind,
  l.unit_size,
  case
    when l.label_kind = 'ケース' and coalesce(l.unit_size, 0) > 0
      then l.unit_size::text || '株×' || (l.case_count / l.unit_size)::text || 'ケース'
    when l.label_kind = 'ばら'
      then l.case_count::text || '株(ばら)'
    when l.label_kind = 'まとめ'
      then '1箱'
    else l.pack_size::text || '×' || l.case_count::text
  end as qty_text,
  case when l.label_kind = 'まとめ' then (
    select jsonb_agg(jsonb_build_object('item_name', i2.item_name, 'qty', l2.case_count) order by i2.item_code)
    from t_labels l2
    join t_order_line_store_qty sq2 on sq2.id = l2.order_line_store_qty_id
    join t_order_lines ol2 on ol2.order_line_id = sq2.order_line_id
    join m_items i2 on i2.item_code = ol2.item_code
    where (l2.label_id = l.label_id or l2.bundle_parent_label_id = l.label_id)
      and l2.status <> '無効'
  ) else null end as bundle_items
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
left join m_users u on u.user_id = oi.confirmed_by
where l.bundle_parent_label_id is null; -- まとめの子ラベルは一覧・検品に出さない(親と一緒に検品される)

revoke all on v_labels from anon;
grant select on v_labels to authenticated;


-- ラベル再発行:種類・ケース入数を引き継ぎ、まとめの子ラベルを新しい親につなぎ直す ------------------------------------
create or replace function reissue_label(
  p_old_label_id text,
  p_reason text,
  p_location_id int default null,
  p_allow_inspected boolean default false
) returns jsonb
language plpgsql
as $$
declare
  v_old t_labels%rowtype;
  v_supplier text;
  v_date date;
  v_last int;
  v_new_id text;
begin
  if p_reason not in ('汚損・破損', '印刷エラー', '印字内容の誤り', 'その他') then
    raise exception 'invalid reason: %', p_reason;
  end if;

  select l.* into v_old
  from t_labels l
  where l.label_id = p_old_label_id
  for update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  if v_old.status = '無効' then
    return jsonb_build_object('result', 'void');
  end if;

  if v_old.status = '検品済' and not p_allow_inspected then
    return jsonb_build_object('result', 'already_inspected');
  end if;

  select o.supplier_code, o.target_date
    into v_supplier, v_date
  from t_order_line_store_qty sq
  join t_order_lines ol on ol.order_line_id = sq.order_line_id
  join t_orders o on o.order_id = ol.order_id
  where sq.id = v_old.order_line_store_qty_id;

  v_last := reserve_label_numbers(v_supplier, v_date, 1);
  v_new_id := v_supplier || '-' || to_char(v_date, 'YYMMDD') || '-' || lpad(v_last::text, 4, '0');

  insert into t_labels (
    label_id, order_line_store_qty_id, pack_size, case_count, qty,
    issued_by, location_id, status, reissue_of_label_id, label_kind, unit_size
  ) values (
    v_new_id, v_old.order_line_store_qty_id, v_old.pack_size, v_old.case_count, v_old.qty,
    auth.uid(), coalesce(p_location_id, v_old.location_id), '未検品', v_old.label_id,
    v_old.label_kind, v_old.unit_size
  );

  update t_labels set bundle_parent_label_id = v_new_id where bundle_parent_label_id = v_old.label_id;

  update t_labels set status = '無効' where label_id = v_old.label_id;

  insert into t_label_reissues (old_label_id, new_label_id, reason, reissued_by)
  values (v_old.label_id, v_new_id, p_reason, auth.uid());

  return jsonb_build_object('result', 'ok', 'new_label_id', v_new_id);
end;
$$;

revoke all on function reissue_label(text, text, int, boolean) from public, anon;
grant execute on function reissue_label(text, text, int, boolean) to authenticated;

-- 出荷検品の確定:まとめの子ラベルも一緒に検品済みにする ---------------------
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
  -- まとめラベルの場合は、中身の品目ぶんの(印刷しない)ラベルも一緒に検品済みにする
  update t_labels set status = '検品済' where bundle_parent_label_id = p_label_id and status = '未検品';

  insert into t_outbound_inspections (label_id, target_store_code, status, confirmed_by, location_id)
  values (p_label_id, p_target_store, '確定済', v_user, p_location_id);

  return jsonb_build_object('result', 'ok');
end;
$$;

revoke all on function confirm_outbound_label(text, text, int) from public, anon;
grant execute on function confirm_outbound_label(text, text, int) to authenticated;

-- 担当者別実績 ------------------------------------------------------------
create or replace function performance_by_user(p_date date)
returns jsonb
language sql
stable
as $$
with
arr as (
  select a.user_id, count(*) as n, coalesce(sum(a.case_count),0) as cases
  from t_arrivals a
  join t_order_lines ol on ol.order_line_id = a.order_line_id
  join t_orders o on o.order_id = ol.order_id
  where o.target_date = p_date
  group by a.user_id
),
lab as (
  select l.issued_by as user_id, count(*) as n
  from t_labels l
  join t_order_line_store_qty sq on sq.id = l.order_line_store_qty_id
  join t_order_lines ol on ol.order_line_id = sq.order_line_id
  join t_orders o on o.order_id = ol.order_id
  where o.target_date = p_date and l.bundle_parent_label_id is null
  group by l.issued_by
),
reiss as (
  select r.reissued_by as user_id, count(*) as n
  from t_label_reissues r
  join t_labels l on l.label_id = r.new_label_id
  join t_order_line_store_qty sq on sq.id = l.order_line_store_qty_id
  join t_order_lines ol on ol.order_line_id = sq.order_line_id
  join t_orders o on o.order_id = ol.order_id
  where o.target_date = p_date
  group by r.reissued_by
),
outb as (
  select i.confirmed_by as user_id,
         count(*) filter (where i.status = '確定済') as n,
         count(*) filter (where i.status = '店舗不一致エラー') as err
  from t_outbound_inspections i
  join t_labels l on l.label_id = i.label_id
  join t_order_line_store_qty sq on sq.id = l.order_line_store_qty_id
  join t_order_lines ol on ol.order_line_id = sq.order_line_id
  join t_orders o on o.order_id = ol.order_id
  where o.target_date = p_date
  group by i.confirmed_by
),
edt as (
  select g.changed_by as user_id, count(*) as n
  from t_order_edit_logs g
  join t_order_line_store_qty sq on sq.id = g.order_line_store_qty_id
  join t_order_lines ol on ol.order_line_id = sq.order_line_id
  join t_orders o on o.order_id = ol.order_id
  where o.target_date = p_date
  group by g.changed_by
),
ids as (
  select user_id from arr union select user_id from lab union select user_id from reiss
  union select user_id from outb union select user_id from edt
)
select coalesce(jsonb_agg(jsonb_build_object(
  'user_id', ids.user_id,
  'user_name', coalesce(u.user_name, '(不明)'),
  'arrival_count', coalesce(arr.n, 0),
  'arrival_cases', coalesce(arr.cases, 0),
  'label_count', coalesce(lab.n, 0),
  'reissue_count', coalesce(reiss.n, 0),
  'outbound_count', coalesce(outb.n, 0),
  'outbound_error_count', coalesce(outb.err, 0),
  'edit_count', coalesce(edt.n, 0)
) order by u.user_name), '[]'::jsonb)
from ids
left join m_users u on u.user_id = ids.user_id
left join arr on arr.user_id is not distinct from ids.user_id
left join lab on lab.user_id is not distinct from ids.user_id
left join reiss on reiss.user_id is not distinct from ids.user_id
left join outb on outb.user_id is not distinct from ids.user_id
left join edt on edt.user_id is not distinct from ids.user_id;
$$;

revoke all on function performance_by_user(date) from public, anon;
grant execute on function performance_by_user(date) to authenticated;

