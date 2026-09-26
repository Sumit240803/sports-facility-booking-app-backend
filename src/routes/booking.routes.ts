import express from 'express';
import { rateLimit } from 'express-rate-limit';
import * as bookingController from '../controllers/booking.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';

const router = express.Router();

// Per-user limit on booking attempts (per server instance)
const bookingLimiter = rateLimit({
    windowMs: 60_000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => req.user!.id,
    message: { error: 'Too many booking attempts, please wait a minute' },
});

router.use(requireAuth);

router.post('/quote', bookingLimiter, bookingController.quote);
router.post('/', bookingLimiter, bookingController.create);

export default router;
