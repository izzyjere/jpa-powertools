import * as assert from 'assert';
import { decapitalize, deriveJpql, returnElementType } from '../../jpql/derivedQuery';
import { EntityModel, suggest } from '../../jpql/entityModel';
import { extractQueries, MethodSignature, parseJavaClasses, repositoryMethods } from '../../jpql/javaSource';
import { analyzeJpql, checkMethodParameters, completeJpql, lexJpql, referenceAt } from '../../jpql/jpql';
import { buildQuery, conditionPaths, javaStringLiteral } from '../../jpql/queryBuilder';

const ENTITIES = `
package com.acme.domain;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.*;

@MappedSuperclass
abstract class Base { @Id Long id; LocalDateTime createdAt; }

@Embeddable class Address { String city; String zip; }

@Entity(name = "Order")
@Table(name = "orders")
class PurchaseOrder extends Base {
  @ManyToOne Customer customer;
  BigDecimal total;
  @OneToMany(mappedBy = "order") List<Line> lines = new ArrayList<>();
  static final int LIMIT = 10;
  @Transient String label;
  public BigDecimal getTotal() { return total; }
}

@Entity class Customer extends Base {
  String email;
  @Embedded Address address;
  @OneToMany(mappedBy = "customer") Set<PurchaseOrder> orders;
  @ElementCollection Map<String, String> attributes;
  Status status;
  enum Status { ACTIVE, BLOCKED }
}

@Entity class Line extends Base { @ManyToOne PurchaseOrder order; String sku; int quantity; }

@Entity class Audited extends org.springframework.data.jpa.domain.AbstractPersistable<Long> { String note; }
`;

const model = new EntityModel([{ file: 'file:///Entities.java', classes: parseJavaClasses(ENTITIES) }]);
const errors = (q: string) => analyzeJpql(q, model).diagnostics.map(d => d.message);

suite('JPQL: Java source scanning', () => {
  test('parses entities, embeddables, inheritance and collection element types', () => {
    const order = model.entity('Order')!;
    assert.strictEqual(order.name, 'PurchaseOrder');
    assert.deepStrictEqual([...order.attributes.keys()], ['id', 'createdAt', 'customer', 'total', 'lines']);
    const lines = order.attributes.get('lines')!;
    assert.deepStrictEqual([lines.collection, lines.elementType], [true, 'Line']);
    assert.strictEqual(model.target(order.attributes.get('customer')!)!.name, 'Customer');
    const customer = model.entity('Customer')!;
    assert.strictEqual(model.target(customer.attributes.get('address')!)!.kind, 'embeddable');
    assert.strictEqual(customer.attributes.get('attributes')!.elementType, 'String', 'Map value type');
    assert.strictEqual(model.entity('Audited')!.incomplete, true, 'superclass outside the workspace');
    assert.strictEqual(model.entity('PurchaseOrder'), undefined, 'entity name overrides the class name');
    assert.strictEqual(model.entity('com.acme.domain.PurchaseOrder')!.name, 'PurchaseOrder', 'FQN lookup (HQL)');
  });

  test('extracts @Query strings with exact source offsets (escapes, concatenation, text blocks)', () => {
    const src = [
      'import org.springframework.data.jpa.repository.Query;',
      'interface R extends JpaRepository<Customer, Long> {',
      '  @Query("select c from Customer c where c.email = \\"x\\" and " + "c.id = :id")',
      '  Customer a(@Param("id") Long id);',
      '  @Query(value = """',
      '      select c',
      '        from Customer c',
      '      """, countQuery = "select count(c) from Customer c")',
      '  Page<Customer> b(Pageable p);',
      '  @Query(value = "select * from customers", nativeQuery = true) List<Customer> c();',
      '}',
    ].join('\n');
    const qs = extractQueries(src);
    assert.deepStrictEqual(qs.map(q => [q.source, q.query.value]), [
      ['query', 'select c from Customer c where c.email = "x" and c.id = :id'],
      ['query', 'select c\n  from Customer c\n'],
      ['countQuery', 'select count(c) from Customer c'],
    ]);
    for (const q of qs) {
      for (let i = 0; i < q.query.value.length; i++) {
        const ch = q.query.value[i];
        if (ch !== '\n' && ch !== '"') {
          assert.strictEqual(src[q.query.offsets[i]], ch, `offset of '${ch}' at ${i}`);
        }
      }
    }
    assert.deepStrictEqual(qs[0].method!.params.map(p => [p.name, p.type, p.paramAnnotation]), [['id', 'Long', 'id']]);
    assert.deepStrictEqual(qs[1].method!.params.map(p => p.type), ['Pageable']);
  });

  test('only treats Spring Data JPA @Query as JPQL; finds @NamedQuery and createQuery', () => {
    const mongo = 'import org.springframework.data.mongodb.repository.Query;\ninterface R { @Query("{ \'name\': ?0 }") List<X> f(String n); }';
    assert.deepStrictEqual(extractQueries(mongo), []);
    const other = '@NamedQuery(name = "C.all", query = "select c from Customer c")\nclass C { void f() { em.createQuery("select c from Customer c where c.id = :id", Customer.class); em.createQuery(jpql); } }';
    assert.deepStrictEqual(extractQueries(other).map(q => q.source), ['namedQuery', 'createQuery']);
    const fq = 'interface R { @org.springframework.data.jpa.repository.Query("select c from Customer c") List<Customer> f(); }';
    assert.strictEqual(extractQueries(fq).length, 1);
    assert.deepStrictEqual(extractQueries('interface R { @Query("from " + TABLE) List<X> f(); }\nimport org.springframework.data.jpa.repository.Query;'), [], 'non-literal parts are skipped');
  });

  test('finds repository methods and their domain type', () => {
    const src = 'public interface OrderRepository extends JpaRepository<PurchaseOrder, Long>, JpaSpecificationExecutor<PurchaseOrder> {\n'
      + '  List<PurchaseOrder> findByCustomerEmail(String email);\n  @Query("x") long countAll();\n  default void helper() { }\n}';
    const methods = repositoryMethods(src);
    assert.deepStrictEqual(methods.map(m => [m.name, m.domainType, m.annotations.join(',')]),
      [['findByCustomerEmail', 'PurchaseOrder', ''], ['countAll', 'PurchaseOrder', 'Query'], ['helper', 'PurchaseOrder', '']]);
    assert.strictEqual(methods[0].returnType, 'List<PurchaseOrder>');
  });
});

