export interface Licence {
    reference?: string,
    isDeprecatedLicenseId?: boolean,
    detailsUrl?: string,
    name?: string,
    _id: string,
    seeAlso?: string[],
    isOsiApproved?: boolean,
    other_ids?: string[],
    isCustom?: boolean,

    permissions?: string[],
    conditions?: string[],
    limitations?: string[],
}

export interface SuggestedLicence {
    rating: number,
    target: string
}

export interface LicenceList {
    licenses: Licence[]
    licenseListVersion: string,
    releaseDate?: Date,
}