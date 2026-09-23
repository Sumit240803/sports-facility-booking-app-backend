import express from 'express';
// Ye * wildcard use karne se export error kabhi nahi aayega
import * as authController from '../controllers/auth.controller'; 

const router = express.Router();

router.post('/login-otp', authController.loginWithOTP);
router.get('/login-oauth', authController.loginWithOAuth);

export default router;