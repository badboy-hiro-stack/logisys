-- =====================================================================
-- 市場入出荷検品システム データベーススキーマ
-- 要件定義書 6章(データベース設計)に対応。
-- Supabaseの SQL Editor に、この内容をそのまま貼り付けて実行してください。
--
-- 補足:ユーザー認証はSupabase Auth(auth.usersテーブル)を使う前提とし、
-- m_users は auth.users の id(uuid)をそのまま主キーとして使う形に
-- しています(要件定義書のER図では password_hash 等を独自管理する
-- 想定でしたが、Supabase Authを使うことに決めたため、ここで調整しています)。
-- =====================================================================

-- ---------------------------------------------------------------------
-- マスタテーブル
-- ---------------------------------------------------------------------

create table if not exists m_suppliers (
  supplier_code text primary key,
  supplier_name text not null
);

create table if not exists m_stores (
  store_code text primary key,
  store_name text not null
);

create table if not exists m_items (
  item_code text primary key,
  item_name text not null,
  default_spec text,
  default_pack_size int -- 標準入数。実際の入数は発注データ側で都度決まる
);

create table if not exists m_locations (
  location_id serial primary key,
  location_name text not null
);

-- ユーザーのプロフィール情報。認証自体はSupabase Auth(auth.users)が行う。
create table if not exists m_users (
  user_id uuid primary key references auth.users (id) on delete cascade,
  user_name text not null,
  role text not null check (role in ('検品担当者', '管理者')),
  location_id int references m_locations (location_id),
  is_active boolean not null default true, -- 退職者等は削除せず無効化する
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 発注(仕分け)データ
-- ---------------------------------------------------------------------

create table if not exists t_orders (
  order_id text primary key, -- 仕入先コード+対象日+ページ番号 等で構成
  supplier_code text not null references m_suppliers (supplier_code),
  target_date date not null,
  page_no int not null default 1,
  source_image_url text,
  status text not null default 'OCR未確定' check (status in ('OCR未確定', '確定済')),
  confirmed_by uuid references m_users (user_id),
  confirmed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists t_order_lines (
  order_line_id bigserial primary key,
  order_id text not null references t_orders (order_id) on delete cascade,
  item_code text not null references m_items (item_code),
  origin text, -- 産地(指定がある場合のみ)
  spec text,   -- 規格(任意項目、当日上書き可)
  total_display text, -- 伝票の全店計表記(例:"20×11"、入数混載時は"346")
  total_qty int,       -- 全店計の実個数換算値(自動検算用)
  arrival_status text not null default '未入荷'
    check (arrival_status in ('未入荷', '一部入荷', '入荷完了', '欠品確定')),
  arrival_closed_by uuid references m_users (user_id),
  arrival_closed_at timestamptz
);

create table if not exists t_order_line_store_qty (
  id bigserial primary key,
  order_line_id bigint not null references t_order_lines (order_line_id) on delete cascade,
  store_code text not null references m_stores (store_code),
  pack_size int not null,
  case_count int not null,
  qty int generated always as (pack_size * case_count) stored,
  updated_by uuid references m_users (user_id),
  updated_at timestamptz,
  shortage_reported_by uuid references m_users (user_id),
  shortage_reported_at timestamptz
);

create table if not exists t_order_edit_logs (
  log_id bigserial primary key,
  order_line_store_qty_id bigint not null references t_order_line_store_qty (id) on delete cascade,
  changed_field text not null, -- pack_size / case_count など
  old_value text,
  new_value text,
  changed_by uuid references m_users (user_id),
  changed_at timestamptz not null default now(),
  reported_to_ops_by uuid references m_users (user_id),
  reported_to_ops_at timestamptz
);

-- ---------------------------------------------------------------------
-- 入荷実績
-- ---------------------------------------------------------------------

create table if not exists t_arrivals (
  arrival_id bigserial primary key,
  order_line_id bigint not null references t_order_lines (order_line_id) on delete cascade,
  pack_size int not null,   -- 入数混載の品目は入数ごとに1行
  case_count int not null,  -- 今回入荷した箱数
  arrived_at timestamptz not null default now(),
  user_id uuid references m_users (user_id),
  location_id int references m_locations (location_id)
);

-- ---------------------------------------------------------------------
-- 店舗別ラベル・再発行・出荷検品
-- ---------------------------------------------------------------------

create table if not exists t_labels (
  label_id text primary key, -- QRコードに埋め込む一意キー
  order_line_store_qty_id bigint not null references t_order_line_store_qty (id),
  pack_size int not null,
  case_count int not null,
  qty int not null,
  issued_at timestamptz not null default now(),
  issued_by uuid references m_users (user_id),
  location_id int references m_locations (location_id),
  status text not null default '未検品'
    check (status in ('未検品', '検品済', '無効')),
  reissue_of_label_id text references t_labels (label_id)
);

create table if not exists t_label_reissues (
  reissue_id bigserial primary key,
  old_label_id text not null references t_labels (label_id),
  new_label_id text not null references t_labels (label_id),
  reason text not null check (
    reason in ('汚損・破損', '印刷エラー', '印字内容の誤り', 'その他')
  ),
  reissued_by uuid references m_users (user_id),
  reissued_at timestamptz not null default now()
);

create table if not exists t_outbound_inspections (
  inspection_id bigserial primary key,
  label_id text not null references t_labels (label_id),
  target_store_code text not null references m_stores (store_code),
  status text not null default '確定済'
    check (status in ('確定済', '店舗不一致エラー', '保留')),
  confirmed_at timestamptz not null default now(),
  confirmed_by uuid references m_users (user_id),
  location_id int references m_locations (location_id)
);

-- ---------------------------------------------------------------------
-- よく使う検索に備えたインデックス
-- ---------------------------------------------------------------------

create index if not exists idx_order_lines_order_id on t_order_lines (order_id);
create index if not exists idx_store_qty_order_line on t_order_line_store_qty (order_line_id);
create index if not exists idx_labels_store_qty on t_labels (order_line_store_qty_id);
create index if not exists idx_arrivals_order_line on t_arrivals (order_line_id);
create index if not exists idx_outbound_label on t_outbound_inspections (label_id);

-- ---------------------------------------------------------------------
-- Row Level Security(最初はシンプルに:ログイン済みなら読み書き可)
-- 権限(検品担当者/管理者)による細かい制御は、運用が固まってから
-- 追加のポリシーとして調整してください。
-- ---------------------------------------------------------------------

alter table m_suppliers enable row level security;
alter table m_stores enable row level security;
alter table m_items enable row level security;
alter table m_locations enable row level security;
alter table m_users enable row level security;
alter table t_orders enable row level security;
alter table t_order_lines enable row level security;
alter table t_order_line_store_qty enable row level security;
alter table t_order_edit_logs enable row level security;
alter table t_arrivals enable row level security;
alter table t_labels enable row level security;
alter table t_label_reissues enable row level security;
alter table t_outbound_inspections enable row level security;

-- ログイン画面で拠点の選択肢を表示するため、未ログインでも m_locations だけは読めるようにする
create policy "anyone can read locations" on m_locations
  for select to anon, authenticated using (true);

-- それ以外は、ログイン済みユーザーであれば読み書き可能(最初のシンプルな設定)
create policy "authenticated can read suppliers" on m_suppliers for select to authenticated using (true);
create policy "authenticated can read stores" on m_stores for select to authenticated using (true);
create policy "authenticated can read items" on m_items for select to authenticated using (true);
create policy "authenticated can manage items" on m_items for all to authenticated using (true) with check (true);
create policy "authenticated can manage suppliers" on m_suppliers for all to authenticated using (true) with check (true);
create policy "authenticated can manage stores" on m_stores for all to authenticated using (true) with check (true);

create policy "authenticated can read users" on m_users for select to authenticated using (true);
create policy "authenticated can manage users" on m_users for all to authenticated using (true) with check (true);

create policy "authenticated can access orders" on t_orders for all to authenticated using (true) with check (true);
create policy "authenticated can access order_lines" on t_order_lines for all to authenticated using (true) with check (true);
create policy "authenticated can access store_qty" on t_order_line_store_qty for all to authenticated using (true) with check (true);
create policy "authenticated can access edit_logs" on t_order_edit_logs for all to authenticated using (true) with check (true);
create policy "authenticated can access arrivals" on t_arrivals for all to authenticated using (true) with check (true);
create policy "authenticated can access labels" on t_labels for all to authenticated using (true) with check (true);
create policy "authenticated can access reissues" on t_label_reissues for all to authenticated using (true) with check (true);
create policy "authenticated can access outbound" on t_outbound_inspections for all to authenticated using (true) with check (true);

-- ---------------------------------------------------------------------
-- 初期マスタデータ(要件定義書 1.3)
-- ---------------------------------------------------------------------

insert into m_suppliers (supplier_code, supplier_name) values
  ('185091', '横須賀青果物'),
  ('133401', '駿河屋'),
  ('125021', '港南商事'),
  ('145145', 'TOKYOフレッシュ大田'),
  ('122185', 'かねはら'),
  ('113001', '昭島松源')
on conflict (supplier_code) do nothing;

insert into m_stores (store_code, store_name) values
  ('20', '小原店'),
  ('30', '武山店'),
  ('35', '佐原店'),
  ('40', '平作店'),
  ('45', '衣笠店'),
  ('50', '新鶴見店'),
  ('51', '南部市場店'),
  ('60', '平成町店'),
  ('77', 'りんかんモール店'),
  ('78', '南町田店'),
  ('90', 'ARAI店')
on conflict (store_code) do nothing;

insert into m_locations (location_name) values
  ('本場(横須賀市場)')
on conflict do nothing;
