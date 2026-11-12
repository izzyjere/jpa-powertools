drop database if exists shop; create database shop; use shop;
create table categories (id int auto_increment primary key, name varchar(100) not null unique, parent_id int, foreign key (parent_id) references categories(id));
create table customers (id bigint unsigned auto_increment primary key, email varchar(255) not null unique comment 'Login e-mail, unique',
  full_name varchar(200) not null, is_active tinyint(1) not null default 1, created_at datetime(6) not null, version int not null default 0,
  settings json) comment 'People who buy things';
create table products (id int auto_increment primary key, sku char(12) not null unique, title varchar(200) not null, price decimal(10,2) not null,
  stock int unsigned not null, description longtext, category_id int, foreign key (category_id) references categories(id));
create table orders (id bigint auto_increment primary key, customer_id bigint unsigned not null, status enum('NEW','PAID') not null,
  placed_at timestamp not null default current_timestamp, shipped_to_id bigint unsigned,
  foreign key (customer_id) references customers(id), foreign key (shipped_to_id) references customers(id));
create table order_items (order_id bigint not null, line_no int not null, product_id int not null, quantity int not null,
  primary key (order_id, line_no), foreign key (order_id) references orders(id), foreign key (product_id) references products(id));
create table audit_log (happened_at datetime not null, action text not null);
create view order_summary as select o.id, c.email from orders o join customers c on c.id = o.customer_id;
