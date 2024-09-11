import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export function downloadJDBCDriver(dbType: string, destinationPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const driverUrls : { [key: string]: string } = {
            'mysql': 'https://example.com/mysql-driver.jar',
            'postgresql': 'https://example.com/postgresql-driver.jar',
            'oracle': 'https://example.com/oracle-driver.jar',
	    'sqlserver': 'https://example.com/sqlserver-driver.jar'
        };

        const url : string = driverUrls[dbType];
        if (!url) {
            return reject(`No driver URL found for ${dbType}`);
        }

        const file = fs.createWriteStream(destinationPath);
        https.get(url, (response) => {
            response.pipe(file);
            file.on('finish', () => {
                file.close(() => {
                    vscode.window.showInformationMessage(`${dbType} JDBC driver downloaded successfully.`);
                    resolve();
                });
            });
        }).on('error', (err) => {
            fs.unlink(destinationPath, () => {});
            vscode.window.showErrorMessage(`Failed to download ${dbType} JDBC driver.`);
            reject(err);
        });
    });
}