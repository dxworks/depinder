import * as systemController from '../controllers/systemController'
import express from 'express'

const router = express.Router()

router.get('/all', systemController.getAllSystems)
router.get('/:id', systemController.getSystemById)
router.post('/:id', systemController.updateSystem)
router.post('/', systemController.createSystem)
router.delete('/:id', systemController.deleteSystem)

export default router