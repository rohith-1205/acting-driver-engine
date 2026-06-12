// Trip Controller: handles HTTP request-response flow for trip CRUD operations and triggers matching workflows.
const mongoose = require('mongoose');
const Trip = require('../../models/Trip');
const redisStateService = require('../../services/redisStateService');
const rideIdGenerator = require('../../utils/rideIdGenerator');
const logger = require('../../utils/logger');

/**
 * Ingestion controller to book a new trip.
 * Endpoint: POST /api/v2/trips/book
 */
const bookTrip = async (req, res) => {
  const { startLocation, endLocation, vehicleType, userId, isScheduledTrip, scheduleDateTime } = req.body;

  logger.info('TripController: Processing trip booking request', { userId, vehicleType });

  // 1. Validate incoming payload bounds checking mandatory variable properties definitions
  if (!startLocation || !Array.isArray(startLocation) || startLocation.length !== 2) {
    return res.status(400).json({ error: 'Mandatory field startLocation is missing or invalid. Must be [longitude, latitude].' });
  }

  if (!endLocation || !Array.isArray(endLocation) || endLocation.length !== 2) {
    return res.status(400).json({ error: 'Mandatory field endLocation is missing or invalid. Must be [longitude, latitude].' });
  }

  if (!vehicleType || typeof vehicleType !== 'string') {
    return res.status(400).json({ error: 'Mandatory field vehicleType is missing or invalid.' });
  }

  if (!userId || typeof userId !== 'string') {
    return res.status(400).json({ error: 'Mandatory field userId is missing or invalid.' });
  }

  if (isScheduledTrip === true && !scheduleDateTime) {
    return res.status(400).json({ error: 'Mandatory field scheduleDateTime is missing for a scheduled trip.' });
  }

  try {
    // 2. Generate a valid Acting Driver ID reference
    const rideId = rideIdGenerator.generateActingDriverRideId("CMR");

    // 3. Instantiate a new database model instance setting status strictly to "PENDING" and isActingDriverTrip: true
    const tripData = {
      rideId,
      isActingDriverTrip: true,
      isScheduledTrip: !!isScheduledTrip,
      status: 'PENDING',
      vehicleType,
      userId,
      passangerId: req.body.passangerId ? new mongoose.Types.ObjectId(req.body.passangerId) : new mongoose.Types.ObjectId(),
      createdBy: req.body.createdBy || 'passenger_api',
      startLocation,
      endLocation,
      bookingTime: Date.now(),
      regionCode: req.body.regionCode || 'CMR'
    };

    if (isScheduledTrip === true) {
      tripData.scheduleDateTime = Number(scheduleDateTime);
    }

    const trip = new Trip(tripData);
    await trip.save();

    const tripId = trip._id.toString();

    // 4. Evaluate scheduling parameter context rules
    if (!isScheduledTrip) {
      // Case A: Immediate Booking (isScheduledTrip: false)
      await redisStateService.addTripToScheduler(tripId, Date.now());
      logger.info(`TripController: Immediate trip ${tripId} added to scheduler.`);
    } else {
      // Case B: Scheduled Booking (isScheduledTrip: true)
      const score = Number(scheduleDateTime);
      await redisStateService.addTripToScheduler(tripId, score);
      logger.info(`TripController: Scheduled trip ${tripId} added to scheduler at score ${score}.`);
    }

    // 5. Return a 211 Created server response carrying the finalized payload objects structure
    return res.status(211).json({
      success: true,
      trip
    });

  } catch (err) {
    logger.error(`TripController: Error during trip booking: ${err.message}`, { error: err });
    return res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
};

module.exports = {
  bookTrip
};
