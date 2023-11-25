import {Vulnerability} from './vulnerability-checker'

export interface LibraryVersion {
  version: string
  timestamp: number
  licenses?: string | string[]
  downloads?: number
  latest: boolean
}
export interface LibraryInfo {
  name: string
  description?: string
  versions: LibraryVersion[]
  licenses: string[]
  keywords?: string[]
  issuesUrl?: string[]
  reposUrl?: string[]
  homepageUrl?: string
  documentationUrl?: string
  packageUrl?: string
  downloads?: number
  authors?: string[],
  vulnerabilities?: Vulnerability[]
  requiresLicenseAcceptance?: boolean
}