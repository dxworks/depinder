/**
 * The purls every new database build is smoke-tested on before it goes live (`smoke.ts`).
 *
 * Each one was vulnerable in BOTH tools' Phase 0 scans (`t-all.json`, `g-all.json`, the databases
 * of 2026-10-01), and `must` is an id both tools reported for it: Trivy as its `VulnerabilityID`,
 * Grype as the match's id or one of its related ids. Mostly old, well-known advisories, which do
 * not get withdrawn, plus a few packages with many findings (next, axios, aiohttp,
 * jackson-databind) so that the total the 90 % rule compares has some weight.
 *
 * Six ecosystems, not eight: Phase 0 had no cargo purl either tool found anything for, and its one
 * vulnerable gem was found by Trivy only. A canary only one tool flags would fail the other's
 * smoke test on every build.
 *
 * On Phase 0's builds these 22 purls give 160 findings in each tool, exactly what `t-all.json` and
 * `g-all.json` have for them.
 */

export interface Canary {
    purl: string
    /** An id the tool must find for this purl, or the build is refused. */
    must: string
}

export const CANARIES: readonly Canary[] = [
    {purl: 'pkg:npm/lodash.template@3.6.2', must: 'CVE-2021-23337'},
    {purl: 'pkg:npm/trim@0.0.1', must: 'CVE-2020-7753'},
    {purl: 'pkg:npm/nth-check@1.0.2', must: 'CVE-2021-3803'},
    {purl: 'pkg:npm/minimatch@3.0.4', must: 'CVE-2022-3517'},
    {purl: 'pkg:npm/next@14.0.4', must: 'CVE-2024-34351'},
    {purl: 'pkg:npm/axios@0.25.0', must: 'CVE-2023-45857'},
    {purl: 'pkg:maven/com.google.guava/guava@29.0-jre', must: 'CVE-2020-8908'},
    {purl: 'pkg:maven/com.squareup.okio/okio@3.0.0', must: 'CVE-2023-3635'},
    {purl: 'pkg:maven/org.eclipse.jetty/jetty-http@11.0.20', must: 'CVE-2024-6763'},
    {purl: 'pkg:maven/org.apache.logging.log4j/log4j-core@2.25.2', must: 'CVE-2025-68161'},
    {purl: 'pkg:maven/com.fasterxml.jackson.core/jackson-databind@2.14.0', must: 'CVE-2026-19032'},
    {purl: 'pkg:nuget/NuGet.Common@6.3.1', must: 'CVE-2023-29337'},
    {purl: 'pkg:nuget/Microsoft.Identity.Client@4.56.0', must: 'CVE-2024-27086'},
    {purl: 'pkg:nuget/System.Text.Json@8.0.0', must: 'CVE-2024-30105'},
    {purl: 'pkg:composer/firebase/php-jwt@v6.11.1', must: 'CVE-2025-45769'},
    {purl: 'pkg:composer/symfony/http-foundation@v7.3.2', must: 'CVE-2025-64500'},
    {purl: 'pkg:composer/league/commonmark@2.7.1', must: 'CVE-2026-30838'},
    {purl: 'pkg:golang/golang.org/x/crypto@v0.54.0', must: 'CVE-2026-56854'},
    {purl: 'pkg:golang/google.golang.org/grpc@v1.82.1', must: 'CVE-2026-84303'},
    {purl: 'pkg:pypi/redis@4.5.1', must: 'CVE-2023-28858'},
    {purl: 'pkg:pypi/aiohttp@3.12.15', must: 'CVE-2025-69223'},
    {purl: 'pkg:pypi/pyjwt@2.13.0', must: 'CVE-2026-101917'},
]
