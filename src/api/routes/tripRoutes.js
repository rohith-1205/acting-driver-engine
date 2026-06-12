// Trip Routes: defines API endpoints for managing acting driver trips.
const express = require('express');
const router = express.Router();
const tripController = require('../controllers/tripController');

router.post('/book', tripController.bookTrip);

module.exports = router;
