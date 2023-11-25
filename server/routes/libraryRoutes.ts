import express from 'express'
import * as libraryController from '../controllers/libraryController'

const router = express.Router()


router.get('/all', libraryController.getAllLibraries)
router.post('/', libraryController.getLibraryById)

export default router