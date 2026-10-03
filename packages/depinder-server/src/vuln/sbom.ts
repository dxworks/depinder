import {randomUUID} from 'node:crypto'
import type {Scannable} from './request.js'

/**
 * The dummy CycloneDX file both scanners read: one `library` component per purl, under a root
 * application nobody asked about.
 *
 * Phase 0 measured that the purl alone is not enough. Trivy matches by the component's name and
 * group, not only by its purl, and given bare names it lost 159 findings and invented 218; given
 * names and groups the way its own SBOMs write them, it found exactly what scanning the real SBOMs
 * found. So this writes them the way Trivy does (`build.py` in Phase 0 is the reference):
 *
 *   maven, npm                group = namespace (`org.yaml`, `@nestjs`), name = the last segment
 *   composer, golang          no group, name = the whole path (`github.com/BurntSushi/toml`)
 *   cargo, gem, nuget, pypi   no group, name = name
 *
 * The `bom-ref` is `c` plus the index into `scan`. Both scanners echo it on every finding (Trivy as
 * `PkgIdentifier.BOMRef`, Grype as `artifact.id`), and it is the only link from a finding back to
 * the purl that was sent: the purls they echo are their own spelling, which is not always ours.
 */
export function buildSbom(scan: readonly Scannable[]): string {
    return JSON.stringify({
        bomFormat: 'CycloneDX',
        specVersion: '1.6',
        serialNumber: `urn:uuid:${randomUUID()}`,
        version: 1,
        metadata: {component: {'bom-ref': 'root', type: 'application', name: 'purl-batch'}},
        components: scan.map((item, i) => {
            const component: Record<string, string> = {'bom-ref': `c${i}`, type: 'library', name: item.name}
            if ((item.type === 'maven' || item.type === 'npm') && item.namespace) {
                component.group = item.namespace
            } else if ((item.type === 'composer' || item.type === 'golang') && item.namespace) {
                component.name = `${item.namespace}/${item.name}`
            }
            component.version = item.version
            component.purl = item.bare
            return component
        }),
    })
}
