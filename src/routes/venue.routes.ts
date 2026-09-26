import express from 'express';
import * as courtController from '../controllers/court.controller.js';
import * as photoController from '../controllers/venuePhoto.controller.js';
import * as venueController from '../controllers/venue.controller.js';
import { requireAuth, requireRole, requireVenueAccess } from '../middlewares/auth.middleware.js';
import venueStaffRoutes from './venueStaff.routes.js';

const router = express.Router();

// Access levels for /:venueId routes (admins always pass)
const ownerOnly = [requireAuth, requireVenueAccess()];
const anyStaff = [requireAuth, requireVenueAccess('manager', 'staff')];

// Public browse
router.get('/', venueController.search);
router.get('/cities', venueController.cities);

// Owner
router.get('/mine', requireAuth, venueController.mine);
router.post('/', requireAuth, requireRole('venue_owner', 'admin'), venueController.create);

router.get('/:venueId/manage', ...anyStaff, venueController.getManaged);
router.patch('/:venueId', ...ownerOnly, venueController.update);
router.delete('/:venueId', ...ownerOnly, venueController.remove);
router.post('/:venueId/submit', ...ownerOnly, venueController.ownerAction('submit'));
router.post('/:venueId/unpublish', ...ownerOnly, venueController.ownerAction('unpublish'));

// Courts
router.get('/:venueId/courts', ...anyStaff, courtController.list);
router.post('/:venueId/courts', ...ownerOnly, courtController.create);
router.patch('/:venueId/courts/:courtId', ...ownerOnly, courtController.update);
router.delete('/:venueId/courts/:courtId', ...ownerOnly, courtController.remove);

// Photos
router.get('/:venueId/photos', ...anyStaff, photoController.list);
router.post('/:venueId/photos', ...ownerOnly, photoController.receivePhoto, photoController.create);
router.put('/:venueId/photos/order', ...ownerOnly, photoController.reorder);
router.put('/:venueId/photos/:photoId/cover', ...ownerOnly, photoController.makeCover);
router.delete('/:venueId/photos/:photoId', ...ownerOnly, photoController.remove);

// Staff
router.use('/:venueId/staff', venueStaffRoutes);

// Public venue page by id or slug (keep last so it doesn't shadow the routes above)
router.get('/:idOrSlug', venueController.getPublic);

export default router;
