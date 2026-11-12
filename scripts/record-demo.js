#!/usr/bin/env node
/**
 * Records the product demo video (docs/media/demo.mp4 + docs/media/demo-poster.png).
 *
 * Prerequisites (Windows; uses ffmpeg's gdigrab screen capture):
 *   - ffmpeg on the PATH (winget install Gyan.FFmpeg)
 *   - the test databases: npm run test:dbs:up   (PostgreSQL is required; Oracle is expanded in the tree)
 *   - npm run compile
 * Usage: node scripts/record-demo.js
 * A VS Code window drives itself through the demo: keep it in front and don't touch mouse or keyboard.
 */
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE = path.join(ROOT, 'src', 'test', 'fixtures', 'spring-app');
const MEDIA = path.join(ROOT, 'docs', 'media');
const INTRO = 3.5;
const OUTRO = 4.5;

function reachable(port) {
  return new Promise(resolve => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(1500, () => { s.destroy(); resolve(false); });
  });
}

function copy(rel, toRoot) {
  const target = path.join(toRoot, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(FIXTURE, rel), target);
}

/** A fresh Spring Boot project without entities: the demo generates them from the database. */
function prepareWorkspace(dir) {
  const ws = path.join(dir, 'shop');
  for (const rel of ['pom.xml', 'src/main/java/com/acme/shop/ShopApplication.java', 'src/main/resources/application.properties']) {
    copy(rel, ws);
  }
  fs.mkdirSync(path.join(ws, 'src/main/java/com/acme/shop/repository'), { recursive: true });
  return ws;
}

function prepareUserData(dir) {
  const userData = path.join(dir, 'user-data');
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
    'window.title': 'JPA Power Tools Demo',
    'window.titleBarStyle': 'custom',
    'window.commandCenter': false,
    'workbench.colorTheme': 'Default Dark Modern',
    'workbench.startupEditor': 'none',
    'workbench.tips.enabled': false,
    'workbench.layoutControl.enabled': false,
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
    'chat.disableAIFeatures': true,
    'chat.commandCenter.enabled': false,
    'git.openRepositoryInParentFolders': 'never',
    'security.workspace.trust.enabled': false,
    'extensions.ignoreRecommendations': true,
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'editor.fontSize': 15,
    'editor.lineHeight': 23,
    'editor.minimap.enabled': false,
    'editor.stickyScroll.enabled': false,
    'editor.cursorBlinking': 'solid',
    'editor.hover.delay': 200,
    'editor.inlineSuggest.enabled': false,
    'editor.wordBasedSuggestions': 'off',
    'editor.quickSuggestions': { other: 'off', comments: 'off', strings: 'off' },
    'editor.parameterHints.enabled': false,
    'breadcrumbs.enabled': false,
  }, null, 2));
  return userData;
}

function probe(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file]).toString();
  const j = JSON.parse(out);
  return { width: j.streams[0].width, height: j.streams[0].height, duration: Number(j.format.duration) };
}

/** Escapes text for an ffmpeg filter argument written inside single quotes. */
const q = s => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "'\\''").replace(/:/g, '\\:').replace(/%/g, '\\%')}'`;

