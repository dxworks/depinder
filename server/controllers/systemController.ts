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
            runs: [
                {
                    date: Date.now(),
                    projects: projectIds,
                },
            ]
        })

        res.status(200).json({ data: "System created" })
    } catch (err) {
        res.status(500).json({ data: err })
    }
}

export const updateSystem = async (_req: Request, res: Response): Promise<any> => {
    try {
        const id = _req.body._id
        const name = _req.body.name
        const newProjects = _req.body.newProjects
        const deletedProjects = _req.body.deletedProjects

        //todo check analyse options
        const projectIds = await analyseFilesToCache(
            newProjects,
            {
                plugins: [],
                // not used in analyse, only in saveAnalysisToCsv
                results: 'results',
                refresh: false,
            },
            true
        )

        await mongoCacheSystem.load()

        console.log("Projects ids" + projectIds.filter((id: string) => !deletedProjects.includes(id)))

        const latestRun = (await mongoCacheSystem.get(id)).runs.sort((a: any, b: any) => b.date - a.date)[0];

        const existingProjects = latestRun.projects.filter((id: string) => !deletedProjects.includes(id))

        console.log("Existing projects " + latestRun.projects)
        console.log("Deleted projects " + deletedProjects)
        console.log("After filtering " + existingProjects)
        console.log("Without duplicates " + [...new Set(projectIds.concat(existingProjects))])

        await mongoCacheSystem.set(id, {
            name: name,
            runs: [
                {
                    date: Date.now(),
                    projects: [...new Set(projectIds.concat(existingProjects))]
                },
            ]
        })

        res.status(200).json({ data: "System created" })
    } catch (err) {
        res.status(500).json({ data: err })
    }
}

export const deleteSystem = async (_req: Request, res: Response): Promise<any> => {
    try {
        const id = _req.params.id

        await mongoCacheSystem.load()

        await mongoCacheSystem.delete(id)

        res.status(200).json({ data: "System deleted" })
    } catch (err) {
        res.status(500).json({ data: err })
    }
}