import { Request, Response } from 'express'
import {analyseFilesToCache, saveToCsv} from '../../commands/analyse'

export const saveAnalysisToCsv = async (_req: Request, res: Response): Promise<any> => {
    try {
        const folders = _req.body.folders || []
        const options = {
            plugins: _req.body.options.plugins ?? [],
            results: _req.body.options.results ?? 'results',
            refresh: _req.body.options.refresh ?? false,
        }
        const cache = _req.body.cache || true

        await saveToCsv(
            folders,
            {
                plugins: options.plugins,
                results: options.results,
                refresh: options.refresh,
            },
            cache
        )

        res.status(200).json({ data: 'ok' })
    } catch (error) {
        res.status(500).send(`Error: ${error}`)
    }
}

export const analyse = async (_req: Request, res: Response): Promise<any>  => {
    try {
        const folders = _req.body.folders || []
        const options = {
            plugins: _req.body.options.plugins ?? [],
            results: _req.body.options.results ?? 'results',
            refresh: _req.body.options.refresh ?? false,
        }
        const cache = _req.body.cache || true

        await analyseFilesToCache(
            folders,
            {
                plugins: options.plugins,
                // not used in analyse, only in saveAnalysisToCsv
                results: options.results,
                refresh: options.refresh,
            },
            cache
        )
        res.status(200).json({ data: 'ok' })
    } catch (error) {
        res.status(500).send(`Error: ${error}`)
    }
}