/**
 * Coverage for: POST /start hanging instead of erroring when a required
 * Wrangler env var (e.g. BLOCKFROST_API_KEY) is unset.
 *
 * `new Wrangler(...)` was the handler's first statement, ahead of the utxos
 * guards and outside any try/catch. Its constructor throws synchronously when
 * a required env var is missing; inside an async handler that becomes a
 * rejected promise, and Express 4 does not turn an async handler's rejection
 * into a response, so the request hung until the client timed out.
 *
 * Structural guards over lifecycle.ts (the existing pattern for this file),
 * since exercising the live route needs the full Hydra/Express stack.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const src = strip(readFileSync(resolve(here, '../src/routes/lifecycle.ts'), 'utf-8'));
const startHandler = src.slice(src.indexOf("router.post('/start'"));

describe('POST /start does not hang when Wrangler construction fails', () => {
    it("constructs Wrangler after the utxos guards, not as the handler's first statement", () => {
        const wranglerIdx = startHandler.indexOf('new Wrangler(');
        const missingFieldsIdx = startHandler.indexOf("'MISSING_FIELDS'");
        const invalidInputIdx = startHandler.indexOf("'INVALID_INPUT'");
        expect(wranglerIdx).toBeGreaterThan(-1);
        expect(missingFieldsIdx).toBeGreaterThan(-1);
        expect(invalidInputIdx).toBeGreaterThan(-1);
        expect(wranglerIdx).toBeGreaterThan(missingFieldsIdx);
        expect(wranglerIdx).toBeGreaterThan(invalidInputIdx);
    });

    it('wraps the Wrangler construction in its own try/catch, not left to escape uncaught', () => {
        expect(startHandler).toMatch(/try\s*{\s*\n\s*wrangler = new Wrangler\(/);
    });

    it('reports a named 5xx on failure instead of leaving the request unanswered', () => {
        expect(startHandler).toMatch(/return error\(res, 'CLIENT_INIT_FAILED', err\?\.message \|\| .*, 503\)/);
    });
});
