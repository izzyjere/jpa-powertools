import * as assert from 'assert';
import { analyzeBuildFile, commonPackage, packageOf, springBootVersion, suggestPackages, usesPersistenceApi } from '../../project/projectInfo';
import { extractDatasource, flattenYaml, parseProperties, resolvePlaceholders } from '../../project/springConfig';

suite('project detection', () => {
  test('reads Spring Boot versions from Maven and Gradle', () => {
    assert.strictEqual(springBootVersion('<parent><artifactId>spring-boot-starter-parent</artifactId>\n<version>3.2.1</version></parent>'), 3);
    assert.strictEqual(springBootVersion(`plugins { id 'org.springframework.boot' version '2.7.18' }`), 2);
    assert.strictEqual(springBootVersion('plugins { id("org.springframework.boot") version "3.3.0" }'), 3);
    assert.strictEqual(springBootVersion('classpath("org.springframework.boot:spring-boot-gradle-plugin:2.5.0")'), 2);
    assert.strictEqual(springBootVersion('<artifactId>junit</artifactId>'), undefined);
  });

  test('infers persistence API, Lombok and Spring Data from build files', () => {
    assert.deepStrictEqual(analyzeBuildFile(`<artifactId>spring-boot-starter-parent</artifactId><version>3.1.0</version>
      <artifactId>spring-boot-starter-data-jpa</artifactId><artifactId>lombok</artifactId>`), { persistenceApi: 'jakarta', lombok: true, springDataJpa: true });
    assert.deepStrictEqual(analyzeBuildFile(`id 'org.springframework.boot' version '2.7.0'`), { persistenceApi: 'javax', lombok: false, springDataJpa: false });
    assert.strictEqual(analyzeBuildFile(`implementation 'javax.persistence:javax.persistence-api:2.2'`).persistenceApi, 'javax');
    assert.strictEqual(analyzeBuildFile(`implementation 'org.hibernate.orm:hibernate-core:6.4.0'`).persistenceApi, 'jakarta');
    assert.strictEqual(analyzeBuildFile('').persistenceApi, undefined);
  });

  test('reads packages and persistence imports from sources', () => {
    assert.strictEqual(packageOf('/* header */\n// package fake;\npackage com.acme.app;\n'), 'com.acme.app');
    assert.strictEqual(packageOf('class X {}'), undefined);
    assert.strictEqual(usesPersistenceApi('import jakarta.persistence.Entity;'), 'jakarta');
    assert.strictEqual(usesPersistenceApi('import javax.persistence.*;'), 'javax');
  });

  test('suggests entity and repository packages, preferring existing ones', () => {
    assert.deepStrictEqual(suggestPackages('com.acme', ['com.acme', 'com.acme.web']), { entityPackage: 'com.acme.entity', repositoryPackage: 'com.acme.repository' });
    assert.deepStrictEqual(suggestPackages('com.acme', ['com.acme.domain', 'com.acme.repositories']), { entityPackage: 'com.acme.domain', repositoryPackage: 'com.acme.repositories' });
    assert.deepStrictEqual(suggestPackages('', []), { entityPackage: 'entity', repositoryPackage: 'repository' });
  });

  test('computes common packages', () => {
    assert.strictEqual(commonPackage(['com.acme.a', 'com.acme.b.c']), 'com.acme');
    assert.strictEqual(commonPackage(['com.acme']), 'com.acme');
    assert.strictEqual(commonPackage(['org.x', 'com.y']), '');
    assert.strictEqual(commonPackage([]), '');
  });
});

suite('Spring configuration', () => {
  test('parses .properties files', () => {
    const p = parseProperties('# comment\na=1\nb : two\nc three\nd=multi \\\n  line\ne=caf\\u00e9\n! also comment');
    assert.deepStrictEqual(Object.fromEntries(p), { a: '1', b: 'two', c: 'three', d: 'multi line', e: 'café' });
  });

  test('flattens YAML with multiple documents', () => {
    const y = flattenYaml('spring:\n  datasource:\n    url: jdbc:mysql://h/db\n    username: root\n---\nspring:\n  datasource:\n    username: app\n');
    assert.strictEqual(y.get('spring.datasource.url'), 'jdbc:mysql://h/db');
    assert.strictEqual(y.get('spring.datasource.username'), 'app');
  });

  test('resolves placeholders to their defaults', () => {
    assert.strictEqual(resolvePlaceholders('${DB_URL:jdbc:postgresql://localhost/db}'), 'jdbc:postgresql://localhost/db');
    assert.strictEqual(resolvePlaceholders('${A:${B:inner}}'), 'inner');
    assert.strictEqual(resolvePlaceholders('${NOPE}'), '');
    assert.strictEqual(resolvePlaceholders('plain'), 'plain');
  });

  test('extracts datasources from properties and YAML (relaxed binding, profiles)', () => {
    const ds = extractDatasource('src/main/resources/application-dev.properties',
      'spring.datasource.url=${DB_URL:jdbc:postgresql://localhost:55432/shop}\nspring.datasource.username=postgres\nspring.datasource.password=${DB_PASSWORD:secret}')!;
    assert.deepStrictEqual([ds.kind, ds.port, ds.database, ds.user, ds.password, ds.profile], ['postgresql', 55432, 'shop', 'postgres', 'secret', 'dev']);

    const y = extractDatasource('application.yml', 'spring:\n  datasource:\n    hikari:\n      jdbc-url: jdbc:sqlserver://sql:1433;databaseName=app\n      username: sa\n')!;
    assert.deepStrictEqual([y.kind, y.host, y.database, y.user, y.profile], ['sqlserver', 'sql', 'app', 'sa', '']);

    const env = extractDatasource('application.properties', 'SPRING_DATASOURCE_URL=jdbc:oracle:thin:@//o:1521/XEPDB1')!;
    assert.strictEqual(env.kind, 'oracle');

    assert.strictEqual(extractDatasource('application.properties', 'server.port=8080'), undefined);
    assert.strictEqual(extractDatasource('application.yml', ': : not yaml ['), undefined);
  });
});
