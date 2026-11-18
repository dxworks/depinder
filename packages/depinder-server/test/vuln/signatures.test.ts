import {readFileSync} from 'node:fs'
import {describe, expect, it} from 'vitest'
import {SignatureError, verifierFor, verifyBundle} from '../../src/vuln/signatures.js'

/**
 * The real thing, offline: the checksums files and Sigstore bundles of Trivy 0.74.0 and Grype
 * 0.122.0 as published, checked against a copy of Sigstore's `trusted_root.json` (fetched by TUF
 * on 2026-11-17). Fulcio's certificates and Rekor's keys rotate rarely; when a newer release is
 * signed under a key this copy lacks, refresh the copy, not the test.
 */

const fixture = (name: string): Buffer => readFileSync(new URL(`../fixtures/scanner-releases/${name}`, import.meta.url))
const verifier = verifierFor(JSON.parse(fixture('sigstore-trusted-root.json').toString('utf8')))

const trivy = {checksums: fixture('trivy_0.74.0_checksums.txt'), bundle: fixture('trivy_0.74.0_checksums.txt.sigstore.json').toString('utf8')}
const grype = {checksums: fixture('grype_0.122.0_checksums.txt'), bundle: fixture('grype_0.122.0_checksums.txt.sigstore.json').toString('utf8')}

describe('verifyBundle', () => {
    it('accepts each publisher\'s own signature over its checksums file', () => {
        expect(() => verifyBundle(verifier, 'trivy', '0.74.0', trivy.checksums, trivy.bundle)).not.toThrow()
        expect(() => verifyBundle(verifier, 'grype', '0.122.0', grype.checksums, grype.bundle)).not.toThrow()
    })

    it('refuses a checksums file changed by one byte', () => {
        const tampered = Buffer.from(trivy.checksums)
        tampered[0] = tampered[0] === 0x61 ? 0x62 : 0x61
        expect(() => verifyBundle(verifier, 'trivy', '0.74.0', tampered, trivy.bundle)).toThrow(SignatureError)
        expect(() => verifyBundle(verifier, 'grype', '0.122.0', Buffer.concat([grype.checksums, Buffer.from('\n')]), grype.bundle))
            .toThrow(/signature check failed for grype 0.122.0/)
    })

    it('refuses a genuine signature from the wrong workflow or for another version', () => {
        // Trivy signs from the release tag: 0.74.0's bundle does not vouch for "0.75.0".
        expect(() => verifyBundle(verifier, 'trivy', '0.75.0', trivy.checksums, trivy.bundle)).toThrow(/UNTRUSTED_SIGNER/)
        // A Trivy release presented as Grype's.
        expect(() => verifyBundle(verifier, 'grype', '0.74.0', trivy.checksums, trivy.bundle)).toThrow(/UNTRUSTED_SIGNER/)
    })

    it('refuses a bundle that is not one', () => {
        expect(() => verifyBundle(verifier, 'trivy', '0.74.0', trivy.checksums, '{}')).toThrow(SignatureError)
        expect(() => verifyBundle(verifier, 'trivy', '0.74.0', trivy.checksums, 'not json')).toThrow(SignatureError)
        // Grype's bundle over Trivy's file: a valid bundle, the wrong bytes.
        expect(() => verifyBundle(verifier, 'grype', '0.122.0', trivy.checksums, grype.bundle)).toThrow(SignatureError)
    })

    it('refuses everything under a trust root that does not hold the signing keys', () => {
        const empty = verifierFor({mediaType: 'application/vnd.dev.sigstore.trustedroot+json;version=0.1', tlogs: [], certificateAuthorities: [], ctlogs: [], timestampAuthorities: []})
        expect(() => verifyBundle(empty, 'trivy', '0.74.0', trivy.checksums, trivy.bundle)).toThrow(SignatureError)
    })
})
