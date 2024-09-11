import * as path from 'path';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as dbUtils from '../util/DBConnectionUtils';

vscode.window.registerWebviewPanelSerializer('dbConnectionPanel', {
    async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel) {
        webviewPanel.webview.onDidReceiveMessage(async message => {
            if (message.command === 'connectToDB') {
                const { dbType, dbUrl, username, password } = message;             
                
                await checkAndDownloadDriver(dbType);
                connectToDatabase(dbType, dbUrl, username, password);
            }
        });
    }
});

async function checkAndDownloadDriver(dbType: string) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length > 0) {	
	vscode.window.showErrorMessage('No workspace folder found.');
	return;
    }
    const rootDir = workspaceFolders[0].uri.fsPath;	
    const driverPath = path.join(rootDir, 'lib', `${dbType}-jdbc-driver.jar`);    
    if (!fs.existsSync(driverPath)) {
        vscode.window.showInformationMessage(`Downloading ${dbType} connection driver...`);        
        await dbUtils.downloadJDBCDriver(dbType, driverPath);
    }
}

async function connectToDatabase(dbType: string, dbUrl: string, username: string, password: string) {
    vscode.window.showInformationMessage(`Connecting to ${dbType} at ${dbUrl}...`);
    //Establish a connection and pass Datasource object to DI Container
    
}