suite('JPQL: analysis', () => {
  test('accepts valid JPQL and HQL', () => {
    for (const q of [
      'select o from Order o join o.customer c where c.address.city = :city and o.total > 10',
      'select c from Customer c where c.status = com.acme.domain.Customer.Status.ACTIVE',
      'select o from Order o where o.customer.email like :e order by o.createdAt desc',
      'select count(l) from Line l where l.order.customer.id = ?1',
      'from Customer where email = :e',
      'select c from Customer c where exists (select l from Line l where l.order.customer = c)',
      'select key(a), value(a) from Customer c join c.attributes a',
      'select new com.acme.dto.Row(c.email, count(o)) from Customer c join c.orders o group by c.email',
      'select a.note, a.id from Audited a',
      'update Order o set o.total = 0 where o.id in :ids',
      "select c from Customer c where c.email = 'it''s'",
      'select c from Customer c where c.email = :#{#customer.email}',
      'select extract(year from o.createdAt) from Order o',
    ]) {
      assert.deepStrictEqual(errors(q), [], q);
    }
  });

  test('reports unknown attributes, entities and aliases with suggestions', () => {
    const a = analyzeJpql('select c from Customer c where c.emial = :e', model);
    assert.strictEqual(a.diagnostics[0].message, "Entity 'Customer' has no attribute 'emial'. Did you mean 'email'?");
    assert.strictEqual(a.diagnostics[0].replacement, 'email');
    assert.strictEqual('select c from Customer c where c.emial = :e'.substring(a.diagnostics[0].start, a.diagnostics[0].end), 'emial');

    const e = analyzeJpql('select c from Custmer c', model).diagnostics[0];
    assert.deepStrictEqual([e.severity, e.replacement], ['warning', 'Customer'], 'unknown entities may live in a jar: warning');
    const cs = analyzeJpql('select c from customer c', model).diagnostics[0];
    assert.deepStrictEqual([cs.severity, cs.message], ['error', "Entity names are case-sensitive: did you mean 'Customer'?"]);
    assert.match(errors('select o from Order o where o.customer.address.town = 1')[0], /Embeddable 'Address' has no attribute 'town'/);
    assert.match(errors('select x.email from Customer c')[0], /Unknown alias 'x'/);
    assert.match(errors('select c from Customer c where c.email.foo = 1')[0], /basic attribute \(String\)/);
    assert.match(errors('select c from Customer c where c.orders.total > 1')[0], /'orders' is a collection; join it/);
    assert.match(errors('select o from Order o where o.label = :l')[0], /no attribute 'label'/, '@Transient is not persistent');
    assert.match(errors('select o from Order o where o.LIMIT = 1')[0], /no attribute 'LIMIT'/, 'static fields are not attributes');
    assert.match(errors('select o from Order o join o.linez l')[0], /Did you mean 'lines'/);
  });

  test('reports syntax slips', () => {
    assert.match(errors('select c from Customer c where')[0], /incomplete after 'where'/);
    assert.match(errors('select c from Customer c order c.email')[0], /ORDER must be followed by BY/);
    assert.match(errors('select from Customer c')[0], /SELECT clause is empty/);
    assert.match(errors("select c from Customer c where c.email = 'x")[0], /Unterminated string/);
    assert.match(errors('select c from Customer c where (c.id = 1')[0], /Unclosed parenthesis/);
    assert.match(errors('select c from Customer c where c.id = 1)')[0], /Unmatched closing parenthesis/);
    assert.match(errors('select c, from Customer c')[0], /Unexpected comma/);
    assert.match(errors('selec c from Customer c')[0], /starts with SELECT, UPDATE or DELETE/);
    assert.match(errors('select c from Customer c where c.id = :a and c.email = ?1')[0], /Do not mix named/);
    assert.match(errors('')[0], /empty/);
  });

  test('records references for hover and go-to-definition', () => {
    const q = 'select o from Order o where o.customer.email = :e';
    const a = analyzeJpql(q, model);
    const ref = referenceAt(a, q.indexOf('email') + 2)!;
    assert.deepStrictEqual([ref.kind, ref.cls.name, ref.attribute!.name], ['attribute', 'Customer', 'email']);
    assert.strictEqual(referenceAt(a, q.indexOf('Order') + 1)!.cls.name, 'PurchaseOrder');
    assert.strictEqual(referenceAt(a, q.indexOf('id', q.indexOf('customer'))), undefined);
  });

  test('lexes parameters, strings and operators', () => {
    assert.deepStrictEqual(lexJpql("a.b <> :p and x = ?12 or y = 'q''s' || :#{#x}").map(t => t.type),
      ['ident', 'punct', 'ident', 'op', 'param', 'ident', 'ident', 'op', 'param', 'ident', 'ident', 'op', 'string', 'op', 'param']);
  });
});

