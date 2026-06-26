import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

// Structural guards for the Hydra v2 (ADR-33) async-deposit redesign. These
// lock in the invariants that make the deposit-readiness contract safe — a
// regression here (e.g. voting before the (601) deposit finalizes, or /start
// silently blocking again) would be a correctness bug, not just a style nit.
// Source-string assertions match the style of start-reject-open-reseed.test.ts.

const here = dirname(fileURLToPath(import.meta.url));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const lifecycle = strip(readFileSync(resolve(here, '../src/routes/lifecycle.ts'), 'utf-8'));
const voting = strip(readFileSync(resolve(here, '../src/routes/voting.ts'), 'utf-8'));
const startHandler = lifecycle.slice(lifecycle.indexOf("router.post('/start'"));

describe('Hydra v2 async /start', () => {
    it('opens the head with the no-arg waitForHeadOpen(timeout) (v2 signature)', () => {
        // Must NOT pass commit args ({ utxos }) — that was the v1 signature.
        expect(startHandler).toMatch(/waitForHeadOpen\(\s*HEAD_OPEN_TIMEOUT_MS\s*\)/);
        expect(startHandler).not.toMatch(/waitForHeadOpen\(\s*\{/);
    });

    it('marks the deposit PENDING and returns 202 without awaiting finalization', () => {
        expect(startHandler).toMatch(/cachedDepositStatus = 'PENDING'/);
        // 202 success return.
        expect(startHandler).toMatch(/\}, 202\)/);
        // The deposit runs fire-and-forget (not awaited) inside /start.
        expect(startHandler).toMatch(/void runDeposits\(/);
        expect(startHandler).not.toMatch(/await runDeposits\(/);
    });

    it('background deposit uses maxAttempts:1 and primes a snapshot before READY', () => {
        const runDeposits = lifecycle.slice(
            lifecycle.indexOf('async function runDeposits'),
            lifecycle.indexOf('function computeFinalizeTimeoutMs'),
        );
        expect(runDeposits).toMatch(/maxAttempts:\s*1/);
        expect(runDeposits).toMatch(/primeAndMarkReady\(/);
        expect(runDeposits).toMatch(/cachedDepositStatus = 'FAILED'/);
        // READY is set inside primeAndMarkReady (post-prime), never directly here.
        expect(runDeposits).not.toMatch(/cachedDepositStatus = 'READY'/);
    });

    it('sizes the finalize timeout from the node deposit-period (not hardcoded)', () => {
        expect(lifecycle).toMatch(/headInfo\?\.depositPeriod/);
        expect(lifecycle).toMatch(/depositPeriodSec \* 1000 \+ DEPOSIT_FINALIZE_BUFFER_MS/);
    });

    it('honours an explicit operator override for the finalize wait', () => {
        const compute = lifecycle.slice(lifecycle.indexOf('function computeFinalizeTimeoutMs'));
        // Override is checked first and short-circuits the derived path.
        expect(compute).toMatch(/DEPOSIT_FINALIZE_TIMEOUT_OVERRIDE_MS > 0/);
        // Falls back to the live monitor period if /start captured a null.
        expect(compute).toMatch(/headInfo\?\.depositPeriod/);
    });
});

describe('READY is gated on a primed confirmed snapshot (not CommitFinalized alone)', () => {
    // The opening deposit lands in the head ledger but does not advance a
    // confirmed signed snapshot; the TRP resolves in-head inputs against that
    // snapshot, so a self-spend must prime one before the ballot is votable.
    it('primeAndMarkReady locates the token, primes a snapshot, THEN flips READY', () => {
        const fn = lifecycle.slice(
            lifecycle.indexOf('async function primeAndMarkReady'),
            lifecycle.indexOf('async function runDeposits'),
        );
        const locateIdx = fn.indexOf('waitForBallotTokenInLedger(');
        const primeIdx = fn.indexOf('primeSnapshot(');
        const readyIdx = fn.indexOf("cachedDepositStatus = 'READY'");
        expect(locateIdx).toBeGreaterThan(-1);
        expect(primeIdx).toBeGreaterThan(locateIdx);
        expect(readyIdx).toBeGreaterThan(primeIdx);
    });

    it('primeSnapshot builds directly (not via TRP), enqueues type prime, waits for SnapshotConfirmed', () => {
        const fn = lifecycle.slice(
            lifecycle.indexOf('async function primeSnapshot'),
            lifecycle.indexOf('async function primeAndMarkReady'),
        );
        expect(fn).toMatch(/buildPrimeSnapshotTx\(/);
        expect(fn).toMatch(/type: 'prime'/);
        expect(fn).toMatch(/waitForApplied\(/);
    });

    it('the prime self-spend is zero-fee and preserves the (601) datum verbatim', () => {
        const builder = strip(readFileSync(resolve(here, '../src/tx-builder.ts'), 'utf-8'));
        const fn = builder.slice(builder.indexOf('export function buildPrimeSnapshotTx'));
        expect(fn).toMatch(/setFee\('0'\)/);
        // Raw-CBOR passthrough of the existing inline datum — no re-encode.
        expect(fn).toMatch(/txOutInlineDatumValue\(\s*inlineDatumCborHex,\s*'CBOR'\s*\)/);
    });

    it("'prime' is a contending tx type (it spends the shared ballot token)", () => {
        const queue = strip(readFileSync(resolve(here, '../src/tx-queue.ts'), 'utf-8'));
        const isContending = queue.slice(queue.indexOf('export function isContending'));
        expect(isContending).toMatch(/type === 'prime'/);
    });

    it('the boot re-arm path also primes after CommitFinalized', () => {
        const reconcile = lifecycle.slice(lifecycle.indexOf('export async function reconcileDepositReadiness'));
        expect(reconcile).toMatch(/waitForMessage\('CommitFinalized'/);
        expect(reconcile).toMatch(/primeAndMarkReady\(/);
    });

    it('/start accepts an optional prime flag (default true) threaded into the deposit flow', () => {
        // Default-true: only false explicitly disables priming.
        expect(startHandler).toMatch(/req\.body\.prime !== false/);
        expect(startHandler).toMatch(/cachedDepositPrime = shouldPrime/);
        // primeAndMarkReady gates the self-spend on the prime arg.
        const fn = lifecycle.slice(
            lifecycle.indexOf('async function primeAndMarkReady'),
            lifecycle.indexOf('async function runDeposits'),
        );
        expect(fn).toMatch(/if \(prime\)/);
        expect(fn).toMatch(/primeSnapshot\(/);
    });

    it('exposes a manual POST /prime recovery endpoint that primes + marks READY', () => {
        const prime = lifecycle.slice(lifecycle.indexOf("router.post('/prime'"));
        // Guards: head must be OPEN and ballot identity cached.
        expect(prime).toMatch(/headStatus !== 'OPEN'/);
        expect(prime).toMatch(/cachedBallotPolicy/);
        // Reuses the shared prime path and reports the prime tx hash.
        expect(prime).toMatch(/primeAndMarkReady\(/);
        expect(prime).toMatch(/primeTxHash/);
    });
});

describe('GET /health surfaces L1 deposit-observation timing', () => {
    it('captures observedAt and reports it on /health.deposit', () => {
        expect(lifecycle).toMatch(/cachedDepositObservedAt = new Date\(\)\.toISOString\(\)/);
        expect(lifecycle).toMatch(/CommitRecorded|DepositActivated/);
        const health = lifecycle.slice(lifecycle.indexOf("router.get('/health'"));
        expect(health).toMatch(/observedAt:/);
    });
});

describe('voting is gated on deposit READY', () => {
    it('both /register and /vote reject when depositStatus is not READY', () => {
        const gates = voting.match(/getDepositStatus\(\)[\s\S]{0,160}?depositStatus !== 'READY'/g) ?? [];
        // One gate in /register, one in /vote (vote-and-register forwards to /vote).
        expect(gates.length).toBeGreaterThanOrEqual(2);
        expect(voting).toMatch(/import\s*\{[^}]*getDepositStatus[^}]*\}\s*from '\.\/lifecycle\.js'/);
    });
});

describe('GET /health surfaces deposit readiness', () => {
    it('reports depositStatus + ballotActive for polling', () => {
        const health = lifecycle.slice(lifecycle.indexOf("router.get('/health'"));
        expect(health).toMatch(/ballotActive:/);
        expect(health).toMatch(/depositStatus:/);
    });
});
