import * as path from 'path';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as dbUtils from '../util/DBConnectionUtils';

vscode.window.registerWebviewPanelSerializer('dbConnectionPanel', {
    async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel) {
        webviewPanel.webview.onDidReceiveMessage(async message => {
            if (message.command === 'connectToDB') {
                const { dbType, dbUrl, username, password } = message;                
                // Check if the necessary JDBC driver exists
                await checkAndDownloadJDBCDriver(dbType);                
                // Call a function to handle the connection
                connectToDatabase(dbType, dbUrl, username, password);
            }
        });
    }
});

async function checkAndDownloadJDBCDriver(dbType: string) {
    // Logic to check if the JDBC driver is present
    // If not, download the necessary driver and install it
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length > 0) {	
	vscode.window.showErrorMessage('No workspace folder found.');
	return;
    }
    const rootDir = workspaceFolders[0].uri.fsPath;	
    const driverPath = path.join(rootDir, 'lib', `${dbType}-jdbc-driver.jar`);    
    if (!fs.existsSync(driverPath)) {
        vscode.window.showInformationMessage(`Downloading ${dbType} JDBC driver...`);        
        await dbUtils.downloadJDBCDriver(dbType, driverPath);
    }
}

async function connectToDatabase(dbType: string, dbUrl: string, username: string, password: string) {
    // Call Node.js backend or use a library like node-jdbc to establish the connection
    vscode.window.showInformationMessage(`Connecting to ${dbType} at ${dbUrl}...`);
    
    
}
