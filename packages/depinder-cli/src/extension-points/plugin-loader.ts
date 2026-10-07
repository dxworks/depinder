import {Plugin} from './plugin'
import {sbomPlugins} from '../plugins/sbom'

/** One plugin per ecosystem, each reading its dependency trees out of CycloneDX SBOMs. */
export const defaultPlugins: Plugin[] = [...sbomPlugins]
