import { Request, Response } from 'express'
import { mongoCacheLibrary } from '../../src/cache/mongo-cache'

export const getAllLibraries = async (_req: Request, res: Response): Promise<any> => {
    try {
        mongoCacheLibrary.load()
        const value = await mongoCacheLibrary.getAll?.()

        res.status(200).json({ data: value })
    } catch (err) {
        console.error(`Error: ${err}`)
        res.status(500).send('Internal Server Error')
    }
}

export const getLibraryById = async (_req: Request, res: Response): Promise<any> => {
    try {
        const id = _req.body.id

        mongoCacheLibrary.load()
        const value = await mongoCacheLibrary.get?.(id)

        res.status(200).json({ data: value })
    } catch (err) {
        console.error(`Error: ${err}`)
        res.status(500).send('Internal Server Error')
    }
}

export const getLibrariesWithLicense = async (_req: Request, res: Response): Promise<any> => {
    try {
        const license = _req.body.licenceId

        mongoCacheLibrary.load()
        const value = await mongoCacheLibrary.getAll?.()

        const filtered = value.filter((it: any) => (it.licenses ?? []).includes(license))
        res.status(200).json(filtered)
    } catch (err) {
        console.error(`Error: ${err}`)
        res.status(500).send('Internal Server Error')
    }
}