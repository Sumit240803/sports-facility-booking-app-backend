import express from 'express';
import * as adminController from '../controllers/admin.controller.js';
import * as venueOwnerController from '../controllers/venueOwner.controller.js';
import { requireAuth, requireRole } from '../middlewares/auth.middleware.js';

const router = express.Router();

router.use(requireAuth, requireRole('admin'));

router.get('/owner-applications', venueOwnerController.listApplications);
router.post('/owner-applications/:userId/approve', venueOwnerController.approveApplication);
router.post('/owner-applications/:userId/reject', venueOwnerController.rejectApplication);

router.patch('/users/:userId', adminController.updateUser);

export default router;
