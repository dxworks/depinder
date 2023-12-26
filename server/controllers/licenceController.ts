import { Request, Response } from 'express'
import { mongoCacheLicense } from '../../src/cache/mongo-cache'

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

        const body = {
            reference: reference,
            isDeprecatedLicenseId: isDeprecatedLicenseId,
            detailsUrl: detailsUrl,
            referenceNumber: referenceNumber,
            name: name,
            seeAlso: seeAlso,
            isOsiApproved: isOsiApproved,
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
        const value = await mongoCacheLicense.get(id)

        res.status(200).json(value)
    } catch (err) {
        console.error(`Error: ${err}`)
        res.status(500).send('Internal Server Error')
    }
}