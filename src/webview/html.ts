import { randomBytes } from 'crypto';
import * as vscode from 'vscode';

export function nonce(): string {
  return randomBytes(16).toString('base64').replace(/[^A-Za-z0-9]/g, '');
}

/** Builds a webview document that loads `media/<script>.js` and the shared stylesheet under a strict CSP. */
export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, title: string, script: string): string {
  const n = nonce();
  const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', f));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media('webview.css')}">
<title>${title}</title>
</head>
<body>
<div id="app" aria-busy="true"><div class="loading"><span class="spinner"></span> Loading…</div></div>
<script nonce="${n}" src="${media('dom.js')}"></script>
<script nonce="${n}" src="${media(script)}"></script>
</body>
</html>`;
}
