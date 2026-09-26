import express from 'express';
import * as catalogController from '../controllers/catalog.controller.js';

// Public reference data
export const sportsRoutes = express.Router().get('/', catalogController.listPublic('sports'));
export const amenitiesRoutes = express.Router().get('/', catalogController.listPublic('amenities'));
