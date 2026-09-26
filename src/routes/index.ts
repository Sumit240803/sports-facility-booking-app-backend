import express from 'express';
import authRoutes from './auth.routes.js';
import adminRoutes from './admin.routes.js';
import venueOwnerRoutes from './venueOwner.routes.js';
import venueStaffRoutes from './venueStaff.routes.js';

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/owner-applications', venueOwnerRoutes);
router.use('/admin', adminRoutes);
router.use('/venues/:venueId/staff', venueStaffRoutes);

export default router;
