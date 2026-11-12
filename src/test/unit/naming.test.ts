import * as assert from 'assert';
import {
  columnToFieldName, javaString, pluralize, safeIdentifier, singularize, splitWords, tableToClassName, toCamelCase,
  toPascalCase, uniqueName, validatePackageName,
} from '../../codegen/naming';

suite('naming', () => {
  test('splits snake, kebab, camel and upper-case names', () => {
    assert.deepStrictEqual(splitWords('order_line-item'), ['order', 'line', 'item']);
    assert.deepStrictEqual(splitWords('OrderLineItem'), ['order', 'line', 'item']);
    assert.deepStrictEqual(splitWords('HTTPRequestLog'), ['http', 'request', 'log']);
    assert.deepStrictEqual(splitWords('CUSTOMER_ID'), ['customer', 'id']);
    assert.deepStrictEqual(splitWords('Display Name'), ['display', 'name']);
  });

  test('converts case', () => {
    assert.strictEqual(toPascalCase('order_items'), 'OrderItems');
    assert.strictEqual(toCamelCase('FIRST_NAME'), 'firstName');
    assert.strictEqual(toCamelCase('x'), 'x');
  });

  test('singularizes table names', () => {
    const cases: Record<string, string> = {
      customers: 'customer', categories: 'category', addresses: 'address', boxes: 'box', matches: 'match',
      wishes: 'wish', statuses: 'status', status: 'status', people: 'person', children: 'child', data: 'data',
      movies: 'movie', houses: 'house', courses: 'course', photos: 'photo', analyses: 'analysis', news: 'news',
      buses: 'bus', keys: 'key', series: 'series', sizes: 'size', CUSTOMERS: 'CUSTOMER', CATEGORIES: 'CATEGORY',
    };
    for (const [plural, singular] of Object.entries(cases)) {
      assert.strictEqual(singularize(plural), singular, plural);
    }
  });

  test('pluralizes collection names', () => {
    const cases: Record<string, string> = {
      order: 'orders', category: 'categories', key: 'keys', box: 'boxes', match: 'matches', person: 'people',
      status: 'statuses', data: 'data', bus: 'buses',
    };
    for (const [singular, plural] of Object.entries(cases)) {
      assert.strictEqual(pluralize(singular), plural, singular);
    }
  });

  test('derives entity class names from tables', () => {
    assert.strictEqual(tableToClassName('order_items'), 'OrderItem');
    assert.strictEqual(tableToClassName('CUSTOMERS'), 'Customer');
    assert.strictEqual(tableToClassName('tbl_user_roles', ['tbl_']), 'UserRole');
    assert.strictEqual(tableToClassName('TBL_USERS', ['tbl_']), 'User');
    assert.strictEqual(tableToClassName('2fa_tokens'), 'T2faToken');
    assert.strictEqual(tableToClassName('___'), 'Entity');
    assert.strictEqual(tableToClassName('person_data'), 'PersonData');
  });

  test('makes safe Java identifiers', () => {
    assert.strictEqual(columnToFieldName('class'), 'clazz');
    assert.strictEqual(columnToFieldName('default'), 'defaultValue');
    assert.strictEqual(columnToFieldName('PACKAGE'), 'packageValue');
    assert.strictEqual(columnToFieldName('2nd_line'), '_2ndLine');
    assert.strictEqual(columnToFieldName('Display Name'), 'displayName');
    assert.strictEqual(safeIdentifier('$$$'), '$$$');
    assert.strictEqual(safeIdentifier('!!!'), 'field');
  });

  test('keeps generated names unique', () => {
    const taken = new Set(['name']);
    assert.strictEqual(uniqueName('name', taken), 'name2');
    assert.strictEqual(uniqueName('name', taken), 'name3');
    assert.strictEqual(uniqueName('other', taken), 'other');
  });

  test('validates package names', () => {
    assert.strictEqual(validatePackageName('com.acme.domain'), undefined);
    assert.strictEqual(validatePackageName(''), undefined);
    assert.ok(validatePackageName('com..acme'));
    assert.ok(validatePackageName('com.1acme'));
    assert.match(validatePackageName('com.acme.class')!, /reserved/);
    assert.ok(validatePackageName('com.acme.'));
  });

  test('escapes Java string literals', () => {
    assert.strictEqual(javaString('a"b\\c\nd'), '"a\\"b\\\\c\\nd"');
  });
});
