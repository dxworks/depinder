import {Request, Response} from 'express'
import {mongoCacheProject} from '../../src/cache/mongo-cache'

export const getProjectById = async (_req: Request, res: Response): Promise<any> => {
    try {
        const id = _req.params.id

        await mongoCacheProject.load()

        const value = await mongoCacheProject.get?.(id)
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
        await mongoCacheProject.load()
        const value = await mongoCacheProject.getAll?.()
        res.status(200).json({ data: value })
    } catch (err) {
        console.error(`Error: ${err}`)
        res.status(500).send('Internal Server Error')
    }
}

export const getPathById = async (_req: Request, res: Response): Promise<any> => {
    try {
        const id = _req.params.id

        await mongoCacheProject.load()

        const value = await mongoCacheProject.get?.(id)
        if (value) {
            res.status(200).send({data: value.projectPath})
        } else {
            res.status(404).send('Resource not found')
        }
    } catch (err) {
        console.error(`Error: ${err}`)
        res.status(500).send('Internal Server Error')
    }
}

export const deleteProjectById = async (_req: Request, res: Response): Promise<any> => {
    try {
        const id = _req.params.id

        await mongoCacheProject.load()

        const value = await mongoCacheProject.get?.(id)
        if (value) {
            mongoCacheProject.set?.(id, null)
            res.status(200).send('Resource deleted')
        } else {
            res.status(404).send('Resource not found')
        }
    } catch (err) {
        console.error(`Error: ${err}`)
        res.status(500).send('Internal Server Error')
    }
}