import {Request, Response} from 'express'
import {mongoCacheSystem} from '../../cache/mongo-cache'

export const getProjectById = async (_req: Request, res: Response): Promise<any> => {
    try {
        const id = _req.params.id

        await mongoCacheSystem.load()

        const value = await mongoCacheSystem.get(id)
        if (value) {
            res.status(200).send(value)
        } else {
            res.status(404).send('Resource not found')
        }
    } catch (err) {
        console.error(`Error: ${err}`)
        res.status(500).send('Internal Server Error')
    }
}

export const getAllProjects = async (_req: Request, res: Response): Promise<any> => {
    try {
        await mongoCacheSystem.load()
        const value = await mongoCacheSystem.getAll()
        res.status(200).json({ data: value })
    } catch (err) {
        console.error(`Error: ${err}`)
        res.status(500).send('Internal Server Error')
    }
}