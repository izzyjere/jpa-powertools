drop schema if exists public cascade; create schema public;
drop schema if exists sales cascade; create schema sales;
create type order_status as enum ('NEW', 'PAID', 'SHIPPED');
create table categories (id serial primary key, name varchar(100) not null unique, parent_id int references categories(id));
create table customers (
  id bigint generated always as identity primary key,
  email varchar(255) not null unique,
  full_name varchar(200) not null,
  external_ref uuid,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  version int not null default 0);
comment on table customers is 'People who buy things';
comment on column customers.email is 'Login e-mail, unique';
create table customer_profiles (id serial primary key, customer_id bigint not null unique references customers(id), bio text, preferences jsonb);
create table products (id serial primary key, sku char(12) not null unique, title varchar(200) not null, price numeric(10,2) not null,
  weight_kg real, tags text[], category_id int references categories(id), image bytea, released_on date);
create table orders (id bigserial primary key, customer_id bigint not null references customers(id), status order_status not null default 'NEW',
  placed_at timestamp not null, shipped_to_id bigint references customers(id), note text);
create table order_items (order_id bigint not null references orders(id), line_no int not null, product_id int not null references products(id),
  quantity int not null, unit_price numeric(10,2) not null, primary key (order_id, line_no));
create table audit_log (happened_at timestamptz not null, actor varchar(50), action text not null);
create table "user" (id serial primary key, "Display Name" varchar(50));
create view order_summary as select o.id, c.email, count(i.line_no) as items from orders o join customers c on c.id = o.customer_id left join order_items i on i.order_id = o.id group by o.id, c.email;
create table sales.invoices (id serial primary key, order_id bigint not null references public.orders(id), total numeric(12,2) not null);
