/**
 * libsodium-wrappers' ESM dist is broken under Node's ESM resolver (its
 * modules-esm build points at a file the package doesn't ship). Load the CJS
 * build via createRequire and re-export; the only sodium import in the tree.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sodium = require('libsodium-wrappers') as typeof import('libsodium-wrappers');

export default sodium;
