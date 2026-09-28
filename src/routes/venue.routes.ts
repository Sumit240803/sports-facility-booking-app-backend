import express from 'express';
import * as bookingController from '../controllers/booking.controller.js';
import * as courtController from '../controllers/court.controller.js';
import * as engagementController from '../controllers/engagement.controller.js';
import * as payoutController from '../controllers/payout.controller.js';
import * as scheduleController from '../controllers/schedule.controller.js';
import * as photoController from '../controllers/venuePhoto.controller.js';
import * as venueController from '../controllers/venue.controller.js';
import { optionalAuth, requireAuth, requireRole, requireVenueAccess } from '../middlewares/auth.middleware.js';
import venueStaffRoutes from './venueStaff.routes.js';

const router = express.Router();

// Access levels for /:venueId routes (the owner and admins always pass)
const ownerOnly = [requireAuth, requireVenueAccess()];
const managers = [requireAuth, requireVenueAccess('manager')];
const anyStaff = [requireAuth, requireVenueAccess('manager', 'staff')];

// Public browse
router.get('/', venueController.search);
router.get('/cities', venueController.cities);

// Owner
router.get('/mine', requireAuth, venueController.mine);
router.post('/', requireAuth, requireRole('venue_owner', 'admin'), venueController.create);

router.get('/:venueId/manage', ...anyStaff, venueController.getManaged);
router.get('/:venueId/manage/availability', ...anyStaff, scheduleController.manageAvailability);
router.patch('/:venueId', ...managers, venueController.update);
router.delete('/:venueId', ...ownerOnly, venueController.remove);
router.post('/:venueId/submit', ...ownerOnly, venueController.ownerAction('submit'));
router.post('/:venueId/unpublish', ...ownerOnly, venueController.ownerAction('unpublish'));

// Opening hours
router.get('/:venueId/hours', ...anyStaff, scheduleController.getHours);
router.put('/:venueId/hours', ...managers, scheduleController.putVenueHours);

// Courts
router.get('/:venueId/courts', ...anyStaff, courtController.list);
router.post('/:venueId/courts', ...managers, courtController.create);
router.patch('/:venueId/courts/:courtId', ...managers, courtController.update);
router.delete('/:venueId/courts/:courtId', ...managers, courtController.remove);
router.put('/:venueId/courts/:courtId/hours', ...managers, scheduleController.putCourtHours);
router.delete('/:venueId/courts/:courtId/hours', ...managers, scheduleController.deleteCourtHours);
router.get('/:venueId/courts/:courtId/pricing', ...anyStaff, scheduleController.getPricing);
router.put('/:venueId/courts/:courtId/pricing', ...managers, scheduleController.putPricing);

// Blocks / closures (all staff handle day-to-day operations)
router.get('/:venueId/blocks', ...anyStaff, scheduleController.getBlocks);
router.post('/:venueId/blocks', ...anyStaff, scheduleController.postBlock);
router.delete('/:venueId/blocks/:blockId', ...anyStaff, scheduleController.removeBlock);

// Bookings (front desk)
router.get('/:venueId/bookings', ...anyStaff, bookingController.venueBookings);
router.post('/:venueId/bookings', ...anyStaff, bookingController.createOffline);
router.get('/:venueId/bookings/by-reference/:reference', ...anyStaff, bookingController.venueBookingByReference);
router.get('/:venueId/bookings/:bookingId', ...anyStaff, bookingController.venueBooking);
router.post('/:venueId/bookings/:bookingId/check-in', ...anyStaff, bookingController.checkIn);
router.post('/:venueId/bookings/:bookingId/collect', ...anyStaff, bookingController.collect);
router.post('/:venueId/bookings/:bookingId/no-show', ...anyStaff, bookingController.noShow);
router.post('/:venueId/bookings/:bookingId/undo-no-show', ...anyStaff, bookingController.undoNoShowBooking);
router.post('/:venueId/bookings/:bookingId/cancel', ...managers, bookingController.cancelByVenue);

// Photos
router.get('/:venueId/photos', ...anyStaff, photoController.list);
router.post('/:venueId/photos', ...managers, photoController.receivePhoto, photoController.create);
router.put('/:venueId/photos/order', ...managers, photoController.reorder);
router.put('/:venueId/photos/:photoId/cover', ...managers, photoController.makeCover);
router.delete('/:venueId/photos/:photoId', ...managers, photoController.remove);

// Reviews (venue team)
router.get('/:venueId/manage/reviews', ...anyStaff, engagementController.manageReviews);
router.put('/:venueId/reviews/:reviewId/reply', ...managers, engagementController.replyToReview);
router.delete('/:venueId/reviews/:reviewId/reply', ...managers, engagementController.deleteReply);

// Dashboard (owner only)
router.get('/:venueId/dashboard', ...ownerOnly, engagementController.ownerDashboard);

// Earnings & payouts (owner only)
router.get('/:venueId/earnings', ...ownerOnly, payoutController.earnings);
router.get('/:venueId/payout-settings', ...ownerOnly, payoutController.getSettings);
router.put('/:venueId/payout-settings', ...ownerOnly, payoutController.putSettings);

// Staff (owner only)
router.use('/:venueId/staff', venueStaffRoutes);

// Public venue page and availability by id or slug (keep last so they don't shadow the routes above)
router.get('/:idOrSlug/availability', scheduleController.publicAvailability);
router.get('/:idOrSlug/reviews', engagementController.venueReviews);
router.get('/:idOrSlug', optionalAuth, venueController.getPublic);

export default router;
