-- =====================================================================
-- マイグレーション 013:株数で管理する品目(セロリなど)
--   ・品目マスタに「ケース入数」(loose_case_size)を追加。入っている品目が「株数管理品」。
--   ・株数管理品は、伝票の「入数×箱数」の入数を無視し、箱数の数字を株数として扱う(入数は常に1)。
--   ・入荷(t_arrivals)・ラベル(t_labels)に、ケース入数と種類(通常/ケース/ばら)を追加。
--   ・v_labels に qty_text(ラベル・画面に出す数量の文字)を追加。
--   ・ラベル再発行で、種類・ケース入数を引き継ぐ。
-- 何度実行しても問題ありません。既存データは変更しません(株数管理品に設定した品目を除く)。
-- =====================================================================

alter table m_items add column if not exists loose_case_size int
  check (loose_case_size is null or loose_case_size > 0);

alter table t_arrivals add column if not exists unit_size int;

alter table t_labels add column if not exists label_kind text not null default '通常';
alter table t_labels drop constraint if exists t_labels_label_kind_check;
alter table t_labels add constraint t_labels_label_kind_check
  check (label_kind in ('通常', 'ケース', 'ばら', 'まとめ'));
alter table t_labels add column if not exists unit_size int;

-- 株数管理品の店舗別数量は、入数を常に1にする -------------------------------
create or replace function force_unit_pack_size()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1
    from t_order_lines ol
    join m_items i on i.item_code = ol.item_code
    where ol.order_line_id = new.order_line_id and i.loose_case_size is not null
  ) then
    new.pack_size := 1;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_force_unit_pack_size on t_order_line_store_qty;
create trigger trg_force_unit_pack_size
  before insert or update of pack_size on t_order_line_store_qty
  for each row execute function force_unit_pack_size();

-- 品目を株数管理品にしたとき、すでに取り込み済みの行(ラベル未発行)も入数1にそろえる
create or replace function apply_unit_pack_size()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.loose_case_size is not null and new.loose_case_size is distinct from old.loose_case_size then
    update t_order_line_store_qty sq
       set pack_size = 1
      from t_order_lines ol
     where ol.order_line_id = sq.order_line_id
       and ol.item_code = new.item_code
       and sq.pack_size <> 1
       and not exists (
         select 1 from t_labels l
         where l.order_line_store_qty_id = sq.id and l.status <> '無効'
       );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_apply_unit_pack_size on m_items;
create trigger trg_apply_unit_pack_size
  after update of loose_case_size on m_items
  for each row execute function apply_unit_pack_size();

-- v_labels:ラベルの種類・ケース入数・数量の表示文字を追加 --------------------------
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
    else l.pack_size::text || '×' || l.case_count::text
  end as qty_text
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

-- ラベル再発行:種類・ケース入数を引き継ぐ ------------------------------------
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

  update t_labels set status = '無効' where label_id = v_old.label_id;

  insert into t_label_reissues (old_label_id, new_label_id, reason, reissued_by)
  values (v_old.label_id, v_new_id, p_reason, auth.uid());

  return jsonb_build_object('result', 'ok', 'new_label_id', v_new_id);
end;
$$;

revoke all on function reissue_label(text, text, int, boolean) from public, anon;
grant execute on function reissue_label(text, text, int, boolean) to authenticated;
