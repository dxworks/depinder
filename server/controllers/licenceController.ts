import {Request, Response} from 'express'
import {mongoCacheLibrary, mongoCacheLicense, mongoCacheProject} from '../../src/cache/mongo-cache'
import stringSimilarity from 'string-similarity'

export const all = async (_req: Request, res: Response): Promise<any> => {
    try {
        mongoCacheLicense.load()
        const value = await mongoCacheLicense.getAll?.()

        res.status(200).json(value)
    } catch (err) {
        console.error(`Error: ${err}`)
        res.status(500).send('Internal Server Error')
    }
}

export const newLicense = async (_req: Request, res: Response): Promise<any> => {
    try {
        if (!_req.body._id) {
            res.status(400).json({ message: 'Missing id' })
            return
        }

        if (await mongoCacheLicense.has?.(_req.body._id)) {
            res.status(400).json({ message: 'License already exists' })
            return
        }

        const body = convertBody(_req)

        mongoCacheLicense.load()

        mongoCacheLicense.set?.(_req.body._id, body)

        res.status(200).json({ data: body })
    } catch (err) {
        console.error(`Error: ${err}`)
        res.status(500).send(err)
    }
}

export const addAll = async (_req: Request, res: Response): Promise<any> => {
    mongoCacheLicense.load()

    for (const license of _req.body.licenses) {
        try {
            if (await mongoCacheLicense.has?.(license.licenseId)) {
                // res.status(400).json({ message: 'License already exists' })
                console.log('License already exists')
                return
            }

            mongoCacheLicense.set?.(license.licenseId, {
                ...license,
                custom: false,
                _id: license.licenseId,
            })
        }
        catch (e) {
            console.error(`Error: ${e}`)
        }
    }

    res.status(200).json({ message: 'All licenses added' })
}

export const getLicenseById = async (_req: Request, res: Response): Promise<any> => {
    try {
        const id = _req.params.id

        mongoCacheLicense.load()
        const value = await mongoCacheLicense.get?.(id) ?? await  mongoCacheLicense.findByField?.('other_ids', id)

        res.status(200).json(value)
    } catch (err) {
        console.error(`Error: ${err}`)
        res.status(500).send('Internal Server Error')
    }
}

async function licenceSuggestions(id: string) {
    mongoCacheLicense.load()
    const mongoLicences = await mongoCacheLicense.getAll?.()
    // console.log(mongoLicences)

    const allLicenses = mongoLicences.map((licence: any) => licence._id).filter((licence: any) => licence !== null)
    // console.log(allLicenses)

    const matches = stringSimilarity.findBestMatch(id, allLicenses)

    // at least 5 similar matches with a rating of 0.3 or higher
    return matches.ratings
        .sort((a, b) => b.rating - a.rating)
        .filter(match => {
            return match.rating >= 0.3
        })
        .slice(0, 5);
}

export const getLicenceSuggestions = async (_req: Request, res: Response): Promise<any> => {
    try {
        const id = _req.params.id

        const topFiveMatches = await licenceSuggestions(id)

        res.status(200).json(topFiveMatches)
    } catch (err) {
        console.error(`Error: ${err}`)
        res.status(500).send('Internal Server Error')
    }
}

export const addAlias = async (_req: Request, res: Response): Promise<any> => {
    try {
        const id = _req.body.id
        const alias = _req.body.alias

        console.log(id, alias)

        mongoCacheLicense.load()
        const value = await mongoCacheLicense.get?.(id)

        if (value) {
            value.other_ids.push(alias)
            mongoCacheLicense.set?.(id, value)
        }

        console.log(value)

        res.status(200).json(value)
    } catch (err) {
        console.error(`Error: ${err}`)
        res.status(500).send('Internal Server Error')
    }
}

export const getLicenceByProjectId = async (_req: Request, res: Response): Promise<any> => {
    try {
        const id = _req.params.id

        mongoCacheProject.load()
        const project = await mongoCacheProject.get?.(id)

        if (!project) {
            res.status(404).json({ message: 'Project not found' })
            return
        }

        mongoCacheLibrary.load()

        const dependencies = project.dependencies
        const licenses = new Map<string, any>()

        for (const dep of dependencies) {
            const library = await mongoCacheLibrary.get?.(dep.id)
            if (library) {
                for (const license of library.licenses) {
                    if (licenses.has(license)) {
                        licenses.get(license).libraries.push(dep)
                    } else {
                        mongoCacheLicense.load()
                        const licenceData = await mongoCacheLicense.get?.(license) ?? await mongoCacheLicense.findByField?.('other_ids', license)
                        // ?? await mongoCacheLicense.findByField?.('other_ids', id)

                        licenses.set(license, {
                            _id: licenceData?._id ?? license,
                            custom: licenceData?.custom,
                            detailsUrl: licenceData?.detailsUrl,
                            name: licenceData?.name ?? license,
                            isDeprecatedLicenseId: licenceData?.isDeprecatedLicenseId,
                            isOsiApproved: licenceData?.isOsiApproved,
                            other_ids: licenceData?.other_ids,
                            reference: licenceData?.reference,
                            referenceNumber: licenceData?.referenceNumber,
                            seeAlso: licenceData?.seeAlso,
                            libraries: [dep],
                            suggestedLicences: licenceData == null ? await licenceSuggestions(license) : [],
                        })
                    }
                }
            }
        }

        res.status(200).json(Array.from(licenses.values()))
    }
    catch (e) {
        console.error(`Error: ${e}`)
        res.status(500).send('Internal Server Error')
    }
}

export const patchLicense = async (_req: Request, res: Response): Promise<any> => {
    try {
        const id = _req.params.id
        const body = convertBody(_req)

        mongoCacheLicense.load()
        const value = await mongoCacheLicense.get?.(id)

        console.log(body)

        if (value) {
            mongoCacheLicense.set?.(_req.body._id, body)
        }

        res.status(200).json(value)
    } catch (err) {
        console.error(`Error: ${err}`)
        res.status(500).send('Internal Server Error')
    }
}

const convertBody = (_req: Request) => {
    const id = _req.body._id
    const reference = _req.body.reference
    const isDeprecatedLicenseId = _req.body.isDeprecatedLicenseId
    const detailsUrl = _req.body.detailsUrl
    const referenceNumber = _req.body.referenceNumber
    const name = _req.body.name
    const seeAlso = _req.body.seeAlso
    const isOsiApproved = _req.body.isOsiApproved
    const otherIds = _req.body.other_ids
    const custom = _req.body.custom ?? false

    return {
        reference: reference,
        isDeprecatedLicenseId: isDeprecatedLicenseId,
        detailsUrl: detailsUrl,
        referenceNumber: referenceNumber,
        name: name,
        seeAlso: seeAlso,
        isOsiApproved: isOsiApproved,
        other_ids: otherIds,
        custom: custom,
    }
}