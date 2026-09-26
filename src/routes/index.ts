import express from 'express';
import authRoutes from './auth.routes.js';
import adminRoutes from './admin.routes.js';
import { amenitiesRoutes, sportsRoutes } from './catalog.routes.js';
import venueRoutes from './venue.routes.js';
import venueOwnerRoutes from './venueOwner.routes.js';

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/owner-applications', venueOwnerRoutes);
router.use('/admin', adminRoutes);
router.use('/sports', sportsRoutes);
router.use('/amenities', amenitiesRoutes);
router.use('/venues', venueRoutes);

export default router;