function compose(work, captions) {
  const raw = path.join(work, 'raw.mp4');
  const { width, height, duration } = probe(raw);
  const W = 1920;
  const H = Math.round((W * height) / width / 2) * 2;
  const k = W / 1920;

  // Fonts and caption texts live next to the filter so no Windows paths need escaping.
  fs.copyFileSync('C:/Windows/Fonts/segoeuib.ttf', path.join(work, 'bold.ttf'));
  fs.copyFileSync('C:/Windows/Fonts/segoeui.ttf', path.join(work, 'regular.ttf'));
  fs.copyFileSync(path.join(ROOT, 'media', 'icon.png'), path.join(work, 'icon.png'));

  const fade = (s, e) => `if(lt(t,${s}+0.3),(t-${s})/0.3,if(gt(t,${e}-0.3),(${e}-t)/0.3,1))`;
  const captionFilters = captions.filter(c => c.end > c.start).map((c, i) => {
    fs.writeFileSync(path.join(work, `caption${i}.txt`), c.text);
    const s = c.start.toFixed(2);
    const e = Math.min(c.end, duration).toFixed(2);
    return `drawtext=fontfile=bold.ttf:textfile=caption${i}.txt:fontcolor=white:fontsize=${Math.round(38 * k)}`
      + `:box=1:boxcolor=0x0b1220@0.82:boxborderw=${Math.round(22 * k)}:x=(w-text_w)/2:y=h-text_h-${Math.round(64 * k)}`
      + `:enable='between(t,${s},${e})':alpha='${fade(s, e)}'`;
  });

  const card = (label, d, lines) => [
    `color=c=0x0b1220:s=${W}x${H}:d=${d}:r=30[${label}bg]`,
    `[${label}logo]scale=${Math.round(170 * k)}:-1[${label}icon]`,
    `[${label}bg][${label}icon]overlay=x=(W-w)/2:y=H/2-h-${Math.round(70 * k)}:shortest=1[${label}a]`,
    `[${label}a]${lines.map(l => `drawtext=fontfile=${l.bold ? 'bold' : 'regular'}.ttf:text=${q(l.text)}:fontcolor=${l.color ?? 'white'}:fontsize=${Math.round(l.size * k)}:x=(w-text_w)/2:y=h/2+${Math.round(l.y * k)}`).join(',')},`
      + `fade=t=in:st=0:d=0.5,fade=t=out:st=${d - 0.5}:d=0.5,format=yuv420p,setsar=1[${label}]`,
  ];

  const filter = [
    '[1:v]split=2[intrologo][outrologo]',
    ...card('intro', INTRO, [
      { text: 'JPA Power Tools', size: 80, y: 0, bold: true },
      { text: 'Databases, JPA entities and JPQL — right in VS Code', size: 38, y: 110, color: '0xc7d2fe' },
    ]),
    `[0:v]scale=${W}:${H}:flags=lanczos,${captionFilters.length ? `${captionFilters.join(',')},` : ''}fade=t=in:st=0:d=0.4,fade=t=out:st=${(duration - 0.4).toFixed(2)}:d=0.4,format=yuv420p,setsar=1[main]`,
    ...card('outro', OUTRO, [
      { text: 'PostgreSQL · MySQL · MariaDB · SQL Server · Oracle · Db2 · any JDBC database', size: 34, y: 0, bold: true },
      { text: 'github.com/izzyjere/jpa-powertools', size: 38, y: 80, color: '0x93c5fd' },
    ]),
    '[intro][main][outro]concat=n=3:v=1:a=0[out]',
  ].join(';');

  fs.mkdirSync(MEDIA, { recursive: true });
  const video = path.join(MEDIA, 'demo.mp4');
  const r = spawnSync('ffmpeg', ['-y', '-i', 'raw.mp4', '-loop', '1', '-t', String(Math.max(INTRO, OUTRO)), '-i', 'icon.png', '-filter_complex', filter, '-map', '[out]',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', video],
  { cwd: work, stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) {
    throw new Error('ffmpeg composition failed');
  }

  // Poster: the generator preview, a few seconds into its caption.
  const posterCaption = captions.find(c => /live preview/.test(c.text)) ?? captions[0];
  const at = INTRO + (posterCaption ? posterCaption.start + 4 : 10);
  execFileSync('ffmpeg', ['-y', '-ss', at.toFixed(2), '-i', video, '-frames:v', '1', '-vf', 'scale=1280:-2', path.join(MEDIA, 'demo-poster.png')], { stdio: 'ignore' });
  const final = probe(video);
  console.log(`\nWrote ${path.relative(ROOT, video)} (${final.width}x${final.height}, ${final.duration.toFixed(1)}s, ${(fs.statSync(video).size / 1e6).toFixed(1)} MB) and docs/media/demo-poster.png`);
}

(async () => {
  if (process.platform !== 'win32') {
    throw new Error('Recording uses ffmpeg gdigrab and runs on Windows only.');
  }
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch {
    throw new Error('ffmpeg was not found on the PATH (winget install Gyan.FFmpeg).');
  }
  if (!(await reachable(55432))) {
    throw new Error('PostgreSQL is not running on port 55432. Start the test databases: npm run test:dbs:up');
  }
  // Inside the repo (git-ignored) so paths shown in the video do not include the user's profile folder.
  const work = path.join(ROOT, '.demo');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const env = {
    ...process.env,
    JPT_DEMO_WORKSPACE: prepareWorkspace(work),
    JPT_DEMO_USER_DATA: prepareUserData(work),
    JPT_DEMO_OUT: work,
  };
  console.log(`Recording in ${work}. Keep the VS Code window in front and don't touch mouse or keyboard…`);
  const run = spawnSync('npx', ['vscode-test', '--label', 'demo'], { cwd: ROOT, env, stdio: 'inherit', shell: true });
  if (run.status !== 0) {
    throw new Error('The demo run failed');
  }
  compose(work, JSON.parse(fs.readFileSync(path.join(work, 'captions.json'), 'utf8')));
})().catch(e => {
  console.error(e.message);
  process.exit(1);
});
