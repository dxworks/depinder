import * as systemController from '../controllers/systemController'
import express from 'express'

const router = express.Router()

router.get('/all', systemController.getAllProjects)
router.get('/:id', systemController.getProjectById)

export default router