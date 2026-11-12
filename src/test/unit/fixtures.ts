import { ColumnInfo, ForeignKeyInfo, KeyInfo, TableInfo } from '../../model/types';

/** Builds a column with sensible defaults. */
export function col(name: string, dataType: string, extra: Partial<ColumnInfo> = {}): ColumnInfo {
  return {
    name, dataType, displayType: dataType, length: null, precision: null, scale: null, nullable: true,
    autoIncrement: false, unsigned: false, defaultValue: null, comment: null, ...extra,
  };
}

export function table(
  name: string,
  columns: ColumnInfo[],
  opts: { schema?: string; pk?: string[]; fks?: Array<Partial<ForeignKeyInfo> & { columns: string[]; referencedTable: string }>; uniques?: KeyInfo[]; kind?: 'table' | 'view'; comment?: string } = {},
): TableInfo {
  const schema = opts.schema ?? 'public';
  return {
    schema,
    name,
    kind: opts.kind ?? 'table',
    comment: opts.comment ?? null,
    columns,
    primaryKey: opts.pk ?? [],
    foreignKeys: (opts.fks ?? []).map((fk, i) => ({
      name: fk.name ?? `fk_${name}_${i}`,
      columns: fk.columns,
      referencedSchema: fk.referencedSchema ?? schema,
      referencedTable: fk.referencedTable,
      referencedColumns: fk.referencedColumns ?? ['id'],
    })),
    uniqueKeys: opts.uniques ?? [],
  };
}

/** A small shop schema exercising the interesting mapping cases. */
export function shopSchema(): TableInfo[] {
  return [
    table('customers', [
      col('id', 'int8', { nullable: false, autoIncrement: true }),
      col('email', 'varchar', { nullable: false, length: 255, comment: 'Login e-mail' }),
      col('version', 'int4', { nullable: false }),
    ], { pk: ['id'], uniques: [{ name: 'uk_email', columns: ['email'] }], comment: 'People who buy things' }),
    table('orders', [
      col('id', 'int8', { nullable: false, autoIncrement: true }),
      col('customer_id', 'int8', { nullable: false }),
      col('shipped_to_id', 'int8'),
      col('total', 'numeric', { precision: 12, scale: 2 }),
    ], {
      pk: ['id'],
      fks: [{ columns: ['customer_id'], referencedTable: 'customers' }, { columns: ['shipped_to_id'], referencedTable: 'customers' }],
    }),
    table('order_items', [
      col('order_id', 'int8', { nullable: false }),
      col('line_no', 'int4', { nullable: false }),
      col('quantity', 'int4', { nullable: false }),
    ], { pk: ['order_id', 'line_no'], fks: [{ columns: ['order_id'], referencedTable: 'orders' }] }),
    table('customer_profiles', [
      col('id', 'int4', { nullable: false, autoIncrement: true }),
      col('customer_id', 'int8', { nullable: false }),
      col('preferences', 'jsonb'),
    ], { pk: ['id'], uniques: [{ name: 'uk_cust', columns: ['customer_id'] }], fks: [{ columns: ['customer_id'], referencedTable: 'customers' }] }),
    table('categories', [
      col('id', 'int4', { nullable: false, autoIncrement: true }),
      col('parent_id', 'int4'),
    ], { pk: ['id'], fks: [{ columns: ['parent_id'], referencedTable: 'categories' }] }),
  ];
}
