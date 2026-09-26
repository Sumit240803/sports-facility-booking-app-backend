import express from 'express';
import * as venueStaffController from '../controllers/venueStaff.controller.js';
import { requireAuth, requireVenueAccess } from '../middlewares/auth.middleware.js';

// Mounted at /venues/:venueId/staff
const router = express.Router({ mergeParams: true });

router.use(requireAuth);

// Managers can see the team; only the owner (or an admin) can change it
router.get('/', requireVenueAccess('manager'), venueStaffController.listStaff);
router.post('/', requireVenueAccess(), venueStaffController.inviteStaff);
router.delete('/invites/:email', requireVenueAccess(), venueStaffController.cancelInvite);
router.patch('/:userId', requireVenueAccess(), venueStaffController.changeStaffRole);
router.delete('/:userId', requireVenueAccess(), venueStaffController.removeStaff);

export default router;
