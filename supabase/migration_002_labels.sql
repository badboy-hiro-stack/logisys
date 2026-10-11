-- =====================================================================
-- マイグレーション 002:ラベル発行のための追加
--   1. 店舗マスタに「記号」(ラベルに印字する店舗の記号)を追加
--   2. ラベル番号(QRコードの内容)の連番を、仕入先・納品日ごとに採番する仕組みを追加
--
-- Supabaseの SQL Editor に、この内容をそのまま貼り付けて実行してください。
-- 何度実行しても問題ありません(既にある場合は何もしません)。
-- =====================================================================

-- 1. 店舗の記号 ---------------------------------------------------------
alter table m_stores add column if not exists sign text;

update m_stores set sign = v.sign
from (values
  ('20', 'B'),
  ('30', 'C'),
  ('35', 'G'),
  ('40', 'D'),
  ('45', 'K'),
  ('50', 'T'),
  ('51', 'な'),
  ('60', 'F'),
  ('77', '林'),
  ('78', 'ま'),
  ('90', 'AR')
) as v(code, sign)
where m_stores.store_code = v.code;

-- 2. ラベル番号の採番 ---------------------------------------------------
-- ラベル番号は「仕入先コード-納品日(YYMMDD)-連番4桁」(例:185091-260924-0001)。
-- 連番は仕入先・納品日ごとに1から数える。複数の端末が同時に発行しても
-- 番号が重複しないよう、データベース側で原子的に(順番に1つずつ確実に)採番する。
create table if not exists t_label_counters (
  supplier_code text not null references m_suppliers (supplier_code),
  target_date date not null,
  last_no int not null default 0,
  primary key (supplier_code, target_date)
);

-- このテーブルは下の関数からだけ更新する(画面から直接は触らせない)
alter table t_label_counters enable row level security;

-- p_count 枚分の番号をまとめて確保し、確保した「最後の番号」を返す。
-- 呼び出し側は「最後の番号 - 枚数 + 1」から「最後の番号」までを使う。
create or replace function reserve_label_numbers(
  p_supplier text,
  p_date date,
  p_count int
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_last int;
begin
  if p_count is null or p_count < 1 then
    raise exception 'p_count must be 1 or more';
  end if;

  insert into t_label_counters (supplier_code, target_date, last_no)
  values (p_supplier, p_date, p_count)
  on conflict (supplier_code, target_date)
  do update set last_no = t_label_counters.last_no + p_count
  returning last_no into v_last;

  return v_last;
end;
$$;

revoke all on function reserve_label_numbers(text, date, int) from public, anon;
grant execute on function reserve_label_numbers(text, date, int) to authenticated;
