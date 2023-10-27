import express from 'express'
import cors from 'cors'
import analyseRoutes from '../routes/analyseRoutes'
import libraryRoutes from '../routes/libraryRoutes'
import projectRoutes from '../routes/projectRoutes'

const app = express()
const PORT = 3000

app.use(express.json())
app.use(cors())

app.use('/analyse', analyseRoutes)
app.use('/library', libraryRoutes)
app.use('/project', projectRoutes)

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`)
})