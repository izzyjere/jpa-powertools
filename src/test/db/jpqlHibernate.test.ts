/**
 * Cross-checks the JPQL analyzer against Hibernate 6's own HQL translator, using the entity fixtures in
 * src/test/fixtures/spring-app. The analyzer must never flag a query Hibernate accepts, and must flag
 * the common mistakes listed in MUST_CATCH (which Hibernate rejects too).
 * Needs the jars from `npm run test:libs`; skipped otherwise. No database required.
 */
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EntityModel } from '../../jpql/entityModel';
import { deriveJpql } from '../../jpql/derivedQuery';
import { MethodSignature, parseJavaClasses } from '../../jpql/javaSource';
import { analyzeJpql } from '../../jpql/jpql';
import { buildQuery } from '../../jpql/queryBuilder';

const ROOT = path.resolve(__dirname, '../../..');
const LIBS = process.env.JPT_TEST_LIBS ? path.resolve(process.env.JPT_TEST_LIBS) : path.join(ROOT, 'test-db', 'lib');
const DOMAIN = path.join(ROOT, 'src/test/fixtures/spring-app/src/main/java/com/acme/shop/domain');

/** Valid JPQL/HQL: Hibernate accepts these, so the analyzer must not report errors. */
const VALID = [
  'select c from Customer c',
  'select c from Customer c where c.email = :email',
  'select c from Customer c where upper(c.email) like upper(:p) escape \'\\\'',
  'select c from Customer c where c.address.city = :city order by c.fullName asc, c.createdAt desc',
  'select distinct c from Customer c join c.orders o where o.status = com.acme.shop.domain.PurchaseOrder.OrderStatus.PAID',
  'select c from Customer c where c.status = com.acme.shop.domain.CustomerStatus.ACTIVE',
  'select o from Order o left join fetch o.items i where o.total >= ?1',
  'select count(o) from Order o where o.total >= ?1',
  'select o.customer.email, sum(o.total) from Order o group by o.customer.email having sum(o.total) > :min',
  'select c from Customer c where size(c.orders) > 2',
  'select c from Customer c where c.orders is empty',
  'select c from Customer c where c.orders is not empty and c.email is not null',
  'select p from Product p where :tag member of p.tags',
  'select p from Product p join p.tags t where t = :tag',
  'select c from Customer c where exists (select o from Order o where o.customer = c and o.total > 10)',
  'select c from Customer c where c.id in (select o.customer.id from Order o where o.status = :s)',
  'update Customer c set c.fullName = :name where c.id = :id',
  'delete from Order o where o.status = :s',
  'from Customer where email = :e',
  'from Customer c',
  'select c.email, extract(year from c.createdAt) from Customer c',
  "select trim(both ' ' from c.fullName) from Customer c",
  'select case when count(c) > 0 then true else false end from Customer c where c.email = :e',
  'select i from OrderItem i where i.order.customer.address.zipCode = :zip and i.quantity between 1 and 10',
  'select i.product.title, count(i) from OrderItem i group by i.product.title order by count(i) desc',
  'select c from Customer c where c.id = :id',
  'select o from Order o where o.placedAt > current_timestamp',
  'select c from Customer c left join c.orders o on o.total > 100 where o is null',
  'select coalesce(c.fullName, c.email) from Customer c',
  'select o from Order o join treat(o.customer as Customer) c where c.email = :e',
  'select c from Customer c where lower(c.email) = lower(:email) and c.version >= 0',
  'select c from Customer c order by c.createdAt desc nulls last',
  'select c from Customer c where c.email like concat(\'%\', :q, \'%\')',
  'select p from Product p where p.price between :min and :max',
  'select i from OrderItem i where i.order.status = :s order by i.order.placedAt',
  'select o from Order o where o.customer.address is not null',
];

/** Mistakes the analyzer must catch (Hibernate rejects all of them too). */
const MUST_CATCH = [
  'select c from Customer c where c.emial = :e',
  'select c from Customer c where c.address.town = :t',
  'select c from Customer c where c.email.domain = :d',
  'select x.email from Customer c',
  'select o from order o',
  'select c from Customer c where',
  'select c from Customer c order c.email',
  'select c from Customer c where c.email = \'oops',
  'select c from Customer c where (c.email = :e',
  'select o from Order o join o.itemz i',
  'select c from Customer c where c.displayLabel = :x',
  'select i from OrderItem i where i.product.name = :n',
  'select c from Customer c where c.orders.status = :s',
];

/** Spring Data derived query methods (name, domain type, parameter types, return type) whose JPQL conversion must be valid. */
const DERIVED: Array<[string, string, string[], string?]> = [
  ['findByEmail', 'Customer', ['String']],
  ['findByEmailIgnoreCase', 'Customer', ['String'], 'Optional<Customer>'],
  ['findByAddressCityAndStatusOrderByFullNameAsc', 'Customer', ['String', 'CustomerStatus']],
  ['findDistinctByOrdersStatus', 'Customer', ['OrderStatus']],
  ['findByFullNameStartingWithIgnoreCase', 'Customer', ['String']],
  ['findByFullNameContainingOrEmailEndingWith', 'Customer', ['String', 'String']],
  ['findByOrdersIsEmpty', 'Customer', []],
  ['findByCreatedAtBetween', 'Customer', ['Instant', 'Instant']],
  ['findByStatusIn', 'Customer', ['Collection<CustomerStatus>']],
  ['findByEmailIsNotNullAndStatusNot', 'Customer', ['CustomerStatus']],
  ['findByCustomerEmailOrderByPlacedAtDesc', 'PurchaseOrder', ['String']],
  ['findByCustomer_Address_ZipCode', 'PurchaseOrder', ['String']],
  ['findByItemsProductSku', 'PurchaseOrder', ['String']],
  ['findByTotalGreaterThanEqualOrderByTotalDescPlacedAt', 'PurchaseOrder', ['BigDecimal']],
  ['countByStatus', 'PurchaseOrder', ['OrderStatus'], 'long'],
  ['existsByCustomerEmail', 'PurchaseOrder', ['String'], 'boolean'],
  ['findByTagsContaining', 'Product', ['String']],
  ['findByTitleLikeAndPriceLessThan', 'Product', ['String', 'BigDecimal']],
];

