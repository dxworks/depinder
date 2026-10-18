import {isPrerelease} from '@depinder/core'
import moment from 'moment'
import {LibraryInfo} from '../extension-points/library-info'
import {countRequest} from '../utils/profile'
import {delay} from '../utils/utils'

/**
 * Libraries.io, the CLI's last resort: only for maven, pypi, nuget and composer, and only with
 * a key.
 */

/** Libraries.io's platform names for the ecosystems that may use it. */
type LibrariesIoPlatform = 'maven' | 'pypi' | 'nuget' | 'packagist'

/** Libraries.io's platform name per purl type. */
const LIBRARIES_IO_PLATFORMS: Readonly<Record<string, LibrariesIoPlatform>> = {
    maven: 'maven',
    pypi: 'pypi',
    nuget: 'nuget',
    composer: 'packagist',
}

export interface LibrariesIoFallback {
    /** Whether a package of this purl type that the registry could not answer goes to Libraries.io. */
    covers(type: string): boolean
    retrieve(type: string, name: string): Promise<LibraryInfo>
}

/** The real Libraries.io client; `covers` is false for every type while no key is set. */
export function librariesIoFallback(): LibrariesIoFallback {
    return {
        // Without a key Libraries.io answers every request with `Forbidden`; do not ask.
        covers: type => type in LIBRARIES_IO_PLATFORMS && !!process.env.LIBRARIES_IO_API_KEY,
        retrieve: (type, name) => retrieveFromLibrariesIo(type, name),
    }
}

/** One project from https://libraries.io/api, spaced half a second apart. */
async function retrieveFromLibrariesIo(type: string, libraryName: string): Promise<LibraryInfo> {
    const platform = LIBRARIES_IO_PLATFORMS[type]
    await delay(500)
    const url = `https://libraries.io/api/${platform}/${libraryName}?api_key=${process.env.LIBRARIES_IO_API_KEY}`
    countRequest(url)
    const response = await fetch(url)
    const data: any = await response.json()

    return {
        name: libraryName,
        versions: data.versions.map((it: any) => ({
            version: it.number,
            timestamp: moment(it.published_at).valueOf(),
            latest: it.number === data.latest_release_number,
            licenses: [],
            ...(isPrerelease(type, it.number) ? {prerelease: true} : {}),
        })),
        licenses: data.licenses ? [data.licenses] : [],
        homepageUrl: data?.homepage ?? '',
    }
}
