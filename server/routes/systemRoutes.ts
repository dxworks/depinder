import * as systemController from '../controllers/systemController'
import express from 'express'

const router = express.Router()

router.get('/all', systemController.getAllSystems)
router.get('/:id', systemController.getSystemById)
router.post('/', systemController.createSystem)

export default router