suite('JPQL: parameter binding', () => {
  const method = (params: Array<[string, string, string?]>): MethodSignature => ({
    name: 'find', nameStart: 0, nameEnd: 0, returnType: 'List<Customer>',
    params: params.map(([name, type, paramAnnotation]) => ({ name, type, paramAnnotation, start: 0 })),
  });

  test('matches named parameters to @Param or parameter names', () => {
    const a = analyzeJpql('select c from Customer c where c.email = :email and c.status = :st', model);
    const ok = checkMethodParameters(a, method([['email', 'String'], ['status', 'Status', 'st'], ['page', 'Pageable']]));
    assert.deepStrictEqual([ok.query, ok.unboundParams], [[], []]);
    const bad = checkMethodParameters(a, method([['mail', 'String'], ['status', 'Status', 'st'], ['extra', 'int']]));
    assert.match(bad.query[0].message, /No method parameter is bound to ':email'/);
    assert.deepStrictEqual(bad.unboundParams.map(u => u.param.name), ['mail', 'extra']);
  });

  test('checks positional parameters against the bindable parameter count', () => {
    const a = analyzeJpql('select c from Customer c where c.id = ?1 and c.email = ?2', model);
    assert.deepStrictEqual(checkMethodParameters(a, method([['id', 'Long'], ['email', 'String'], ['sort', 'Sort']])).query, []);
    assert.match(checkMethodParameters(a, method([['id', 'Long'], ['sort', 'Sort']])).query[0].message, /\?2 has no matching parameter/);
  });

  test('does not report unbound parameters when SpEL is used', () => {
    const a = analyzeJpql('select c from Customer c where c.email = :#{#c.email}', model);
    assert.deepStrictEqual(checkMethodParameters(a, method([['c', 'Customer']])).unboundParams, []);
  });
});

