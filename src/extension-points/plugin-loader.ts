import {javascript} from '../plugins/javascript'
import {Plugin} from './plugin'
import {ruby} from '../plugins/ruby'
import {java} from '../plugins/java'
import {python} from '../plugins/python'
import {dotnet} from '../plugins/dotnet'
import {php} from '../plugins/php'
import {sbomPlugins} from '../plugins/sbom'

export const defaultPlugins: Plugin[] = [
    javascript,
    ruby,
    java,
    python,
    php,
    dotnet,
    // Read dependency trees out of CycloneDX SBOMs produced offline by Syft and Trivy. These write
    // their own `sbom-<eco>-*.csv` results, so they sit alongside the native plugins rather than
    // replacing them — which is what makes the two routes comparable on the same repo.
    ...sbomPlugins,
]