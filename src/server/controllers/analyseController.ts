import { Request, Response } from 'express'
import {analyseFilesToCache, saveToCsv} from '../../commands/analyse'

export const saveAnalysisToCsv = async (_req: Request, res: Response): Promise<any> => {
    try {
        const folders = _req.body.folders || []
        const options = {
            plugins: [],
            results: 'results',
            refresh: false,
        }
        // const plugins = req.body.plugins || [];

        await saveToCsv(
            folders,
            {
                plugins: [],
                results: options.results,
                refresh: false,
            },
            options.refresh || true
        )

        res.status(200).json({ data: 'ok' })
    } catch (error) {
        res.status(500).send(`Error: ${error}`)
    }
}

// saving to cache + csv
export const completeAnalysis = async (_req: Request, res: Response): Promise<any>  => {
    try {
        const folders = _req.body.folders || []
        const options = 'results'
        const cache = _req.body.refresh || true
        // const plugins = req.body.plugins || [];

        await analyseFilesToCache(
            folders,
            {
                plugins: [],
                results: options,
                refresh: false,
            },
            cache
        )
        res.status(200).json({ data: 'ok' })
    } catch (error) {
        res.status(500).send(`Error: ${error}`)
    }
}