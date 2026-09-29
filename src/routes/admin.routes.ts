import express from 'express';
import * as adminController from '../controllers/admin.controller.js';
import * as catalogController from '../controllers/catalog.controller.js';
import * as engagementController from '../controllers/engagement.controller.js';
import * as payoutController from '../controllers/payout.controller.js';
import * as venueController from '../controllers/venue.controller.js';
import * as venueOwnerController from '../controllers/venueOwner.controller.js';
import { requireAuth, requireRole, requireVenueAccess } from '../middlewares/auth.middleware.js';

const router = express.Router();

router.use(requireAuth, requireRole('admin'));

router.get('/owner-applications', venueOwnerController.listApplications);
router.post('/owner-applications/:userId/approve', venueOwnerController.approveApplication);
router.post('/owner-applications/:userId/reject', venueOwnerController.rejectApplication);

router.get('/users', adminController.listUsersHandler);
router.patch('/users/:userId', adminController.updateUser);

router.get('/venues', venueController.adminList);
router.post('/venues/:venueId/approve', requireVenueAccess(), venueController.adminAction('approve'));
router.post('/venues/:venueId/reject', requireVenueAccess(), venueController.adminAction('reject'));
router.post('/venues/:venueId/suspend', requireVenueAccess(), venueController.adminAction('suspend'));
router.post('/venues/:venueId/reinstate', requireVenueAccess(), venueController.adminAction('reinstate'));

router.get('/dashboard', engagementController.platformDashboard);
router.get('/reviews', engagementController.adminReviews);
router.post('/reviews/:reviewId/hide', engagementController.hideReview);
router.post('/reviews/:reviewId/unhide', engagementController.unhideReview);

router.get('/payouts/balances', payoutController.balances);
router.get('/payouts', payoutController.adminPayouts);
router.post('/payouts/:payoutId/resolve', payoutController.resolvePayout);
router.get('/venues/:venueId/payout-settings', requireVenueAccess(), payoutController.adminGetSettings);
router.put('/venues/:venueId/payout-settings', requireVenueAccess(), payoutController.adminSetLinkedAccount);
router.post('/venues/:venueId/payouts', requireVenueAccess(), payoutController.createManualPayout);
router.post('/venues/:venueId/adjustments', requireVenueAccess(), payoutController.createAdjustment);
router.get('/refunds', payoutController.adminRefunds);
router.post('/refunds/:refundId/retry', payoutController.adminRetryRefund);

for (const table of ['sports', 'amenities'] as const) {
    router.get(`/${table}`, catalogController.listAll(table));
    router.post(`/${table}`, catalogController.create(table));
    router.patch(`/${table}/:id`, catalogController.update(table));
}

export default router;
