import express from 'express';
import * as bookingController from '../controllers/booking.controller.js';
import * as engagementController from '../controllers/engagement.controller.js';
import * as meController from '../controllers/me.controller.js';
import * as paymentController from '../controllers/payment.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';

// Current user's reminders, notifications and devices
const router = express.Router();

router.use(requireAuth);

router.get('/bookings', bookingController.myBookings);
router.get('/bookings/:id', bookingController.myBooking);
router.post('/bookings/:id/cancel', bookingController.cancelMine);
router.post('/bookings/:id/pay', paymentController.startPayment);
router.post('/bookings/:id/pay/verify', paymentController.verifyPayment);

router.get('/reviews', engagementController.myReviews);
router.put('/reviews/:venueId', engagementController.upsertReview);
router.delete('/reviews/:venueId', engagementController.deleteReview);

router.get('/favourites', engagementController.myFavourites);
router.put('/favourites/:venueId', engagementController.saveFavourite);
router.delete('/favourites/:venueId', engagementController.unsaveFavourite);

router.get('/reminders', meController.getReminders);
router.post('/reminders', meController.addReminder);
router.delete('/reminders/:id', meController.deleteReminder);

router.get('/notifications', meController.getNotifications);
router.post('/notifications/read-all', meController.readAllNotifications);
router.post('/notifications/:id/read', meController.readNotification);

router.post('/push-tokens', meController.addPushToken);
router.delete('/push-tokens', meController.deletePushToken);

export default router;
