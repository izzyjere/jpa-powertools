import * as assert from 'assert';
import * as path from 'path';
import { dependencyOrder, generateDdl, nextMigrationName, quoteIdentifier, splitStatements } from '../../erd/ddl';
import {
  ErdDocument, foldIdentifier, fromEntityModel, fromTables, mergeLayout, nativeType, parseDocument, serializeDocument, snakeCase, toTables,
} from '../../erd/erdModel';
import { EntityModel } from '../../jpql/entityModel';
import { parseJavaClasses } from '../../jpql/javaSource';
import { col, shopSchema, table } from './fixtures';

const layoutLib = require(path.resolve(__dirname, '../../../media/erd-layout.js')) as {
  layout: (e: Array<{ id: string }>, r: Array<{ from: string; to: string }>, size: (id: string) => { width: number; height: number }) => Record<string, { x: number; y: number }>;
  overlaps: (a: object, b: object) => boolean;
};

const ENTITIES = `
package com.acme;
import jakarta.persistence.*;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.*;

@MappedSuperclass abstract class Base {
  @Id @GeneratedValue(strategy = GenerationType.IDENTITY) Long id;
  Instant createdAt;
}
enum Level { LOW, HIGH }
@Embeddable class Address { String street; @Column(name = "zip", length = 10) String zipCode; }

@Entity @Table(name = "app_users", schema = "auth")
class User extends Base {
  @Column(nullable = false, unique = true, length = 120) String email;
  @Embedded Address address;
  @Enumerated(EnumType.STRING) Level level;
  Level ordinalLevel;
  @Lob String bio;
  @OneToMany(mappedBy = "owner") List<Account> accounts;
  @ManyToMany @JoinTable(name = "user_roles", joinColumns = @JoinColumn(name = "user_id"), inverseJoinColumns = @JoinColumn(name = "role_id")) Set<Role> roles;
  @ElementCollection Set<String> tags;
  @Transient String scratch;
}
@Entity class Role extends Base { String name; @ManyToMany(mappedBy = "roles") Set<User> users; }
@Entity class Account extends Base {
  @ManyToOne(optional = false) @JoinColumn(name = "owner_ref") User owner;
  @OneToOne Account backup;
  BigDecimal balance;
  int version;
}
@Entity @Inheritance(strategy = InheritanceType.JOINED) class Payment extends Base { BigDecimal amount; }
@Entity class CardPayment extends Payment { String last4; }
@Entity class Vehicle extends Base { String plate; }
@Entity class Car extends Vehicle { int doors; }
`;

const model = new EntityModel([{ file: 'file:///E.java', classes: parseJavaClasses(ENTITIES) }]);
const fromJava = fromEntityModel(model, 'App', 'postgresql');
const entity = (doc: ErdDocument, table: string) => doc.entities.find(e => e.table === table)!;
const column = (doc: ErdDocument, table: string, name: string) => entity(doc, table).columns.find(c => c.name === name)!;

