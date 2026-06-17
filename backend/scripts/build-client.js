/**
 * Pré-compila o app React/JSX para app.bundle.js (sem Babel no navegador).
 * Rode: node scripts/build-client.js
 */
const fs = require('fs');
const path = require('path');
const babel = require('@babel/standalone');

const publicDir = path.join(__dirname, '..', 'public');
const entryPath = path.join(publicDir, 'app.entry.jsx');
const bundlePath = path.join(publicDir, 'app.bundle.js');
const indexPath = path.join(publicDir, 'index.html');

function extractBabelFromIndex(html) {
    const m = html.match(/<script type="text\/babel">([\s\S]*?)<\/script>/);
    if (!m) return null;
    return m[1].trim();
}

let source = fs.existsSync(entryPath) ? fs.readFileSync(entryPath, 'utf8') : null;

if (!source) {
    const html = fs.readFileSync(indexPath, 'utf8');
    source = extractBabelFromIndex(html);
    if (!source) {
        console.error('[build-client] Nenhum bloco text/babel em index.html nem app.entry.jsx.');
        process.exit(1);
    }
    fs.writeFileSync(entryPath, source, 'utf8');
    console.log('[build-client] Extraído app.entry.jsx a partir de index.html');
}

try {
    const result = babel.transform(source, {
        presets: [['react', { runtime: 'classic' }]],
        filename: 'app.entry.jsx',
        minified: false,
        comments: false
    });
    const banner = `/* Gerado por scripts/build-client.js — não editar. Fonte: public/app.entry.jsx */\n`;
    fs.writeFileSync(bundlePath, banner + result.code, 'utf8');
    console.log(`[build-client] OK → ${bundlePath} (${Math.round(result.code.length / 1024)} KB)`);
} catch (e) {
    console.error('[build-client] Erro Babel:', e.message);
    if (e.loc) console.error('  linha', e.loc.line, 'col', e.loc.column);
    process.exit(1);
}
