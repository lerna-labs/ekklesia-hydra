import { Buffer } from 'node:buffer';
import CMS from '@emurgo/cardano-message-signing-nodejs';
import CSL from '@emurgo/cardano-serialization-lib-nodejs';

export interface CoseVerifyResult {
    /** Ed25519 signature is valid over the COSE Sig_structure. */
    validates: boolean;
    /** The COSE payload equals the expected message (here: the merkleRoot). */
    messageMatches: boolean;
    /** Signer public key (hex). Empty string if the COSE could not be parsed. */
    pubKeyHex: string;
}

/**
 * Verify a CIP-8 COSE_Sign1 signature WITHOUT the address-binding check, returning
 * the `validates` (Ed25519) and `messageMatches` (payload == message) components
 * separately.
 *
 * Why this exists: `@lerna-labs/hydra-sdk`'s `verifySignature` only returns the
 * combined `isValid = validates && messageMatches && addressMatches`. For a
 * native-script member key, or a calidus hot key, the signer's key is NOT the
 * credential address (it's a script hash / a different key), so `addressMatches`
 * — and therefore `isValid` — is always false even for a perfectly valid
 * signature. The script/calidus paths previously worked around that by checking
 * only `pubKeyHex` (which the SDK returns whenever the COSE merely *parses*,
 * regardless of validity) — so an invalid or wrong-message signature was
 * accepted. That is the auth-bypass this module fixes: callers verify
 * `validates && messageMatches` here, binding the key to the script/declaration
 * separately (script-hash match / calidus declaration).
 *
 * The key-based path keeps using the SDK's `verifySignature` — there the address
 * check is correct (the signer's key IS the voter credential).
 *
 * Uses the same @emurgo primitives as the SDK so the cryptographic check is
 * identical; it just omits the address comparison.
 */
export function verifyCoseSignature(
    coseSign1Hex: string,
    message: string,
    coseKeyHex: string,
): CoseVerifyResult {
    try {
        const coseSign1 = CMS.COSESign1.from_bytes(Buffer.from(coseSign1Hex, 'hex'));

        // Payload the signature commits to (CIP-30 wallet signatures attach it).
        const payload = coseSign1.payload();
        const messageMatches = payload != null && Buffer.from(payload).toString('ascii') === message;

        // Public key lives at COSE_Key map label -2 (OKP curve x-coordinate).
        const coseKey = CMS.COSEKey.from_bytes(Buffer.from(coseKeyHex, 'hex'));
        const pubKeyCbor = coseKey.header(
            CMS.Label.new_int(CMS.Int.new_negative(CMS.BigNum.from_str('2'))),
        );
        const pubKeyBytes = pubKeyCbor?.as_bytes();
        if (!pubKeyBytes) {
            return { validates: false, messageMatches, pubKeyHex: '' };
        }

        const sigKey = CSL.PublicKey.from_bytes(pubKeyBytes);
        const sig = CSL.Ed25519Signature.from_bytes(coseSign1.signature());
        const validates = sigKey.verify(coseSign1.signed_data().to_bytes(), sig);

        return { validates, messageMatches, pubKeyHex: sigKey.to_hex() };
    } catch {
        return { validates: false, messageMatches: false, pubKeyHex: '' };
    }
}