suite('JPQL: completion', () => {
  const labels = (q: string, offset = q.length, params: string[] = []) => completeJpql(q, offset, model, params).items.map(i => i.label);

  test('completes attributes after an alias path', () => {
    assert.deepStrictEqual(labels('select o from Order o where o.'), ['id', 'createdAt', 'customer', 'total', 'lines']);
    assert.deepStrictEqual(labels('select o from Order o where o.customer.address.'), ['city', 'zip']);
    const partial = completeJpql('select o from Order o where o.cus', 33, model);
    assert.deepStrictEqual([partial.replaceStart, partial.items.find(i => i.label === 'customer')?.kind], [30, 'association']);
  });

  test('completes entities, aliases, keywords and parameters', () => {
    assert.deepStrictEqual(labels('select x from '), ['Audited', 'Customer', 'Line', 'Order']);
    assert.ok(labels('select o from Order o join ').includes('o'));
    assert.deepStrictEqual(labels('select o from Order '), ['o']);
    const general = labels('select o from Order o where ');
    assert.ok(general.includes('o') && general.includes('ORDER BY') && general.includes('UPPER'));
    assert.deepStrictEqual(labels('select o from Order o where o.id = :', undefined, ['id', 'email']), ['id', 'email']);
  });
});

suite('JPQL: derived queries', () => {
  const customer = model.entity('Customer')!;
  const order = model.entity('Order')!;
  const m = (name: string, params: Array<[string, string]>, returnType = 'List<Customer>'): MethodSignature => ({
    name, nameStart: 0, nameEnd: 0, returnType, params: params.map(([n, type]) => ({ name: n, type, start: 0 })),
  });
  const jpql = (name: string, params: Array<[string, string]>, entity = customer, returnType?: string) => {
    const r = deriveJpql(m(name, params, returnType ?? `List<${entity.name}>`), entity, model);
    return r.ok ? r.jpql : `NO: ${r.reason}`;
  };

  test('translates predicates, keywords and ordering', () => {
    assert.strictEqual(jpql('findByEmail', [['email', 'String']]), 'select c from Customer c where c.email = :email');
    assert.strictEqual(jpql('findByAddressCityAndStatusOrderByEmailDesc', [['city', 'String'], ['status', 'Status']]),
      'select c from Customer c where c.address.city = :city and c.status = :status order by c.email desc');
    assert.strictEqual(jpql('findByEmailOrAddressZip', [['e', 'String'], ['z', 'String']]), 'select c from Customer c where c.email = :e or c.address.zip = :z');
    assert.strictEqual(jpql('findByEmailAndStatusOrAddressCity', [['e', 'String'], ['s', 'Status'], ['c', 'String']]),
      'select c from Customer c where (c.email = :e and c.status = :s) or c.address.city = :c');
    assert.strictEqual(jpql('findByEmailIgnoreCase', [['e', 'String']]), 'select c from Customer c where upper(c.email) = upper(:e)');
    assert.strictEqual(jpql('findByCreatedAtBetween', [['a', 'LocalDateTime'], ['b', 'LocalDateTime']]), 'select c from Customer c where c.createdAt between :a and :b');
    assert.strictEqual(jpql('findByEmailIsNull', []), 'select c from Customer c where c.email is null');
    assert.strictEqual(jpql('findByStatusNotIn', [['s', 'Collection<Status>']]), 'select c from Customer c where c.status not in :s');
    assert.strictEqual(jpql('findByOrdersIsEmpty', []), 'select c from Customer c where c.orders is empty');
    assert.strictEqual(jpql('findByEmailStartingWith', [['p', 'String']]),
      "select c from Customer c where c.email like concat(:#{escape([0])}, '%') escape :#{escapeCharacter()}");
    assert.strictEqual(jpql('findByOrdersTotalGreaterThan', [['t', 'BigDecimal']]),
      'select distinct c from Customer c join c.orders o where o.total > :t');
    assert.strictEqual(jpql('findByCustomer_Address_Zip', [['z', 'String']], order), 'select o from Order o where o.customer.address.zip = :z');
    assert.strictEqual(jpql('countByCustomerEmail', [['e', 'String']], order, 'long'), 'select count(o) from Order o where o.customer.email = :e');
    assert.strictEqual(jpql('existsByEmail', [['e', 'String']], customer, 'boolean'), 'select case when count(c) > 0 then true else false end from Customer c where c.email = :e');
    assert.strictEqual(jpql('findAllByOrderByEmailAsc', []), 'select c from Customer c order by c.email asc');
    assert.strictEqual(jpql('findByEmailAndStatus', [['e', 'String'], ['s', 'Status'], ['page', 'Pageable']]),
      'select c from Customer c where c.email = :e and c.status = :s');
  });

  test('explains when a derived query cannot be converted', () => {
    assert.match(jpql('findTop3ByEmail', [['e', 'String']]), /^NO: First\/Top/);
    assert.match(jpql('deleteByEmail', [['e', 'String']]), /^NO: Derived delete/);
    assert.match(jpql('findByNickname', [['n', 'String']]), /^NO: No property 'nickname'/);
    assert.match(jpql('findByEmailAndStatus', [['e', 'String']]), /fewer parameters/);
    assert.match(jpql('findByEmail', [['e', 'String']], customer, 'List<CustomerView>'), /projection/);
    assert.match(jpql('findByEmailMatchesRegex', [['e', 'String']]), /does not support/);
    assert.match(jpql('helper', []), /not a Spring Data derived query/);
  });

  test('helpers', () => {
    assert.strictEqual(decapitalize('URL'), 'URL');
    assert.strictEqual(decapitalize('Email'), 'email');
    assert.strictEqual(returnElementType('Page<List<Customer>>'), 'Customer');
    assert.strictEqual(returnElementType('java.util.Optional<Customer>'), 'Customer');
    assert.strictEqual(returnElementType('long'), 'long');
    assert.strictEqual(suggest('emial', ['email', 'status']), 'email');
    assert.strictEqual(suggest('zzz', ['email']), undefined);
  });
});

