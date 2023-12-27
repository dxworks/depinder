import { Request, Response } from 'express'
import { mongoCacheLicense } from '../../src/cache/mongo-cache'
import stringSimilarity from 'string-similarity';

export const all = async (_req: Request, res: Response): Promise<any> => {
    try {
        mongoCacheLicense.load()
        const value = await mongoCacheLicense.getAll()

        res.status(200).json(value)
    } catch (err) {
        console.error(`Error: ${err}`)
        res.status(500).send('Internal Server Error')
    }
}

export const newLicense = async (_req: Request, res: Response): Promise<any> => {
    try {
        const id = _req.body._id
        const reference = _req.body.reference
        const isDeprecatedLicenseId = _req.body.isDeprecatedLicenseId
        const detailsUrl = _req.body.detailsUrl
        const referenceNumber = _req.body.referenceNumber
        const name = _req.body.name
        const seeAlso = _req.body.seeAlso
        const isOsiApproved = _req.body.isOsiApproved
        const otherIds = _req.body.other_ids

        const body = {
            reference: reference,
            isDeprecatedLicenseId: isDeprecatedLicenseId,
            detailsUrl: detailsUrl,
            referenceNumber: referenceNumber,
            name: name,
            seeAlso: seeAlso,
            isOsiApproved: isOsiApproved,
            other_ids: otherIds
        }

        mongoCacheLicense.load()
        await mongoCacheLicense.set(id, body)

        res.status(200).json({ data: body })
    } catch (err) {
        console.error(`Error: ${err}`)
        res.status(500).send('Internal Server Error')
    }
}

export const getLicenseById = async (_req: Request, res: Response): Promise<any> => {
    try {
        const id = _req.params.id

        mongoCacheLicense.load()
        const value = await mongoCacheLicense.get(id) ?? await  mongoCacheLicense.findByField('other_ids', id)

        res.status(200).json(value)
    } catch (err) {
        console.error(`Error: ${err}`)
        res.status(500).send('Internal Server Error')
    }
}

export const getLicenceSuggestions = async (_req: Request, res: Response): Promise<any> => {
    try {
        const id = _req.params.id

        mongoCacheLicense.load()
        const mongoLicences = await mongoCacheLicense.getAll()
        // console.log(mongoLicences)

        const allLicenses = mongoLicences.map((licence: any) => licence._id).filter((licence: any) => licence !== null)
        // console.log(allLicenses)

        const matches = stringSimilarity.findBestMatch(id, allLicenses);

        // at least 5 similar matches with a rating of 0.5 or higher
        const topFiveMatches = matches.ratings
            .sort((a, b) => b.rating - a.rating)
            .filter(match => {
                // console.log(match.target, match.rating)
                return match.rating >= 0.3;
            })
            .slice(0, 5);

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
        const value = await mongoCacheLicense.get(id)

        if (value) {
            value.other_ids.push(alias)
            await mongoCacheLicense.set(id, value)
        }

        console.log(value)

        res.status(200).json(value)
    } catch (err) {
        console.error(`Error: ${err}`)
        res.status(500).send('Internal Server Error')
    }
}