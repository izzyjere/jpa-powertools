// Downloads the jars used by the database integration tests to compile generated code and
// validate it with Hibernate (hbm2ddl=validate). Usage: node scripts/fetch-test-libs.js [dir]
const path = require('path');
const { downloadArtifact } = require('../out/db/jdbc/runtime');

const dir = path.resolve(process.argv[2] || 'test-db/lib');
const a = (coords) => { const [group, artifact, version] = coords.split(':'); return { group, artifact, version }; };
const ARTIFACTS = [
  'jakarta.persistence:jakarta.persistence-api:3.1.0',
  'jakarta.transaction:jakarta.transaction-api:2.0.1',
  'jakarta.inject:jakarta.inject-api:2.0.1',
  'jakarta.xml.bind:jakarta.xml.bind-api:4.0.2',
  'jakarta.activation:jakarta.activation-api:2.1.3',
  'org.hibernate.orm:hibernate-core:6.5.3.Final',
  'org.hibernate.common:hibernate-commons-annotations:6.0.6.Final',
  'org.jboss.logging:jboss-logging:3.5.3.Final',
  'net.bytebuddy:byte-buddy:1.14.18',
  'io.smallrye:jandex:3.2.0',
  'com.fasterxml:classmate:1.7.0',
  'org.antlr:antlr4-runtime:4.13.0',
  'org.springframework.data:spring-data-jpa:3.3.4',
  'org.springframework.data:spring-data-commons:3.3.4',
  'org.projectlombok:lombok:1.18.34',
  'org.postgresql:postgresql:42.7.4',
  'com.mysql:mysql-connector-j:8.4.0',
  'org.mariadb.jdbc:mariadb-java-client:3.4.1',
  'com.microsoft.sqlserver:mssql-jdbc:12.8.1.jre11',
  'com.oracle.database.jdbc:ojdbc11:23.5.0.24.07',
  'com.ibm.db2:jcc:11.5.9.0',
  'org.xerial:sqlite-jdbc:3.46.1.3',
  'org.slf4j:slf4j-api:1.7.36',
].map(a);

(async () => {
  for (const art of ARTIFACTS) {
    const file = await downloadArtifact(art, dir);
    console.log('ok', path.basename(file));
  }
})().catch(e => { console.error(e.message); process.exit(1); });
