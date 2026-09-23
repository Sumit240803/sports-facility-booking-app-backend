import express from 'express';
import { supabase } from '../lib/supabase';

export const loginWithOTP = async (req: express.Request, res: express.Response): Promise<void> => {
    const { email } = req.body;
    const { data, error } = await supabase.auth.signInWithOtp({ email });
    if (error) { res.status(400).json({ error: error.message }); return; }
    res.status(200).json({ message: 'OTP sent!', data });
};

export const loginWithOAuth = async (req: express.Request, res: express.Response): Promise<void> => {
    const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: 'http://localhost:3000' }
    });
    if (error) { res.status(400).json({ error: error.message }); return; }
    res.status(200).json({ provider_url: data.url }); 
};