function derivedJpql(model: EntityModel): string[] {
  return DERIVED.map(([name, domain, types, returnType]) => {
    const method: MethodSignature = {
      name, nameStart: 0, nameEnd: 0, returnType: returnType ?? `List<${domain}>`,
      params: types.map((type, i) => ({ name: `p${i}`, type, start: 0 })),
    };
    const r = deriveJpql(method, model.classes.find(c => c.name === domain)!, model);
    assert.ok(r.ok, `${name}: ${!r.ok && r.reason}`);
    return r.jpql;
  });
}

function builtJpql(model: EntityModel): string[] {
  const customer = model.entity('Customer')!;
  const order = model.entity('Order')!;
  return [
    buildQuery(model, { entity: customer, kind: 'list', conditions: [{ path: ['email'], op: '=' }, { path: ['address', 'city'], op: 'like' }], fetch: ['orders'], orderBy: { path: ['fullName'], direction: 'asc' } }).jpql,
    buildQuery(model, { entity: order, kind: 'one', conditions: [{ path: ['customer', 'email'], op: '=' }], fetch: ['customer', 'items'] }).jpql,
    buildQuery(model, { entity: order, kind: 'count', conditions: [{ path: ['status'], op: 'in' }, { path: ['placedAt'], op: 'is not null' }], fetch: [] }).jpql,
    buildQuery(model, { entity: customer, kind: 'exists', conditions: [{ path: ['email'], op: '=' }], fetch: [] }).jpql,
    buildQuery(model, { entity: order, kind: 'list', conditions: [{ path: ['total'], op: '>=' }], fetch: [], orderBy: { path: ['placedAt'], direction: 'desc' } }).jpql,
  ];
}

/** Spring-only SpEL placeholders are not HQL; replace them with plain parameters for Hibernate. */
function forHibernate(q: string): string {
  return q.replace(/ escape :#\{escapeCharacter\(\)\}/g, ' escape \'\\\'').replace(/:#\{[^}]*\}/g, ':spel');
}

suite('JPQL analyzer vs. Hibernate', function () {
  this.timeout(240_000);
  let hibernate: Array<{ valid: boolean; message?: string }>;
  let model: EntityModel;
  let generated: string[] = [];

  suiteSetup(function () {
    if (!fs.existsSync(path.join(LIBS, 'hibernate-core-6.5.3.Final.jar'))) {
      this.skip();
    }
    const files = fs.readdirSync(DOMAIN).map(f => path.join(DOMAIN, f));
    model = new EntityModel(files.map(f => ({ file: f, classes: parseJavaClasses(fs.readFileSync(f, 'utf8')) })));

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'jpt-jpql-'));
    const classes = path.join(work, 'classes');
    const cp = path.join(LIBS, '*');
    execFileSync(process.platform === 'win32' ? 'javac.exe' : 'javac', ['-proc:none', '-nowarn', '-d', classes, '-cp', cp, ...files], { stdio: 'pipe' });
    const queriesFile = path.join(work, 'queries.txt');
    generated = [...derivedJpql(model), ...builtJpql(model)];
    fs.writeFileSync(queriesFile, [...VALID, ...MUST_CATCH, ...generated.map(forHibernate)].join('\n----\n'));
    const out = execFileSync('java', ['-cp', `${cp}${path.delimiter}${classes}`, path.join(ROOT, 'test-db', 'JpqlCheck.java'),
      classes, 'com.acme.shop.domain', queriesFile], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 }).toString();
    hibernate = out.split(/\r?\n/).filter(l => /^(VALID|INVALID)/.test(l)).map(l => ({ valid: l === 'VALID', message: l.split('\t')[1] }));
    assert.strictEqual(hibernate.length, VALID.length + MUST_CATCH.length + generated.length, 'one Hibernate verdict per query');
  });

  test('derived-query conversions and built queries are valid JPQL', () => {
    generated.forEach((q, i) => {
      const verdict = hibernate[VALID.length + MUST_CATCH.length + i];
      assert.ok(verdict.valid, `Hibernate rejects generated query:\n${q}\n${verdict.message}`);
      assert.deepStrictEqual(analyzeJpql(q, model).diagnostics.filter(d => d.severity === 'error').map(d => d.message), [], q);
    });
  });

  VALID.forEach((q, i) => {
    test(`accepts: ${q}`, () => {
      assert.ok(hibernate[i].valid, `Hibernate rejects this "valid" query: ${hibernate[i].message}`);
      const errors = analyzeJpql(q, model).diagnostics.filter(d => d.severity === 'error');
      assert.deepStrictEqual(errors.map(e => e.message), [], 'false positive');
    });
  });

  MUST_CATCH.forEach((q, i) => {
    test(`rejects: ${q}`, () => {
      assert.ok(!hibernate[VALID.length + i].valid, 'Hibernate accepts this query, so it must not be in MUST_CATCH');
      const problems = analyzeJpql(q, model).diagnostics;
      assert.ok(problems.length > 0, 'the analyzer missed it');
    });
  });
});
