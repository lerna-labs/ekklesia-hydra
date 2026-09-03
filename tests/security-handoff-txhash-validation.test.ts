/**
 * Regression coverage for code-scanning alert #4 (js/request-forgery): the
 * POST /prepare/handoff handler built an outbound Blockfrost request URL by
 * interpolating `definitionUtxo.txHash` straight from the request body, with
 * no format check. `isValidTxHash` gates that field before it reaches the
 * request URL, and the handler reuses the validated value everywhere the raw
 * field used to appear, including the error-path message built from the same
 * failed request.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import ballotRouter, { isValidTxHash } from '../src/routes/ballot.js';

const VALID_HASH = 'a'.repeat(64);

describe('isValidTxHash', () => {
    it('accepts a well-formed 64-char lowercase hex hash', () => {
        expect(isValidTxHash(VALID_HASH)).toBe(true);
    });

    it('rejects an absolute URL', () => {
        expect(isValidTxHash('https://evil.example.com/steal')).toBe(false);
    });

    it('rejects a path-traversal shaped value', () => {
        expect(isValidTxHash('../../../etc/passwd')).toBe(false);
    });

    it('rejects an uppercase hash of the correct length', () => {
        expect(isValidTxHash('A'.repeat(64))).toBe(false);
    });

    it('rejects a hash one character short', () => {
        expect(isValidTxHash('a'.repeat(63))).toBe(false);
    });

    it('rejects a hash one character too long', () => {
        expect(isValidTxHash('a'.repeat(65))).toBe(false);
    });

    it('rejects a non-string value', () => {
        expect(isValidTxHash(12345 as unknown)).toBe(false);
        expect(isValidTxHash(undefined)).toBe(false);
        expect(isValidTxHash(null)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Behavioral coverage on the actual route handler
// ---------------------------------------------------------------------------

function findHandoffHandler(): (req: any, res: any) => Promise<any> {
    const layer = (ballotRouter as any).stack.find(
        (l: any) => l.route?.path === '/prepare/handoff' && l.route.methods.post,
    );
    if (!layer) throw new Error('POST /prepare/handoff route not found on ballotRouter');
    return layer.route.stack[0].handle;
}

function makeRes() {
    return {
        statusCode: undefined as number | undefined,
        body: undefined as any,
        status(code: number) {
            this.statusCode = code;
            return this;
        },
        json(body: any) {
            this.body = body;
            return this;
        },
    };
}

describe('POST /prepare/handoff — definitionUtxo.txHash validation', () => {
    const handler = findHandoffHandler();

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('rejects an absolute URL and never issues an outbound request', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        const req = { body: { definitionUtxo: { txHash: 'https://evil.example.com/steal', outputIndex: 0 } } };
        const res = makeRes();

        await handler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toMatchObject({ status: 'ERROR', code: 'INVALID_INPUT' });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects a path-traversal shaped value and never issues an outbound request', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        const req = { body: { definitionUtxo: { txHash: '../../../etc/passwd', outputIndex: 0 } } };
        const res = makeRes();

        await handler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toMatchObject({ status: 'ERROR', code: 'INVALID_INPUT' });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects an uppercase hash and never issues an outbound request', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        const req = { body: { definitionUtxo: { txHash: 'A'.repeat(64), outputIndex: 0 } } };
        const res = makeRes();

        await handler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toMatchObject({ status: 'ERROR', code: 'INVALID_INPUT' });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects a wrong-length hash and never issues an outbound request', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        const req = { body: { definitionUtxo: { txHash: 'a'.repeat(63), outputIndex: 0 } } };
        const res = makeRes();

        await handler(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toMatchObject({ status: 'ERROR', code: 'INVALID_INPUT' });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('passes a well-formed hash through the validation gate (fails later, on the unrelated head-status guardrail, not on input format)', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        const req = { body: { definitionUtxo: { txHash: VALID_HASH, outputIndex: 0 } } };
        const res = makeRes();

        await handler(req, res);

        // No live Hydra connection in this test process, so headStatus is
        // never 'OPEN' and the handler stops at the next guardrail — but
        // critically not with INVALID_INPUT, proving the hash format gate
        // was satisfied.
        expect(res.body?.code).not.toBe('INVALID_INPUT');
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
