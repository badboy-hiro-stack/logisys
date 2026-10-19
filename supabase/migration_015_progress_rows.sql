-- =====================================================================
-- マイグレーション 015:本日の進捗(ラベル発行を「品目×店舗の件数」で表示。005を置き換え)
--   指定した納品日の、入荷・ラベル発行・出荷検品の進み具合を、まとめて返す関数。
--   画面(本日の進捗)は、この関数を1回呼び出すだけで表示できる。
--
-- Supabaseの SQL Editor に、この内容をそのまま貼り付けて実行してください。
-- 何度実行しても問題ありません。データは変更しません(読み取り専用の関数です)。
-- =====================================================================

create or replace function progress_summary(p_date date)
returns jsonb
language sql
stable
as $$
select jsonb_build_object(

  -- 仕入先別の入荷状況(品目数)
  'suppliers', coalesce((
    select jsonb_agg(x order by x->>'supplier_code')
    from (
      select jsonb_build_object(
        'supplier_code', sp.supplier_code,
        'supplier_name', sp.supplier_name,
        'total',    count(*),
        'complete', count(*) filter (where ol.arrival_status = '入荷完了'),
        'partial',  count(*) filter (where ol.arrival_status = '一部入荷'),
        'none',     count(*) filter (where ol.arrival_status = '未入荷'),
        'shortage', count(*) filter (where ol.arrival_status = '欠品確定')
      ) as x
      from t_orders o
      join t_order_lines ol on ol.order_id = o.order_id
      join m_suppliers sp on sp.supplier_code = o.supplier_code
      where o.target_date = p_date
      group by sp.supplier_code, sp.supplier_name
    ) s
  ), '[]'::jsonb),

  -- 店舗別の出荷検品の状況(ラベル枚数・検品済み枚数・配送OK)
  'stores', coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'store_code', st.store_code,
        'store_name', st.store_name,
        'sign', st.sign,
        'label_total', coalesce(c.total, 0),
        'label_done', coalesce(c.done, 0),
        'dispatched', d.store_code is not null,
        'dispatched_at', d.completed_at
      )
      order by st.store_code
    )
    from m_stores st
    left join (
      select v.store_code,
             count(*) as total,
             count(*) filter (where v.status = '検品済') as done
      from v_labels v
      where v.target_date = p_date and v.status <> '無効'
      group by v.store_code
    ) c on c.store_code = st.store_code
    left join t_store_dispatch d
      on d.store_code = st.store_code and d.target_date = p_date
  ), '[]'::jsonb),

  -- ラベル発行の進み具合(品目×店舗の件数ベース。欠品確定の品目・数量0の行は除く)
  --   ある品目の、ある店舗の分を、発注数ぶん発行し終えたら1件。
  'ordered_rows', coalesce((
    select count(*)
    from t_orders o
    join t_order_lines ol on ol.order_id = o.order_id
    join t_order_line_store_qty sq on sq.order_line_id = ol.order_line_id
    where o.target_date = p_date and ol.arrival_status <> '欠品確定' and sq.case_count > 0
  ), 0),
  'issued_rows', coalesce((
    select count(*)
    from t_orders o
    join t_order_lines ol on ol.order_id = o.order_id
    join t_order_line_store_qty sq on sq.order_line_id = ol.order_line_id
    where o.target_date = p_date and ol.arrival_status <> '欠品確定' and sq.case_count > 0
      and coalesce((
        select sum(l.case_count) from t_labels l
        where l.order_line_store_qty_id = sq.id and l.status <> '無効'
      ), 0) >= sq.case_count
  ), 0),

  -- 入荷待ちの品目(未入荷・一部入荷)
  'waiting', coalesce((
    select jsonb_agg(w order by w->>'supplier_name', w->>'item_name')
    from (
      select jsonb_build_object(
        'supplier_name', sp.supplier_name,
        'item_name', i.item_name,
        'status', ol.arrival_status
      ) as w
      from t_orders o
      join t_order_lines ol on ol.order_id = o.order_id
      join m_suppliers sp on sp.supplier_code = o.supplier_code
      join m_items i on i.item_code = ol.item_code
      where o.target_date = p_date and ol.arrival_status in ('未入荷', '一部入荷')
      limit 200
    ) q
  ), '[]'::jsonb),

  -- 欠品が確定した品目
  'shortage_items', coalesce((
    select jsonb_agg(w order by w->>'supplier_name', w->>'item_name')
    from (
      select jsonb_build_object(
        'supplier_name', sp.supplier_name,
        'item_name', i.item_name
      ) as w
      from t_orders o
      join t_order_lines ol on ol.order_id = o.order_id
      join m_suppliers sp on sp.supplier_code = o.supplier_code
      join m_items i on i.item_code = ol.item_code
      where o.target_date = p_date and ol.arrival_status = '欠品確定'
      limit 200
    ) q
  ), '[]'::jsonb)
);
$$;

revoke all on function progress_summary(date) from public, anon;
grant execute on function progress_summary(date) to authenticated;
