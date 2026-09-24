/**
 * Regression coverage for js/tainted-format-string alert #5.
 *
 * `GET /audit/vote/:voterId` (src/routes/audit.ts) built the first argument
 * to `console.warn` by interpolating `req.params.voterId` directly into a
 * template literal, then passed `err.message` as a second argument. Node's
 * console methods run that first argument through `util.format` whenever
 * more than one argument is given, so any `%`-directive an attacker placed
 * in `voterId` (`%s`, `%d`, `%j`, ...) was interpreted as a format
 * specifier rather than printed literally — consuming `err.message` into
 * the directive's position and garbling or dropping it from the log line
 * (CWE-134).
 *
 * The fix keeps the format string a static literal with a `%s` placeholder
 * and passes the untrusted value as a trailing argument, so `util.format`
 * only ever substitutes it, never parses it. The same pattern — a template
 * literal embedding a variable as the first argument to a `console.*` call
 * that also receives trailing arguments — existed in a few other places
 * that log data ultimately sourced from a voter-supplied credential; those
 * are fixed the same way and pinned below.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import util from 'node:util';
import { describe, it, expect } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const AUDIT = stripComments(readFileSync(resolve(here, '../src/routes/audit.ts'), 'utf-8'));
const SETTLEMENT = stripComments(readFileSync(resolve(here, '../src/routes/settlement.ts'), 'utf-8'));
const QUEUE_WORKER = stripComments(readFileSync(resolve(here, '../src/queue-worker.ts'), 'utf-8'));

describe('js/tainted-format-string #5 — util.format behavior', () => {
    const maliciousVoterIds = ['drep1%s%s', 'drep1%d', 'drep1%j', 'drep1%%'];

    it('the vulnerable pattern lets a %-directive in the interpolated value consume the trailing argument', () => {
        for (const voterId of maliciousVoterIds) {
            const errMessage = 'IPFS timeout after 5000ms';
            // The exact shape the sink had before the fix: the untrusted
            // value is baked into the format-string argument itself.
            const vulnerable = util.format(`Could not fetch evidence from IPFS for ${voterId}:`, errMessage);
            // The trailing argument (the real error message) never appears
            // intact and in place — it gets consumed or reformatted by the
            // directive hiding inside voterId.
            expect(vulnerable).not.toContain(`for ${voterId}: ${errMessage}`);
        }
    });

    it('the fixed pattern prints the untrusted value literally and preserves the trailing argument', () => {
        for (const voterId of maliciousVoterIds) {
            const errMessage = 'IPFS timeout after 5000ms';
            // The shape every sink now uses: a static format string with a
            // %s placeholder, untrusted data passed as an argument.
            const fixed = util.format('Could not fetch evidence from IPFS for %s:', voterId, errMessage);
            expect(fixed).toBe(`Could not fetch evidence from IPFS for ${voterId}: ${errMessage}`);
        }
    });
});

describe('js/tainted-format-string #5 — fixed sink source shape', () => {
    it('audit.ts GET /audit/vote/:voterId uses a %s placeholder, not string interpolation, in the console.warn format string', () => {
        expect(AUDIT).toMatch(/console\.warn\('Could not fetch evidence from IPFS for %s:', voterId, err\.message\)/);
        expect(AUDIT).not.toMatch(/console\.warn\(`[^`]*\$\{voterId\}/);
    });

    it('settlement.ts POST /count uses a %s placeholder for the voter ID in its console.error format string', () => {
        expect(SETTLEMENT).toMatch(/console\.error\('\[count] FULL ERROR for %s:', allVotes\[i]\.voterId, reason\)/);
    });

    it('settlement.ts POST /settle/burn and /settle use a %s placeholder for the token name in their console.error format strings', () => {
        const matches = SETTLEMENT.match(/console\.error\('\[settle\/burn] FULL ERROR for %s:', headVoters\[i]\.tokenName,/g) ?? [];
        expect(matches).toHaveLength(2);
    });

    it('neither settlement.ts console.error call still interpolates the voter identifier into the format string', () => {
        expect(SETTLEMENT).not.toMatch(/console\.error\(`[^`]*FULL ERROR for \$\{/);
    });

    it('queue-worker.ts submitEntry uses a %s placeholder for the queue entry id in its console.error format string', () => {
        expect(QUEUE_WORKER).toMatch(/console\.error\('\[queue-worker] Submit failed for %s:', entry\.id, err\.message\)/);
        expect(QUEUE_WORKER).not.toMatch(/console\.error\(`[^`]*\$\{entry\.id}/);
    });
});
