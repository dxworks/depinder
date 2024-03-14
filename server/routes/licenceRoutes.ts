import express from 'express'
import * as controller from '../controllers/licenceController'

const router = express.Router()

router.get('/all', controller.all)
router.post('/all', controller.addAll)
router.get('/similar/:id', controller.getLicenceSuggestions)
router.post('/alias', controller.addAlias)
router.get('/:id', controller.getLicenseById)
router.patch('/:id', controller.patchLicense)
router.get('/project/:id', controller.getLicenceByProjectId)
router.post('/', controller.newLicense)

export default router