/**
 * Coverage for: L1 ballot handlers casting `process.env.BLOCKFROST_API_KEY`
 * to string and handing it straight to BlockfrostProvider/getAdmin with no
 * presence check, so an unset key surfaced as a Blockfrost auth failure
 * instead of naming the missing configuration.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import ballotRouter from '../src/routes/ballot.js';

function findHandler(path: string): (req: any, res: any) => Promise<any> {
    const layer = (ballotRouter as any).stack.find(
        (l: any) => l.route?.path === path && l.route.methods.post,
    );
    if (!layer) throw new Error(`POST ${path} route not found on ballotRouter`);
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

describe('Blockfrost key guard on the L1 ballot handlers', () => {
    let savedKey: string | undefined;

    beforeEach(() => {
        savedKey = process.env.BLOCKFROST_API_KEY;
        delete process.env.BLOCKFROST_API_KEY;
    });

    afterEach(() => {
        if (savedKey === undefined) {
            delete process.env.BLOCKFROST_API_KEY;
        } else {
            process.env.BLOCKFROST_API_KEY = savedKey;
        }
    });

    it('POST /sweep returns 503 CLIENT_INIT_FAILED naming the missing variable', async () => {
        const handler = findHandler('/sweep');
        const req = { body: {} };
        const res = makeRes();

        await handler(req, res);

        expect(res.statusCode).toBe(503);
        expect(res.body).toMatchObject({ status: 'ERROR', code: 'CLIENT_INIT_FAILED' });
        expect(res.body.message).toContain('BLOCKFROST_API_KEY');
    });

    it('POST /prepare/cancel returns 503 CLIENT_INIT_FAILED naming the missing variable', async () => {
        const handler = findHandler('/prepare/cancel');
        const req = {
            body: {
                namespace: 'vote.ekklesia.test',
                votingWindowOpen: new Date().toISOString(),
                definitionUtxo: { txHash: 'a'.repeat(64), outputIndex: 0 },
                instanceUtxo: { txHash: 'b'.repeat(64), outputIndex: 1 },
            },
        };
        const res = makeRes();

        await handler(req, res);

        expect(res.statusCode).toBe(503);
        expect(res.body).toMatchObject({ status: 'ERROR', code: 'CLIENT_INIT_FAILED' });
        expect(res.body.message).toContain('BLOCKFROST_API_KEY');
    });
});
