import * as assert from 'assert';
import { DEFAULT_OPTIONS, generateEntities, GeneratorOptions, sqlName } from '../../codegen/entityGenerator';
import { col, shopSchema, table } from './fixtures';

const opts = (o: Partial<GeneratorOptions> = {}): GeneratorOptions => ({ ...DEFAULT_OPTIONS, kind: 'postgresql', defaultSchema: 'public', ...o });

function gen(o: Partial<GeneratorOptions> = {}, tables = shopSchema()) {
  const r = generateEntities(tables, opts(o));
  return { ...r, file: (name: string) => r.files.find(f => f.className === name)?.content ?? assert.fail(`no ${name}`) };
}

suite('entityGenerator', () => {
  test('creates one entity and repository per table, plus ID classes for composite keys', () => {
    const r = gen();
    const names = r.files.map(f => `${f.kind}:${f.relativePath}`).sort();
    assert.deepStrictEqual(names, [
      'entity:com/example/entity/Category.java',
      'entity:com/example/entity/Customer.java',
      'entity:com/example/entity/CustomerProfile.java',
      'entity:com/example/entity/Order.java',
      'entity:com/example/entity/OrderItem.java',
      'id:com/example/entity/OrderItemId.java',
      'repository:com/example/repository/CategoryRepository.java',
      'repository:com/example/repository/CustomerProfileRepository.java',
      'repository:com/example/repository/CustomerRepository.java',
      'repository:com/example/repository/OrderItemRepository.java',
      'repository:com/example/repository/OrderRepository.java',
    ]);
    assert.ok(r.files.every(f => f.tableName && f.table.endsWith(`.${f.tableName}`)));
  });

  test('maps columns with ids, identity, version, uniqueness, length and comments', () => {
    const c = gen().file('Customer');
    assert.match(c, /^package com\.example\.entity;/);
    assert.match(c, /\/\*\* People who buy things \*\/\n@Entity\n@Table\(name = "customers"\)\npublic class Customer \{/);
    assert.match(c, /@Id\n {4}@GeneratedValue\(strategy = GenerationType\.IDENTITY\)\n {4}@Column\(name = "id"\)\n {4}private Long id;/);
    assert.match(c, /\/\*\* Login e-mail \*\/\n {4}@Column\(name = "email", nullable = false, unique = true, length = 255\)/);
    assert.match(c, /@Version\n {4}@Column\(name = "version", nullable = false\)\n {4}private Integer version;/);
    assert.match(c, /public Long getId\(\) \{\n {8}return id;\n {4}\}/);
    assert.match(gen().file('Order'), /@Column\(name = "total", precision = 12, scale = 2\)\n {4}private BigDecimal total;/);
  });

  test('maps foreign keys to lazy associations', () => {
    const o = gen().file('Order');
    assert.match(o, /@ManyToOne\(fetch = FetchType\.LAZY, optional = false\)\n {4}@JoinColumn\(name = "customer_id", nullable = false\)\n {4}private Customer customer;/);
    assert.match(o, /@ManyToOne\(fetch = FetchType\.LAZY\)\n {4}@JoinColumn\(name = "shipped_to_id"\)\n {4}private Customer shippedTo;/);
    assert.doesNotMatch(o, /customerId/);
    assert.match(gen().file('Category'), /private Category parent;/);
  });

  test('uses @OneToOne for unique foreign keys', () => {
    const p = gen().file('CustomerProfile');
    assert.match(p, /@OneToOne\(fetch = FetchType\.LAZY, optional = false\)\n {4}@JoinColumn\(name = "customer_id", nullable = false\)\n {4}private Customer customer;/);
  });

  test('keeps FK columns that are part of the primary key as @Id fields with a read-only association', () => {
    const i = gen().file('OrderItem');
    assert.match(i, /@IdClass\(OrderItemId\.class\)/);
    assert.match(i, /@Id\n {4}@Column\(name = "order_id"\)\n {4}private Long orderId;/);
    assert.match(i, /@JoinColumn\(name = "order_id", insertable = false, updatable = false\)\n {4}private Order order;/);
    const id = gen().file('OrderItemId');
    assert.match(id, /public class OrderItemId implements Serializable \{/);
    assert.match(id, /return Objects\.equals\(orderId, that\.orderId\)\n {12}&& Objects\.equals\(lineNo, that\.lineNo\);/);
    assert.match(id, /return Objects\.hash\(orderId, lineNo\);/);
    assert.match(gen().file('OrderItemRepository'), /import com\.example\.entity\.OrderItemId;\nimport org\.springframework\.data\.jpa\.repository\.JpaRepository;\n\npublic interface OrderItemRepository extends JpaRepository<OrderItem, OrderItemId> \{/);
  });

  test('generates disambiguated inverse collections when asked', () => {
    const r = gen({ inverseRelationships: true });
    const c = r.file('Customer');
    assert.match(c, /@OneToMany\(mappedBy = "customer"\)\n {4}private List<Order> ordersByCustomer = new ArrayList<>\(\);/);
    assert.match(c, /@OneToMany\(mappedBy = "shippedTo"\)\n {4}private List<Order> ordersByShippedTo = new ArrayList<>\(\);/);
    assert.match(c, /@OneToOne\(mappedBy = "customer"\)\n {4}private CustomerProfile customerProfile;/);
    assert.match(r.file('Order'), /@OneToMany\(mappedBy = "order"\)\n {4}private List<OrderItem> orderItems = new ArrayList<>\(\);/);
    // Self reference
    assert.match(r.file('Category'), /@OneToMany\(mappedBy = "parent"\)\n {4}private List<Category> categoriesByParent/);
    assert.doesNotMatch(gen().file('Customer'), /OneToMany/);
  });

  test('falls back to plain columns when relationships are off or the target is not generated', () => {
    assert.match(gen({ relationships: false }).file('Order'), /@Column\(name = "customer_id", nullable = false\)\n {4}private Long customerId;/);
    const onlyOrders = gen({}, shopSchema().filter(t => t.name === 'orders'));
    assert.match(onlyOrders.file('Order'), /private Long customerId;/);
    assert.doesNotMatch(onlyOrders.file('Order'), /ManyToOne/);
  });

  test('uses Lombok instead of accessors', () => {
    const c = gen({ lombok: true }).file('Customer');
    assert.match(c, /import lombok\.Getter;\nimport lombok\.NoArgsConstructor;\nimport lombok\.Setter;/);
    assert.match(c, /@Getter\n@Setter\n@NoArgsConstructor\npublic class Customer/);
    assert.doesNotMatch(c, /public Long getId\(\)/);
    assert.doesNotMatch(c, /@Data|@EqualsAndHashCode/);
  });

  test('supports javax.persistence', () => {
    const r = gen({ persistenceApi: 'javax' });
    assert.match(r.file('Customer'), /import javax\.persistence\.Entity;/);
    assert.doesNotMatch(r.file('Customer'), /jakarta/);
    assert.match(r.file('CustomerProfile'), /\/\/ TODO: jsonb column/);
  });

  test('maps JSON with Hibernate 6 for jakarta', () => {
    assert.match(gen().file('CustomerProfile'), /@JdbcTypeCode\(SqlTypes\.JSON\)\n {4}@Column\(name = "preferences"\)\n {4}private String preferences;/);
  });

  test('can skip repositories and put them in any package', () => {
    assert.ok(!gen({ generateRepositories: false }).files.some(f => f.kind === 'repository'));
    const same = gen({ repositoryPackage: 'com.example.entity' }).file('CustomerRepository');
    assert.doesNotMatch(same, /^import com\.example\.entity/m);
  });

  test('writes schema/catalog only when it differs from the default (or when asked)', () => {
    const sales = [table('invoices', [col('id', 'int4', { nullable: false })], { pk: ['id'], schema: 'sales' })];
    assert.match(gen({}, sales).file('Invoice'), /@Table\(name = "invoices", schema = "sales"\)/);
    assert.match(gen({ kind: 'mysql', defaultSchema: 'shop' }, sales).file('Invoice'), /catalog = "sales"/);
    assert.match(gen({ alwaysIncludeSchema: true }).file('Customer'), /@Table\(name = "customers", schema = "public"\)/);
    assert.match(gen().file('Customer'), /@Table\(name = "customers"\)/);
  });

  test('quotes reserved words and identifiers that need it, per dialect', () => {
    assert.strictEqual(sqlName('user', 'postgresql'), '"user"');
    assert.strictEqual(sqlName('Order', 'postgresql'), '"Order"');
    assert.strictEqual(sqlName('first_name', 'postgresql'), 'first_name');
    assert.strictEqual(sqlName('CUSTOMERS', 'oracle'), 'CUSTOMERS');
    assert.strictEqual(sqlName('customers', 'oracle'), '"customers"');
    assert.strictEqual(sqlName('Customers', 'mysql'), 'Customers');
    assert.strictEqual(sqlName('Display Name', 'sqlserver'), '"Display Name"');
    const u = gen({}, [table('user', [col('id', 'int4', { nullable: false }), col('Display Name', 'varchar')], { pk: ['id'] })]).file('User');
    assert.match(u, /@Table\(name = "\\"user\\""\)/);
    assert.match(u, /@Column\(name = "\\"Display Name\\""\)\n {4}private String displayName;/);
  });

  test('avoids class names that clash with imported types and keeps names unique', () => {
    const r = gen({}, [
      table('column', [col('id', 'int4', { nullable: false })], { pk: ['id'] }),
      table('users', [col('id', 'int4', { nullable: false })], { pk: ['id'] }),
      table('user', [col('id', 'int4', { nullable: false })], { pk: ['id'] }),
    ]);
    assert.deepStrictEqual(r.files.filter(f => f.kind === 'entity').map(f => f.className), ['ColumnEntity', 'User', 'User2']);
  });

  test('renames fields that are Java keywords or collide', () => {
    const t = table('things', [
      col('id', 'int4', { nullable: false }), col('class', 'varchar'), col('default', 'bool'), col('user_name', 'text'), col('userName', 'text'),
    ], { pk: ['id'] });
    const c = gen({}, [t]).file('Thing');
    assert.match(c, /private String clazz;/);
    assert.match(c, /private Boolean defaultValue;/);
    assert.match(c, /private String userName;/);
    assert.match(c, /private String userName2;/);
  });

  test('handles tables without a primary key and views', () => {
    const r = gen({}, [
      table('audit', [col('at', 'timestamptz', { nullable: false }), col('what', 'text', { nullable: false })]),
      table('ledger', [col('code', 'varchar', { nullable: false, length: 10 }), col('amount', 'numeric')], { uniques: [{ name: 'uk', columns: ['code'] }] }),
      table('stats', [col('n', 'int8')], { kind: 'view' }),
    ]);
    assert.match(r.file('Audit'), /@IdClass\(AuditId\.class\)/);
    assert.ok(r.warnings.some(w => w.includes('audit')));
    assert.match(r.file('Ledger'), /@Id\n {4}@Column\(name = "code", length = 10\)/);
    assert.match(r.file('Ledger'), /unique key "uk" is used as the identifier/);
    assert.match(r.file('Stat'), /@Immutable\npublic class Stat/);
    assert.ok(!r.warnings.some(w => w.includes('stats')), 'views do not warn about missing keys');
  });

  test('uses referencedColumnName for FKs to non-primary-key columns and @JoinColumns for composite FKs', () => {
    const r = gen({}, [
      table('countries', [col('id', 'int4', { nullable: false }), col('iso', 'bpchar', { nullable: false, length: 2 })], { pk: ['id'], uniques: [{ name: 'u', columns: ['iso'] }] }),
      table('cities', [col('id', 'int4', { nullable: false }), col('country_iso', 'bpchar', { length: 2 })], {
        pk: ['id'], fks: [{ columns: ['country_iso'], referencedTable: 'countries', referencedColumns: ['iso'] }],
      }),
      table('shipments', [col('id', 'int4', { nullable: false }), col('order_id', 'int8', { nullable: false }), col('line_no', 'int4', { nullable: false })], {
        pk: ['id'], fks: [{ columns: ['order_id', 'line_no'], referencedTable: 'lines', referencedColumns: ['order_id', 'line_no'] }],
      }),
      table('lines', [col('order_id', 'int8', { nullable: false }), col('line_no', 'int4', { nullable: false })], { pk: ['order_id', 'line_no'] }),
    ]);
    assert.match(r.file('City'), /@JoinColumn\(name = "country_iso", referencedColumnName = "iso"\)\n {4}private Country country;/);
    assert.match(r.file('Country'), /@JdbcTypeCode\(SqlTypes\.CHAR\)\n {4}@Column\(name = "iso", nullable = false, unique = true, length = 2\)/);
    assert.match(r.file('Shipment'), /@JoinColumns\(\{\n {8}@JoinColumn\(name = "order_id", referencedColumnName = "order_id", nullable = false\),\n {8}@JoinColumn\(name = "line_no", referencedColumnName = "line_no", nullable = false\)\n {4}\}\)\n {4}private Line line;/);
  });

  test('emits columnDefinition for exact types and TODOs for unmapped ones', () => {
    const r = gen({ kind: 'mysql', defaultSchema: 'public' }, [table('t', [
      col('id', 'int', { nullable: false, unsigned: true, displayType: 'int unsigned' }),
      col('status', 'enum', { displayType: "enum('A','B')" }),
      col('shape', 'geometry'),
    ], { pk: ['id'] })]);
    const t = r.file('T');
    assert.match(t, /@Column\(name = "id", columnDefinition = "int unsigned"\)\n {4}private Long id;/);
    assert.match(t, /@Column\(name = "status", columnDefinition = "enum\('A','B'\)"\)/);
    assert.match(t, /\/\/ TODO: no standard JPA mapping for SQL type geometry/);
  });

  test('escapes javadoc terminators in comments', () => {
    const t = table('t', [col('id', 'int4', { nullable: false, comment: 'evil */ comment' })], { pk: ['id'] });
    const c = gen({}, [t]).file('T');
    assert.doesNotMatch(c, /evil \*\/ comment/);
  });

  test('strips table prefixes', () => {
    const r = gen({ stripTablePrefixes: ['tbl_'] }, [table('tbl_orders', [col('id', 'int4', { nullable: false })], { pk: ['id'] })]);
    assert.ok(r.files.some(f => f.className === 'Order'));
  });
});
