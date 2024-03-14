import express from 'express'
import cors from 'cors'
import analyseRoutes from '../routes/analyseRoutes'
import libraryRoutes from '../routes/libraryRoutes'
import projectRoutes from '../routes/projectRoutes'
import systemRoutes from '../routes/systemRoutes'
import licenceRoutes from "../routes/licenceRoutes";
import bodyParser from "body-parser";

const app = express()
const PORT = 3000

app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use(express.json())
app.use(cors())

app.use('/analyse', analyseRoutes)
app.use('/library', libraryRoutes)
app.use('/project', projectRoutes)
app.use('/system', systemRoutes)
app.use('/licence', licenceRoutes)

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`)
})
