import { DataSource } from '../db/DataSource';
import { QueryRunner } from "../db/QueryRunner";
import { DatabaseSchemaRetriever } from './DatabaseSchemaRetriever';
import { TableMetadata } from './model/TableMetadata';

export class PostgreSQLSchemaRetriever implements DatabaseSchemaRetriever {
    private queryRunner: QueryRunner;

    constructor(dataSource: DataSource) {
        this.queryRunner = dataSource.createQueryRunner();
    }

    async getTableNames(): Promise<string[]> {
        await this.queryRunner.connect(); 
        try {
            const query = `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`;
            const result = await this.queryRunner.query(query);
            const tableNames = result.map((row: any) => row['table_name']);
            return tableNames;
        } catch (err) {
            throw new Error(`Error retrieving tables: ${err}`);
        } finally {
            await this.queryRunner.release(); 
        }
    }

    async getTableMetadata(tableName: string): Promise<TableMetadata[]> {
        await this.queryRunner.connect(); 
        try {
            const query = `SELECT column_name, data_type, character_maximum_length, is_nullable, is_identity FROM information_schema.columns WHERE table_name = '${tableName}'`;
            const result = await this.queryRunner.query(query);
            const metadata = result.map((row: any) => ({
                columnName: row['column_name'],
                dataType: row['data_type'],
                length: row['character_maximum_length'],
                nullable: row['is_nullable'] === 'YES',
                primaryKey: row['is_identity'] === 'YES'
            }));
            return metadata;
        } catch (err) {
            throw new Error(`Error retrieving metadata: ${err}`);
        } finally {
            await this.queryRunner.release(); 
        }
    }
}
