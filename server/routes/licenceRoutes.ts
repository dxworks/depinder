import express from 'express'
import * as controller from '../controllers/licenceController'

const router = express.Router()

router.get('/all', controller.all)
router.get('/:id', controller.getLicenseById)
router.post('/', controller.newLicense)

export default router