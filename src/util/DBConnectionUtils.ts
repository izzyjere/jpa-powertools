import * as https from 'https';
import * as fs from 'fs';
import * as vscode from 'vscode';

export function downloadJDBCDriver(dbType: string, destinationPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const driverUrls : { [key: string]: string } = {
            'mysql': '',
            'postgresql': '',
            'oracle': '',
	        'sqlserver': ''
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