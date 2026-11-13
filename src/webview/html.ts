import { randomBytes } from 'crypto';
import * as vscode from 'vscode';

export function nonce(): string {
  return randomBytes(16).toString('base64').replace(/[^A-Za-z0-9]/g, '');
}

/**
 * Builds a webview document that loads `media/<script>.js` (after `dom.js` and any `extraScripts`)
 * and the shared stylesheet under a strict CSP.
 */
export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, title: string, script: string, extraScripts: string[] = []): string {
  const n = nonce();
  const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', f));
  const scripts = ['dom.js', ...extraScripts, script].map(s => `<script nonce="${n}" src="${media(s)}"></script>`).join('\n');
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
${scripts}
</body>
</html>`;
}
