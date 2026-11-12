if db_id('shop') is not null begin alter database shop set single_user with rollback immediate; drop database shop; end
go
create database shop
go
use shop
go
create table categories (id int identity primary key, name nvarchar(100) not null unique, parent_id int references categories(id));
create table customers (id bigint identity primary key, email nvarchar(255) not null unique, full_name nvarchar(200) not null,
  external_ref uniqueidentifier, is_active bit not null default 1, created_at datetimeoffset not null, version int not null default 0, notes nvarchar(max));
create table products (id int identity primary key, sku char(12) not null unique, title varchar(200) not null, price decimal(10,2) not null,
  category_id int references categories(id), image varbinary(max), released_on date);
create table orders (id bigint identity primary key, customer_id bigint not null references customers(id), placed_at datetime2 not null,
  shipped_to_id bigint references customers(id));
create table order_items (order_id bigint not null references orders(id), line_no int not null, product_id int not null references products(id),
  quantity int not null, primary key (order_id, line_no));
create table audit_log (happened_at datetime2 not null, action nvarchar(400) not null);
go
create view order_summary as select o.id, c.email from orders o join customers c on c.id = o.customer_id;
go
exec sp_addextendedproperty 'MS_Description', 'People who buy things', 'SCHEMA', 'dbo', 'TABLE', 'customers';
exec sp_addextendedproperty 'MS_Description', 'Login e-mail, unique', 'SCHEMA', 'dbo', 'TABLE', 'customers', 'COLUMN', 'email';
go
