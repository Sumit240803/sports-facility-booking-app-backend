import express from 'express';
import * as authController from '../controllers/auth.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';

const router = express.Router();

// Callback must be registered before /:provider so it isn't treated as a provider name
router.get('/oauth/callback', authController.oauthCallback);
router.get('/oauth/:provider', authController.startOAuth);

router.get('/google/config', authController.googleConfig);
router.post('/google/token', authController.googleIdTokenSignIn);

router.post('/refresh', authController.refreshSession);
router.post('/logout', requireAuth, authController.logout);

router.get('/me', requireAuth, authController.getMe);
router.patch('/me', requireAuth, authController.updateMe);

export default router;
