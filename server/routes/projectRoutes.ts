import * as projectController from '../controllers/projectController'
import express from 'express'

const router = express.Router()

router.get('/all', projectController.getAllProjects)
router.get('/:id/path', projectController.getPathById)
router.delete('/:id', projectController.deleteProjectById)
router.get('/:id', projectController.getProjectById)


export default router