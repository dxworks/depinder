export interface LibraryVersion {
  version: string
  timestamp: number
  licenses?: string | string[]
  downloads?: number
  latest: boolean
}

interface Vulnerability {
  severity: string
  score?: number
  description: string
  summary?: string
  timestamp?: number
  permalink: string
  identifiers?: { value: string, type: string }[]
  references?: string[]
  vulnerableRange?: string
  vulnerableVersions?: string[]
  firstPatchedVersion?: string
}

export interface LibraryInfo {
  name: string
  description?: string
  versions: LibraryVersion[]
  licenses: string[]
  keywords: string[]
  issuesUrl: string[]
  reposUrl: string[]
  homepageUrl: string[]
  documentationUrl: string[]
  packageUrl: string[]
  downloads: number
  authors: string[],
  vulnerabilities: Vulnerability[]
  requiresLicenseAcceptance: boolean
}
