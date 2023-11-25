import {graphql} from '@octokit/graphql'
import axios from 'axios'
import {Vulnerability} from '../../core/vulnerability-checker'

export async function getVulnerabilitiesFromGithub(ecosystem: string, packageName: string): Promise<Vulnerability[]> {
    const authGraphql = graphql.defaults({
        headers: {
            authorization: `token ${process.env.GH_TOKEN}`,
        },
    })

    const response: any = await authGraphql(
        `
            query securityVulnerabilities($ecosystem: SecurityAdvisoryEcosystem, $package: String!){
              securityVulnerabilities(first: 100, ecosystem: $ecosystem package: $package) {
                pageInfo {
                  endCursor
                  hasNextPage
                }
                nodes {
                  firstPatchedVersion {
                    identifier
                  }
                  package {
                    name
                    ecosystem
                  }
                  severity
                  updatedAt
                  vulnerableVersionRange
                  advisory {
                    identifiers {
                      value
                      type
                    }
                    databaseId
                    description
                    ghsaId
                    id
                    origin
                    permalink
                    publishedAt
                    references {
                      url
                    }
                    severity
                    summary
                    updatedAt
                    withdrawnAt
                  }
                }
              }
            }
        `.trim(),
        {
            ecosystem: ecosystem,
            package: packageName,
        }
    )
    return response.securityVulnerabilities.nodes.map((it: any) => {
        return {
            severity: it.severity,
            updatedAt: it.updatedAt,
            timestamp: Date.parse(it.advisory.publishedAt),
            summary: it.advisory.summary,
            description: it.advisory.description,
            permalink: it.advisory.permalink,
            identifiers: it.advisory.identifiers,
            references: it.advisory.references,
            vulnerableRange: it.vulnerableVersionRange,
            firstPatchedVersion: it.firstPatchedVersion?.identifiers,
        } as Vulnerability
    })

}
export async function getVulnerabilitiesFromSonatype(purls: string[]): Promise<{ [purl: string]: Vulnerability[] }> {
    const {data} = await axios.post('https://ossindex.sonatype.org/api/v3/component-report', {coordinates: purls})

    return data.reduce((a: any, v: any) => ({
        ...a, [v.coordinates]: v.vulnerabilities.map((it: any) => ({
            severity: mapSeverity(it.cvssScore),
            score: it.cvssScore,
            description: it.description,
            summary: it.title,
            identifiers: [{value: it.cve, type: 'CVE'}],
            permalink: it.reference,
            references: [it.reference, ...it.externalReferences],
        } as Vulnerability)),
    }), {})
}


function mapSeverity(cvssScore: any) {
    if(cvssScore < 1)
        return 'NONE'
    if(cvssScore < 4)
        return 'LOW'
    if(cvssScore < 7)
        return 'MEDIUM'
    if(cvssScore < 9)
        return 'HIGH'
    if(cvssScore <=10)
        return 'CRITICAL'

    return 'NONE'
}
