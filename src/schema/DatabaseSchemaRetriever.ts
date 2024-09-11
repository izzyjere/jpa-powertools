import { TableMetadata } from "./model/TableMetadata";

export interface DatabaseSchemaRetriever {
  getTableNames(): Promise<string[]>;
  getTableMetadata(tableName: string): Promise<TableMetadata[]>;
}
