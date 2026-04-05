/**
 * Logging wrapper around the auto-generated Tx3 protocol client.
 *
 * Intercepts all TRP resolve calls to log the full request and response,
 * using JSON.stringify to avoid Node.js util.inspect depth truncation.
 *
 * Set `VERBOSE=1` to enable debug logging. Errors always log regardless.
 *
 * `src/protocol.ts` is auto-generated — do NOT edit it by hand.
 * Edit this file instead for any middleware-specific TRP behavior.
 */

import { Client as GeneratedClient } from './protocol.js';
import type {
    RegisterVoterParams,
    VoteAndRegisterParams,
    CastVoteParams,
    CountVoteParams,
    FinalizeBallotParams,
} from './protocol.js';
export type {
    RegisterVoterParams,
    VoteAndRegisterParams,
    CastVoteParams,
    CountVoteParams,
    FinalizeBallotParams,
};
import type { ClientOptions, ResolveResponse, SubmitParams } from 'tx3-sdk/trp';
import { debug } from './helpers.js';

/** Stringify any value fully — avoids Node.js console depth truncation. */
function dump(label: string, obj: unknown): void {
    try {
        debug(`[TRP] ${label}:`, JSON.stringify(obj, (_key, value) =>
            value instanceof Uint8Array || Buffer.isBuffer(value)
                ? `<${value.length} bytes>`
                : typeof value === 'bigint'
                    ? value.toString()
                    : value,
        ));
    } catch {
        debug(`[TRP] ${label}: [unstringifiable]`, obj);
    }
}

/** Always log errors, regardless of VERBOSE setting. */
function dumpError(label: string, obj: unknown): void {
    try {
        console.error(`[TRP] ${label}:`, JSON.stringify(obj, (_key, value) =>
            value instanceof Uint8Array || Buffer.isBuffer(value)
                ? `<${value.length} bytes>`
                : typeof value === 'bigint'
                    ? value.toString()
                    : value,
        ));
    } catch {
        console.error(`[TRP] ${label}: [unstringifiable]`, obj);
    }
}

export class TRPClientLogged {
    private readonly inner: GeneratedClient;

    constructor(options: ClientOptions) {
        dump('Constructing TRP Client', options);
        this.inner = new GeneratedClient(options);
    }

    async registerVoterTx(args: RegisterVoterParams): Promise<ResolveResponse> {
        dump('registerVoterTx args', args);
        try {
            const result = await this.inner.registerVoterTx(args);
            dump('registerVoterTx result', { txLength: result.tx?.length ?? null });
            return result;
        } catch (err) {
            dumpError('registerVoterTx ERROR', err);
            throw err;
        }
    }

    async voteAndRegisterTx(args: VoteAndRegisterParams): Promise<ResolveResponse> {
        dump('voteAndRegisterTx args', args);
        try {
            const result = await this.inner.voteAndRegisterTx(args);
            dump('voteAndRegisterTx result', { txLength: result.tx?.length ?? null });
            return result;
        } catch (err) {
            dumpError('voteAndRegisterTx ERROR', err);
            throw err;
        }
    }

    async castVoteTx(args: CastVoteParams): Promise<ResolveResponse> {
        dump('castVoteTx args', args);
        try {
            const result = await this.inner.castVoteTx(args);
            dump('castVoteTx result', { txLength: result.tx?.length ?? null });
            return result;
        } catch (err) {
            dumpError('castVoteTx ERROR', err);
            throw err;
        }
    }

    async countVoteTx(args: CountVoteParams): Promise<ResolveResponse> {
        dump('countVoteTx args', args);
        try {
            const result = await this.inner.countVoteTx(args);
            dump('countVoteTx result', { txLength: result.tx?.length ?? null });
            return result;
        } catch (err) {
            dumpError('countVoteTx ERROR', err);
            throw err;
        }
    }

    async finalizeBallotTx(args: FinalizeBallotParams): Promise<ResolveResponse> {
        dump('finalizeBallotTx args', args);
        try {
            const result = await this.inner.finalizeBallotTx(args);
            dump('finalizeBallotTx result', { txLength: result.tx?.length ?? null });
            return result;
        } catch (err) {
            dumpError('finalizeBallotTx ERROR', err);
            throw err;
        }
    }

    async submit(params: SubmitParams): Promise<void> {
        dump('submit params', params);
        try {
            await this.inner.submit(params);
            console.log('[TRP] submit: OK');
        } catch (err) {
            dumpError('submit ERROR', err);
            throw err;
        }
    }
}