suite('ERD: from @Entity classes', () => {
  test('maps tables, schemas and Spring Boot column naming', () => {
    const users = entity(fromJava, 'app_users');
    assert.strictEqual(users.schema, 'auth');
    assert.strictEqual(users.className, 'User');
    assert.deepStrictEqual(users.columns.map(c => c.name), ['id', 'created_at', 'email', 'street', 'zip', 'level', 'ordinal_level', 'bio']);
    assert.ok(!users.columns.some(c => c.name === 'scratch'), '@Transient is skipped');
    assert.deepStrictEqual(
      [column(fromJava, 'app_users', 'id').primaryKey, column(fromJava, 'app_users', 'id').autoIncrement, column(fromJava, 'app_users', 'id').type],
      [true, true, 'BIGINT'],
    );
    const email = column(fromJava, 'app_users', 'email');
    assert.deepStrictEqual([email.type, email.length, email.nullable, email.unique], ['VARCHAR', 120, false, true]);
    assert.deepStrictEqual([column(fromJava, 'app_users', 'zip').length, column(fromJava, 'app_users', 'created_at').type], [10, 'TIMESTAMPTZ']);
    assert.strictEqual(column(fromJava, 'app_users', 'level').type, 'VARCHAR', '@Enumerated(STRING)');
    assert.strictEqual(column(fromJava, 'app_users', 'ordinal_level').type, 'SMALLINT', 'enums default to ordinal');
    assert.strictEqual(column(fromJava, 'app_users', 'bio').type, 'TEXT', '@Lob');
    assert.strictEqual(column(fromJava, 'account', 'version').nullable, false, 'primitives are NOT NULL');
  });

  test('maps associations, join tables, element collections and inverse sides', () => {
    const owner = fromJava.relationships.find(r => r.field === 'owner')!;
    assert.deepStrictEqual([owner.columns, owner.refColumns, owner.inverseField], [['owner_ref'], ['id'], 'accounts']);
    assert.strictEqual(column(fromJava, 'account', 'owner_ref').nullable, false, 'optional = false');
    const backup = fromJava.relationships.find(r => r.field === 'backup')!;
    assert.deepStrictEqual([backup.columns, backup.oneToOne], [['backup_id'], true]);
    assert.strictEqual(column(fromJava, 'account', 'backup_id').unique, true);

    const roles = entity(fromJava, 'user_roles');
    assert.deepStrictEqual(roles.columns.map(c => [c.name, c.primaryKey]), [['user_id', true], ['role_id', true]]);
    const toUser = fromJava.relationships.find(r => r.from === roles.id && r.columns[0] === 'user_id')!;
    assert.strictEqual(toUser.inverseField, 'roles');

    const tags = entity(fromJava, 'user_tags');
    assert.deepStrictEqual(tags.columns.map(c => c.name), ['user_id', 'tags']);
  });

  test('handles single-table and joined inheritance', () => {
    const vehicle = entity(fromJava, 'vehicle');
    assert.deepStrictEqual(vehicle.columns.map(c => c.name), ['id', 'created_at', 'plate', 'doors', 'dtype']);
    assert.ok(!fromJava.entities.some(e => e.table === 'car'), 'SINGLE_TABLE subclasses share the root table');
    const card = entity(fromJava, 'card_payment');
    assert.deepStrictEqual(card.columns.map(c => c.name), ['id', 'last4']);
    const joined = fromJava.relationships.find(r => r.from === card.id)!;
    assert.deepStrictEqual([joined.to, joined.columns, joined.oneToOne], [entity(fromJava, 'payment').id, ['id'], true]);
  });

  test('gives connected entities the same color', () => {
    assert.strictEqual(entity(fromJava, 'app_users').color, entity(fromJava, 'account').color);
    assert.notStrictEqual(entity(fromJava, 'app_users').color, entity(fromJava, 'vehicle').color);
  });
});

suite('ERD: from database tables', () => {
  test('maps native types to portable ones and keeps the native type', () => {
    const doc = fromTables([
      table('items', [
        col('id', 'int8', { nullable: false, autoIncrement: true }), col('name', 'varchar', { length: 80, displayType: 'character varying(80)' }),
        col('price', 'numeric', { precision: 10, scale: 2 }), col('code', 'bpchar', { length: 3 }), col('meta', 'jsonb'), col('at', 'timestamptz'),
        col('body', 'text'), col('img', 'bytea'), col('ok', 'bool'), col('ref', 'uuid'),
      ], { pk: ['id'] }),
    ], 'postgresql', 'Shop');
    const types = entity(doc, 'items').columns.map(c => `${c.name}:${c.type}${c.length ? `(${c.length})` : ''}`);
    assert.deepStrictEqual(types, ['id:BIGINT', 'name:VARCHAR(80)', 'price:DECIMAL', 'code:CHAR(3)', 'meta:JSON', 'at:TIMESTAMPTZ', 'body:TEXT', 'img:BLOB', 'ok:BOOLEAN', 'ref:UUID']);
    assert.strictEqual(column(doc, 'items', 'name').nativeType, 'character varying(80)');
    assert.strictEqual(doc.nativeDialect, 'postgresql');
  });

  test('turns foreign keys into relationships and detects one-to-one', () => {
    const doc = fromTables(shopSchema(), 'postgresql', 'Shop');
    assert.strictEqual(doc.relationships.length, 5);
    const profile = doc.relationships.find(r => r.from === 'public.customer_profiles')!;
    assert.strictEqual(profile.oneToOne, true);
    assert.ok(!doc.relationships.find(r => r.from === 'public.orders')!.oneToOne);
  });
});

