import { DatabaseSchemaRetriever } from "./DatabaseSchemaRetriever";
import { TableMetadata } from "./model/TableMetadata";

export class MySQLSchemaRetriever implements DatabaseSchemaRetriever {
  getTableNames(): Promise<string[]> {
    throw new Error("Method not implemented.");
  }
  getTableMetadata(tableName: string): Promise<TableMetadata[]> {
    throw new Error("Method not implemented.");
  }
}
