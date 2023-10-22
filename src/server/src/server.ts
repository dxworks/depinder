import express from 'express'
import cors from 'cors'
import {analyseFilesToCache, saveToCsv} from '../../commands/analyse'
import {mongoCacheProject} from '../../cache/mongo-cache'

const app = express()
const PORT = 3000

app.use(express.json())

app.use(cors())

export interface AnalyseOptions {
    plugins?: string[]
    results: string
    refresh: boolean
}

app.get('/analyse/all', async (_req, res) => {
    try {
        await mongoCacheProject.load()
        const value = await mongoCacheProject.getAll()
        res.status(200).json({ data: value })
    } catch (err) {
        console.error(`Error: ${err}`)
        res.status(500).send('Internal Server Error')
    }
})

app.get('/analyse/:id', async (req, res) => {
    try {
        const id = req.params.id

        await mongoCacheProject.load()

        const value = await mongoCacheProject.get(id)
        if (value) {
            res.status(200).send(value)
        } else {
            res.status(404).send('Resource not found')
        }
    } catch (err) {
        console.error(`Error: ${err}`)
        res.status(500).send('Internal Server Error')
    }
})

app.post('/analyse/csv', async (req, res) => {
    try {
        const folders = req.body.folders || []
        const options = 'results'
        const cache = req.body.refresh || true
        // const plugins = req.body.plugins || [];

        await saveToCsv(
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
})


app.post('/analyse', async (req, res) => {
    try {
        const folders = req.body.folders || []
        const options = 'results'
        const cache = req.body.refresh || true
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
})

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`)
})
