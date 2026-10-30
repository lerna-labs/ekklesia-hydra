/**
 * Coverage for: POST /start naming a missing BLOCKFROST_API_KEY.
 *
 * hydra-sdk 2.0.2 builds its Blockfrost provider lazily, so the Wrangler
 * constructor no longer throws for a missing key. /start checks the variable
 * itself, after the request-shape guards and before the head-state guard, so
 * the misconfiguration is named whatever state the head is in.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import lifecycleRouter from '../src/routes/lifecycle.js';
import { hydraMonitor } from '../src/helpers.js';

function findStartHandler(): (req: any, res: any) => Promise<any> {
    const layer = (lifecycleRouter as any).stack.find(
        (l: any) => l.route?.path === '/start' && l.route.methods.post,
    );
    if (!layer) throw new Error('POST /start route not found on lifecycleRouter');
    // The first handler is adminActionLimiter; the last is the route handler.
    return layer.route.stack[layer.route.stack.length - 1].handle;
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

const validBody = { utxos: [{ txHash: 'a'.repeat(64), outputIndex: 0 }] };

describe('POST /start with BLOCKFROST_API_KEY unset', () => {
    let savedKey: string | undefined;

    beforeEach(() => {
        savedKey = process.env.BLOCKFROST_API_KEY;
        delete process.env.BLOCKFROST_API_KEY;
    });

    afterEach(() => {
        vi.restoreAllMocks();
        if (savedKey === undefined) {
            delete process.env.BLOCKFROST_API_KEY;
        } else {
            process.env.BLOCKFROST_API_KEY = savedKey;
        }
    });

    for (const status of ['OPEN', 'IDLE']) {
        it(`returns 503 CLIENT_INIT_FAILED naming the variable with the head ${status}`, async () => {
            vi.spyOn(hydraMonitor, 'headStatus', 'get').mockReturnValue(status as any);
            const res = makeRes();

            await findStartHandler()({ body: validBody }, res);

            expect(res.statusCode).toBe(503);
            expect(res.body).toMatchObject({ status: 'ERROR', code: 'CLIENT_INIT_FAILED' });
            expect(res.body.message).toContain('BLOCKFROST_API_KEY');
        });
    }

    it('still rejects an empty utxos array with 400 MISSING_FIELDS', async () => {
        const res = makeRes();

        await findStartHandler()({ body: { utxos: [] } }, res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toMatchObject({ status: 'ERROR', code: 'MISSING_FIELDS' });
    });
});
