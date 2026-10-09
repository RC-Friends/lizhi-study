import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || 'dist');
const assets = path.join(root, 'assets');
const styles = fs.readdirSync(assets).filter(file => file.endsWith('.css'));
assert.ok(styles.length, 'Build the frontend before checking its assets.');
const fonts = new Set();
for (const name of styles) {
  const filename = path.join(assets, name), css = fs.readFileSync(filename, 'utf8');
  for (const [, declaration] of css.matchAll(/@font-face\s*\{([^}]+)\}/gi)) {
    for (const [, source] of declaration.matchAll(/url\(["']?([^\s"')]+)["']?\)/gi)) {
      assert.ok(!/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(source), `Font in ${name} must use a same-origin file, not an inline or remote URL.`);
      const filename = source.startsWith('/') ? path.resolve(root, '.' + source) : path.resolve(assets, source);
      assert.ok(filename.startsWith(root + path.sep), 'Font path must stay inside the built frontend.');
      assert.ok(fs.statSync(filename).isFile(), `Missing emitted font: ${path.basename(filename)}`);
      fonts.add(filename);
    }
  }
}
assert.ok(fonts.size, 'No emitted fonts were checked.');
assert.ok([...fonts].some(file => /KaTeX_Size3-Regular.*\.woff2$/.test(file)), 'The small KaTeX Size3 WOFF2 font must be emitted too.');
console.log(`Frontend assets passed: ${fonts.size} same-origin font files, compatible with font-src 'self'.`);
