"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getVulnerabilitiesFromSonatype = exports.getVulnerabilitiesFromGithub = void 0;
const graphql_1 = require("@octokit/graphql");
const axios_1 = __importDefault(require("axios"));
async function getVulnerabilitiesFromGithub(ecosystem, packageName) {
    const authGraphql = graphql_1.graphql.defaults({
        headers: {
            authorization: `token ${process.env.GH_TOKEN}`,
        },
    });
    const response = await authGraphql(`
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
        `.trim(), {
        ecosystem: ecosystem,
        package: packageName,
    });
    return response.securityVulnerabilities.nodes.map((it) => {
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
        };
    });
}
exports.getVulnerabilitiesFromGithub = getVulnerabilitiesFromGithub;
async function getVulnerabilitiesFromSonatype(purls) {
    const { data } = await axios_1.default.post('https://ossindex.sonatype.org/api/v3/component-report', { coordinates: purls });
    return data.reduce((a, v) => ({
        ...a, [v.coordinates]: v.vulnerabilities.map((it) => ({
            severity: mapSeverity(it.cvssScore),
            score: it.cvssScore,
            description: it.description,
            summary: it.title,
            identifiers: [{ value: it.cve, type: 'CVE' }],
            permalink: it.reference,
            references: [it.reference, ...it.externalReferences],
        })),
    }), {});
}
exports.getVulnerabilitiesFromSonatype = getVulnerabilitiesFromSonatype;
function mapSeverity(cvssScore) {
    if (cvssScore < 1)
        return 'NONE';
    if (cvssScore < 4)
        return 'LOW';
    if (cvssScore < 7)
        return 'MEDIUM';
    if (cvssScore < 9)
        return 'HIGH';
    if (cvssScore <= 10)
        return 'CRITICAL';
    return 'NONE';
}
