import express from 'express';
import * as venueOwnerController from '../controllers/venueOwner.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';

const router = express.Router();

router.use(requireAuth);

router.post('/me', venueOwnerController.applyAsOwner);
router.get('/me', venueOwnerController.getMyApplication);

export default router;
