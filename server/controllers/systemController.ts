import {Request, Response} from 'express'
import {mongoCacheSystem} from '../../src/cache/mongo-cache'
import {analyseFilesToCache} from '../../src/commands/analyse'

export const getSystemById = async (_req: Request, res: Response): Promise<any> => {
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

export const getAllSystems = async (_req: Request, res: Response): Promise<any> => {
    try {
        await mongoCacheSystem.load()
        const value = await mongoCacheSystem.getAll()
        res.status(200).json({ data: value })
    } catch (err) {
        console.error(`Error: ${err}`)
        res.status(500).send('Internal Server Error')
    }
}

export const createSystem = async (_req: Request, res: Response): Promise<any> => {
    try {
        const id = _req.body._id
        const name = _req.body.name
        const projectPaths = _req.body.projectPaths

        //todo check analyse options
        const projectIds = await analyseFilesToCache(
            projectPaths,
            {
                plugins: [],
                // not used in analyse, only in saveAnalysisToCsv
                results: 'results',
                refresh: false,
            },
            true
        )

        await mongoCacheSystem.load()

        await mongoCacheSystem.set(id, {
            name: name,
            projectPaths: projectPaths,
            projects: projectIds,
        })

        res.status(200).send('Resource created')
    } catch (err) {
        console.error(`Error: ${err}`)
        res.status(500).send('Internal Server Error')
    }
}