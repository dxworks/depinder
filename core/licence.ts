export interface Licence {
    reference?: string,
    isDeprecatedLicenseId?: boolean,
    detailsUrl?: string,
    name?: string,
    _id: string,
    seeAlso?: string[],
    isOsiApproved?: boolean,
}

export interface LicenceList {
    licenses: Licence[]
    licenseListVersion: string,
    releaseDate?: Date,
}