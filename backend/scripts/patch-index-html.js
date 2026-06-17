const fs = require('fs');
const path = require('path');

const indexPath = path.join(__dirname, '..', 'public', 'index.html');
let h = fs.readFileSync(indexPath, 'utf8');

h = h.replace(
    /<script crossorigin src="https:\/\/unpkg.com\/react@18\/umd\/react\.development\.js"><\/script>/,
    '<script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>'
);
h = h.replace(
    /<script crossorigin src="https:\/\/unpkg.com\/react-dom@18\/umd\/react-dom\.development\.js"><\/script>/,
    '<script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>'
);
h = h.replace(/\s*<script src="https:\/\/unpkg.com\/@babel\/standalone\/babel\.min\.js"><\/script>\s*/g, '\n');

if (!h.includes('app.bundle.js')) {
    h = h.replace(
        /<script type="text\/babel">[\s\S]*?<\/script>/,
        `<script src="app.bundle.js" defer></script>
    <script>
        window.addEventListener('error', function (e) {
            console.error('[Ateliê]', e.error || e.message);
        });
    </script>`
    );
}

fs.writeFileSync(indexPath, h, 'utf8');
console.log('[patch-index] index.html atualizado para app.bundle.js');
