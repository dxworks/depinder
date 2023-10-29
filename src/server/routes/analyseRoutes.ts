import express from 'express'
import * as analyseController from '../controllers/analyseController'

const router = express.Router()

router.post('/csv', analyseController.saveAnalysisToCsv)

router.post('/', analyseController.analyse)

export default router