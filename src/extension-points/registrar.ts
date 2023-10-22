import {Vulnerability} from './vulnerability-checker'
import fetch from 'node-fetch'
import moment from 'moment/moment'
import {delay} from '../utils/utils'

export interface Registrar {
    retrieve: RegistryRetriever
}

export type RegistryRetriever = (libraryName: string) => LibraryInfo | Promise<LibraryInfo>

interface LibraryVersion {
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

export interface ProjectInfo {
    projectPath: string,
    name: string,
    directDeps: number,
    indirectDeps: number,
    directOutdatedDeps: number,
    directOutdatedDepsPercentage: number,
    indirectOutdatedDeps: number,
    indirectOutdatedDepsPercentage: number,
    directVulnerableDeps: number,
    indirectVulnerableDeps: number,
    directOutOfSupport: number,
    indirectOutOfSupport: number,
}

export abstract class AbstractRegistrar implements Registrar {

    private readonly next: Registrar | null = null

    constructor(next: Registrar | null = null) {
        this.next = next
    }

    public async retrieve(libraryName: string): Promise<LibraryInfo> {
        try {
            return await this.retrieveFromRegistry(libraryName)
        } catch (e) {
            if (this.next) {
                return this.next.retrieve(libraryName)
            }
            else throw e
        }
    }
    abstract retrieveFromRegistry(libraryName: string) : LibraryInfo | Promise<LibraryInfo>
}

// Get data from libraries.io API: https://libraries.io/api#project-dependencies
export type RegistryType = 'maven' | 'npm' | 'pypi' | 'nuget' | 'packagist'

export class LibrariesIORegistrar extends AbstractRegistrar {
    private readonly registryType: RegistryType

    constructor(registryType: RegistryType) {
        super()
        this.registryType = registryType
    }

    async retrieveFromRegistry(libraryName: string): Promise<LibraryInfo> {
        await delay(500)
        const librariesIoURL = `https://libraries.io/api/${this.registryType}/${libraryName}?api_key=${process.env.LIBRARIES_IO_API_KEY}`
        const librariesIoResponse: any = await fetch(librariesIoURL)
        const libIoData = await librariesIoResponse.json()

        return {
            name: libraryName,
            versions: libIoData.versions.map((it: any) => {
                return {
                    version: it.number,
                    timestamp: moment(it.published_at).valueOf(),
                    latest: it.number === libIoData.latest_release_number,
                    licenses: [],
                }
            }),
            description: libIoData?.description ?? '',
            licenses: libIoData.licenses ? [libIoData.licenses] : [],
            homepageUrl: libIoData?.homepage ?? '',
            keywords: libIoData?.keywords ?? [],
            reposUrl: libIoData?.repository_url ? [libIoData.repository_url] : [],
        }
    }
    
}