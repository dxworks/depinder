export interface Licence {
    reference?: string,
    isDeprecatedLicenseId?: boolean,
    detailsUrl?: string,
    name?: string,
    _id: string,
    seeAlso?: string[],
    isOsiApproved?: boolean,
    other_ids?: string[],
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