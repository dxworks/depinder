/**
 * The Trivy and Grype releases the merge is calibrated against: the ones the vuln server's image
 * ships (a server test checks its Dockerfile) and the reference pair the CLI checks local scanners
 * against.
 */
export const PINNED_SCANNER_VERSIONS: {readonly trivy: string, readonly grype: string} = {
    trivy: '0.74.0',
    grype: '0.118.0',
}
