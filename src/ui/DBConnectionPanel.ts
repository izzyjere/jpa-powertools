import * as vscode from "vscode";

export class DBConnectionPanel {
  public static createOrShow(extensionUri: vscode.Uri) {
    const column = vscode.ViewColumn.One;
    const panel = vscode.window.createWebviewPanel(
      "dbConnectionPanel",
      "Database Connection",
      column,
      {
        enableScripts: true,
      }
    );

    panel.webview.html = this.getWebviewContent();
  }

  private static getWebviewContent() {
    return `
            <html>
            <body>
                <h2>Connect to a Database</h2>
                <form id="dbForm">
                    <label for="dbType">Database Type:</label>
                    <select id="dbType">  
		       <option value="mysql">MySQL</option>
                        <option value="mysql">SQL Server</option>                      
                        <option value="postgresql">PostgreSQL</option>
                        <option value="oracle">Oracle</option>
                    </select><br><br>

                    <label for="dbUrl">Database URL:</label>
                    <input type="text" id="dbUrl" placeholder="jdbc:mysql://localhost:3306/mydb"><br><br>

                    <label for="username">Username:</label>
                    <input type="text" id="username"><br><br>

                    <label for="password">Password:</label>
                    <input type="password" id="password"><br><br>
                    <button type="submit">Connect</button>
                </form>

                <script>
                    const vscode = acquireVsCodeApi();
                    document.getElementById('dbForm').onsubmit = function(event) {
                        event.preventDefault();
                        const dbType = document.getElementById('dbType').value;
                        const dbUrl = document.getElementById('dbUrl').value;
                        const username = document.getElementById('username').value;
                        const password = document.getElementById('password').value;
                        
                        vscode.postMessage({
                            command: 'connectToDB',
                            dbType,
                            dbUrl,
                            username,
                            password
                        });
                    }
                </script>
            </body>
            </html>
        `;
  }
}
