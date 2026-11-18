import {bundleFromJSON} from '@sigstore/bundle'
import {TrustedRoot} from '@sigstore/protobuf-specs'
import {getTrustedRoot} from '@sigstore/tuf'
import {toSignedEntity, toTrustMaterial, Verifier} from '@sigstore/verify'
import {errorMessage} from '@depinder/core'
import type {ScannerName} from './scanners.js'

/**
 * Is a release's checksums file the publisher's own? Both publishers sign it keyless with Sigstore
 * from their release workflow on GitHub Actions and attach the bundle as
 * `<tool>_<version>_checksums.txt.sigstore.json` (Grype since 0.120; 0.118 had a `.sig` and `.pem`).
 * The bundle carries the signing certificate, the signature and the Rekor transparency-log entry;
 * the trust root (Fulcio's CAs, Rekor's keys) comes from Sigstore's TUF repository, refreshed on
 * each check and cached in `VULN_DATA_DIR`.
 *
 * Accepted only if the signature is over these exact bytes, the certificate chains to Fulcio, the
 * log entry is there, and the certificate names the release workflow below, issued by GitHub
 * Actions. The same check `cosign verify-blob --bundle --certificate-identity
 * --certificate-oidc-issuer` makes.
 *
 * The workflows, read off the certificates of trivy 0.74.0 and 0.76.2 and grype 0.122.0. Trivy
 * signs from its tag, so its identity names the very version; Grype signs from `main`.
 */
const SIGNERS: Record<ScannerName, (version: string) => string> = {
    trivy: version => `https://github.com/aquasecurity/trivy/.github/workflows/reusable-release.yaml@refs/tags/v${version}`,
    grype: () => 'https://github.com/anchore/grype/.github/workflows/release.yaml@refs/heads/main',
}
const ISSUER = 'https://token.actions.githubusercontent.com'

/** The signature does not hold. Never retried: the release is refused. */
export class SignatureError extends Error {}

export type VerifySignature = (tool: ScannerName, version: string, checksums: Buffer, bundle: string) => Promise<void>

/**
 * A verifier whose trust root is fetched by TUF into `cachePath`. A failure to fetch the trust
 * root is an ordinary `Error` (tried again later); a bundle that does not verify is a
 * `SignatureError`.
 */
export function createSignatureVerifier(cachePath: string): VerifySignature {
    return async (tool, version, checksums, bundle) => {
        let root: TrustedRoot
        try {
            root = await getTrustedRoot({cachePath, timeout: 30_000})
        } catch (e) {
            throw new Error(`sigstore trust root unavailable: ${errorMessage(e)}`)
        }
        verifyBundle(new Verifier(toTrustMaterial(root)), tool, version, checksums, bundle)
    }
}

/** A verifier over a `trusted_root.json` already in hand: the tests', on a frozen copy. */
export function verifierFor(trustedRoot: unknown): Verifier {
    return new Verifier(toTrustMaterial(TrustedRoot.fromJSON(trustedRoot)))
}

/** The check itself, against the trust material the verifier holds. Throws `SignatureError`. */
export function verifyBundle(verifier: Verifier, tool: ScannerName, version: string, checksums: Buffer, bundle: string): void {
    try {
        const parsed = bundleFromJSON(JSON.parse(bundle))
        verifier.verify(toSignedEntity(parsed, checksums), {
            subjectAlternativeName: SIGNERS[tool](version),
            extensions: {issuer: ISSUER},
        })
    } catch (e) {
        const code = (e as {code?: unknown}).code
        throw new SignatureError(`signature check failed for ${tool} ${version}: ${typeof code === 'string' ? `${code}: ` : ''}${errorMessage(e)}`)
    }
}