suite('ERD: to tables', () => {
  test('folds identifiers the way the target database does', () => {
    assert.strictEqual(foldIdentifier('order_items', 'oracle'), 'ORDER_ITEMS');
    assert.strictEqual(foldIdentifier('Orders', 'postgresql'), 'orders');
    assert.strictEqual(foldIdentifier('Orders', 'mysql'), 'Orders');
    assert.strictEqual(foldIdentifier('Display Name', 'oracle'), 'Display Name', 'special names stay quoted as written');
    const { tables, classNames } = toTables(fromJava, 'oracle');
    const users = tables.find(t => t.name === 'APP_USERS')!;
    assert.strictEqual(users.schema, 'AUTH');
    assert.deepStrictEqual(users.primaryKey, ['ID']);
    assert.strictEqual(classNames['AUTH.APP_USERS'], 'User');
    const account = tables.find(t => t.name === 'ACCOUNT')!;
    assert.deepStrictEqual(account.foreignKeys.map(f => [f.columns, f.referencedTable]), [[['OWNER_REF'], 'APP_USERS'], [['BACKUP_ID'], 'ACCOUNT']]);
    assert.ok(account.uniqueKeys.some(u => u.columns[0] === 'BACKUP_ID'), 'one-to-one becomes a unique key');
  });

  test('produces column metadata the entity generator maps back to the same Java types', () => {
    const { tables } = toTables(fromJava, 'postgresql');
    const users = tables.find(t => t.name === 'app_users')!;
    const email = users.columns.find(c => c.name === 'email')!;
    assert.deepStrictEqual([email.dataType, email.length, email.nullable], ['varchar', 120, false]);
    assert.strictEqual(users.columns.find(c => c.name === 'created_at')!.dataType, 'timestamptz');
    assert.strictEqual(nativeType({ type: 'INTEGER' }, 'sqlserver'), 'int');
    assert.strictEqual(nativeType({ type: 'VARCHAR', length: 40 }, 'oracle'), 'varchar2(40 char)');
    assert.strictEqual(nativeType({ type: 'DECIMAL', precision: 12, scale: 3 }, 'postgresql'), 'numeric(12,3)');
    assert.strictEqual(nativeType({ type: 'BOOLEAN' }, 'oracle'), 'number(1)');
    assert.strictEqual(nativeType({ type: 'JSON' }, 'mysql'), 'json');
  });

  test('converts names to snake_case like Spring Boot', () => {
    assert.strictEqual(snakeCase('createdAt'), 'created_at');
    assert.strictEqual(snakeCase('HTTPStatus'), 'http_status');
    assert.strictEqual(snakeCase('PurchaseOrder'), 'purchase_order');
  });
});

