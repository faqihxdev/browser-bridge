import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const extensionOrigin = readFile(
  new URL('../extension/manifest.json', import.meta.url),
  'utf8',
).then((source) => {
  const digest = createHash('sha256')
    .update(Buffer.from(JSON.parse(source).key, 'base64'))
    .digest('hex')
    .slice(0, 32);
  const id = [...digest]
    .map((character) => String.fromCharCode(97 + parseInt(character, 16)))
    .join('');
  return `chrome-extension://${id}/`;
});
