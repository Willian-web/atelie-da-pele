const fs = require('fs');
const path = require('path');
const babel = require('@babel/standalone');

const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const m = html.match(/<script type="text\/babel">([\s\S]*?)<\/script>/);
if (!m) {
    console.error('no babel script found');
    process.exit(1);
}
const code = m[1];
try {
    babel.transform(code, { presets: [['react', { runtime: 'classic' }]], filename: 'index.html' });
    console.log('Babel OK, lines:', code.split('\n').length);
} catch (e) {
    console.error('Babel ERROR:', e.message);
    if (e.loc) console.error('at line', e.loc.line, 'col', e.loc.column);
    if (e.codeFrame) console.error(e.codeFrame);
    process.exit(1);
}