suite('JPQL: query builder', () => {
  test('builds queries and matching repository method signatures', () => {
    const order = model.entity('Order')!;
    const built = buildQuery(model, {
      entity: order, kind: 'list',
      conditions: [{ path: ['customer', 'email'], op: '=' }, { path: ['total'], op: '>=' }, { path: ['customer', 'id'], op: 'in' }],
      fetch: ['customer', 'lines'], orderBy: { path: ['createdAt'], direction: 'desc' },
    });
    assert.strictEqual(built.jpql, 'select distinct o from Order o left join fetch o.customer left join fetch o.lines '
      + 'where o.customer.email = :customerEmail and o.total >= :total and o.customer.id in :customerIds order by o.createdAt desc');
    assert.strictEqual(built.methodName, 'findWithCustomerAndLinesByCustomerEmailAndTotalGreaterThanEqualAndCustomerIdInOrderByCreatedAtDesc');
    assert.strictEqual(built.returnType, 'List<PurchaseOrder>');
    assert.deepStrictEqual(built.params.map(p => `${p.type} ${p.name}`), ['String customerEmail', 'BigDecimal total', 'Collection<Long> customerIds']);
    assert.deepStrictEqual(errors(built.jpql), []);

    const count = buildQuery(model, { entity: order, kind: 'count', conditions: [{ path: ['customer'], op: 'is not null' }], fetch: ['lines'] });
    assert.deepStrictEqual([count.jpql, count.methodName, count.returnType, count.params], ['select count(o) from Order o where o.customer is not null', 'countByCustomerIsNotNull', 'long', []]);
  });

  test('offers basic attributes and one level of to-one paths as conditions', () => {
    const paths = conditionPaths(model, model.entity('Order')!).map(p => p.path.join('.'));
    assert.ok(paths.includes('total') && paths.includes('customer.email') && paths.includes('customer.status'));
    assert.ok(!paths.includes('lines') && !paths.includes('customer'));
  });

  test('renders Java string literals', () => {
    assert.strictEqual(javaStringLiteral('select c from C c where c.n = "x\\y"'), '"select c from C c where c.n = \\"x\\\\y\\""');
  });
});