suite('ERD: DDL', () => {
  test('PostgreSQL: identity, constraints, foreign keys after tables, comments', () => {
    const doc = fromTables(shopSchema(), 'postgresql', 'Shop');
    doc.nativeDialect = undefined; // the fixtures' native types are placeholders; use portable types
    const ddl = generateDdl(doc, 'postgresql');
    assert.match(ddl, /create table customers \(\n {2}id bigint generated by default as identity not null,/);
    assert.match(ddl, /constraint pk_customers primary key \(id\)/);
    assert.match(ddl, /constraint uk_customers_email unique \(email\)/);
    assert.match(ddl, /alter table orders add constraint fk_orders_customer_id foreign key \(customer_id\) references customers \(id\);/);
    assert.match(ddl, /comment on table customers is 'People who buy things';/);
    assert.ok(ddl.indexOf('create table customers') < ddl.indexOf('create table orders'), 'referenced tables first');
    assert.ok(ddl.indexOf('create table orders') < ddl.lastIndexOf('alter table'), 'foreign keys last');
  });

  test('dialect specifics: identity syntax, quoting, inline comments, SQLite', () => {
    const reserved: ErdDocument = {
      version: 1, name: 'R', dialect: 'mysql', relationships: [],
      entities: [{ id: 'user', table: 'user', kind: 'table', comment: "Users' table", columns: [
        { name: 'id', type: 'BIGINT', nullable: false, primaryKey: true, autoIncrement: true, unique: false },
        { name: 'order', type: 'INTEGER', nullable: true, primaryKey: false, autoIncrement: false, unique: false, comment: 'Sort order' },
      ] }],
    };
    const mysql = generateDdl(reserved, 'mysql');
    assert.match(mysql, /create table `user` \(\n {2}id bigint auto_increment not null,\n {2}`order` int comment 'Sort order',/);
    assert.match(mysql, /\) comment = 'Users'' table';/);
    assert.match(generateDdl(reserved, 'sqlserver'), /create table \[user\] \(\n {2}id bigint identity\(1,1\) not null,/);
    assert.match(generateDdl(reserved, 'sqlserver'), /exec sp_addextendedproperty 'MS_Description', 'Users'' table', 'SCHEMA', 'dbo', 'TABLE', 'user';/);
    assert.match(generateDdl(reserved, 'oracle'), /create table "USER" \(\n {2}ID number\(19\) generated by default as identity not null,/);
    const sqlite = generateDdl(fromTables(shopSchema(), 'postgresql', 'S'), 'sqlite');
    assert.match(sqlite, /id integer primary key autoincrement/);
    assert.match(sqlite, /create table orders \([^;]*constraint fk_orders_customer_id foreign key \(customer_id\) references customers \(id\)[^;]*\);/);
    assert.doesNotMatch(sqlite, /alter table/);
    assert.strictEqual(quoteIdentifier('select', 'postgresql'), '"select"');
  });

  test('reuses native types for the same database and skips views', () => {
    const doc = fromTables([
      table('t', [col('id', 'int4', { nullable: false, displayType: 'integer' }), col('state', 'mood', { displayType: 'mood' })], { pk: ['id'] }),
      table('v', [col('n', 'int8')], { kind: 'view' }),
    ], 'postgresql', 'N');
    const pg = generateDdl(doc, 'postgresql');
    assert.match(pg, /state mood,/, 'native type kept for PostgreSQL');
    assert.match(generateDdl(doc, 'mysql'), /state longtext,/, 'portable type for another database');
    assert.match(pg, /-- v is a view/);
  });

  test('splits statements and names migrations', () => {
    assert.deepStrictEqual(splitStatements('-- header\n\ncreate table a (\n  x int\n);\n\nalter table a add y int;\n'), ['create table a (\n  x int\n)', 'alter table a add y int']);
    assert.strictEqual(nextMigrationName(['V1__init.sql', 'V2_1__more.sql', 'README.md'], 'Create Shop · public'), 'V3__create_shop_public.sql');
    assert.strictEqual(nextMigrationName([], ''), 'V1__schema.sql');
  });

  test('orders tables so references come first, tolerating cycles', () => {
    const doc = fromTables(shopSchema(), 'postgresql', 'S');
    doc.relationships.push({ id: 'cycle', from: 'public.customers', columns: ['id'], to: 'public.order_items', refColumns: ['order_id'] });
    const order = dependencyOrder(doc).map(e => e.table);
    assert.strictEqual(order.length, doc.entities.length);
    assert.ok(order.indexOf('orders') < order.indexOf('order_items'));
  });
});

suite('ERD: documents and layout', () => {
  test('parses, normalizes and serializes documents', () => {
    const doc = parseDocument('{"entities":[{"table":"t","columns":[{"name":"a","type":"NOPE"}]}]}');
    assert.deepStrictEqual([doc.version, doc.dialect, doc.entities[0].id, doc.entities[0].kind], [1, 'postgresql', 't', 'table']);
    assert.deepStrictEqual(doc.entities[0].columns[0], { name: 'a', type: 'VARCHAR', nullable: true, primaryKey: false, autoIncrement: false, unique: false });
    assert.throws(() => parseDocument('{"tables": []}'), /entities/);
    assert.strictEqual(parseDocument('').entities.length, 0);
    assert.ok(serializeDocument(doc).endsWith('}\n'));
  });

  test('keeps positions and colors when a diagram is regenerated', () => {
    const before = fromTables(shopSchema(), 'postgresql', 'S');
    before.entities[0].x = 100;
    before.entities[0].y = 200;
    before.entities[0].color = '#123456';
    const merged = mergeLayout(fromTables(shopSchema(), 'postgresql', 'S2'), before);
    assert.deepStrictEqual([merged.entities[0].x, merged.entities[0].y, merged.entities[0].color, merged.name], [100, 200, '#123456', 'S']);
  });

  test('lays out without overlaps, referenced tables to the left', () => {
    const doc = fromTables(shopSchema(), 'postgresql', 'S');
    doc.entities.push(...['a', 'b', 'c'].map(n => ({ id: n, table: n, kind: 'table' as const, columns: [] })));
    const size = (id: string) => ({ width: 220, height: id === 'public.orders' ? 160 : 100 });
    const pos = layoutLib.layout(doc.entities, doc.relationships, size);
    const boxes = doc.entities.map(e => ({ ...pos[e.id], ...size(e.id) }));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        assert.ok(!layoutLib.overlaps(boxes[i], boxes[j]), `${doc.entities[i].id} overlaps ${doc.entities[j].id}`);
      }
    }
    assert.ok(pos['public.customers'].x < pos['public.orders'].x);
    assert.ok(pos['public.orders'].x < pos['public.order_items'].x);
    assert.ok(Object.values(pos).every(p => p.x % 8 === 0 && p.y % 8 === 0), 'snapped to the grid');
  });
});
