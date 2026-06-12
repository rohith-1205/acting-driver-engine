// Matching Service: scores and ranks eligible acting drivers for trips based on distance, experience, ratings, and vehicle compatibility.
const mongoose = require('mongoose');
const Driver = require('../models/Driver');
const Trip = require('../models/Trip');
const driverLocationService = require('./driverLocationService');
const redisStateService = require('./redisStateService');
const tripService = require('./tripService');
const { MATCHING_CONFIG, MATCH_EVENTS } = require('../utils/constants');
const logger = require('../utils/logger');
const envConfig = require('../config/env');

function haversineDistanceKm(coord1, coord2) {
  const toRad = d => (d * Math.PI) / 180;
  const [lon1, lat1] = coord1;
  const [lon2, lat2] = coord2;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Compiles scoring reason codes based on matching rules.
 * @param {Object} driver - Driver document
 * @param {number} distanceKm - Distance in km
 * @param {Object} trip - Trip document
 * @returns {string[]}
 */
const getScoringReasonCodes = (driver, distanceKm, trip) => {
  const reasons = [];

  // 1. Distance / ETA
  const eta = Math.ceil((distanceKm / 20) * 60);
  reasons.push(`ETA_${eta.toFixed(1)}MIN`);

  // 2. Rating
  const rating = driver.ratingData ? driver.ratingData.currentrating : undefined;
  if (rating !== undefined && rating !== null) {
    if (rating >= 4.0) {
      reasons.push('GOOD_RATING');
    } else if (rating < 3.5) {
      reasons.push('POOR_RATING');
    }
  }

  // 3. Vehicle handling match
  const vehicleHandling = driver.experience && driver.experience.vehicleHandling;
  if (Array.isArray(vehicleHandling) && vehicleHandling.includes(trip.vehicleType)) {
    reasons.push('VEHICLE_HANDLING_MATCH');
  }

  // 4. Platform Experience tenure
  const totalExp = driver.experience && driver.experience.totalExperience;
  if (totalExp === '3+' || totalExp === '5+') {
    reasons.push('HIGH_EXPERIENCE');
  }

  // 5. Night driving capability match
  if (trip.nightRide === true && driver.experience && driver.experience.nightDriving === true) {
    reasons.push('NIGHT_DRIVING_MATCH');
  }

  // 6. Acceptance / Rejection rates
  const accepted = driver.totalTripsAccepted || 0;
  const rejected = driver.totalTripsRejected || 0;
  const totalTrips = accepted + rejected;
  if (totalTrips > 0) {
    const ratio = accepted / totalTrips;
    if (ratio >= 0.5) {
      reasons.push('GOOD_ACCEPTANCE_RATE');
    } else if (ratio < 0.3) {
      reasons.push('LOW_ACCEPTANCE_RATE');
    }
  } else {
    reasons.push('NO_ABUSE_DETECTED');
  }

  return reasons;
};

/**
 * Scores a driver based on multiple dimensions (distance, rating, vehicle compatibility, etc.)
 * @param {Object} driver - Driver document
 * @param {number} distanceKm - Distance from trip start to driver location
 * @param {Object} trip - Trip document
 * @returns {number} - Clamped score between 0 and 100
 */
const scoreDriver = (driver, distanceKm, trip) => {
  const {
    scoreWeightDistance,
    scoreWeightRating,
    scoreWeightVehicleMatch,
    scoreWeightExperience,
    scoreWeightNightDriving,
    scoreWeightLongDistance,
    scoreWeightAcceptanceRate
  } = envConfig.matching;

  // 1. Distance score
  let distanceScore = 0;
  if (distanceKm <= 2) {
    distanceScore = 1.0;
  } else if (distanceKm <= 5) {
    distanceScore = 0.75;
  } else if (distanceKm <= 8) {
    distanceScore = 0.50;
  } else if (distanceKm <= 10) {
    distanceScore = 0.25;
  } else {
    distanceScore = 0.0;
  }
  const distancePoints = distanceScore * scoreWeightDistance;

  // 2. Rating score
  let ratingScore = 0;
  const rating = driver.ratingData ? driver.ratingData.currentrating : undefined;
  if (rating !== undefined && rating !== null) {
    if (rating >= 4.5) {
      ratingScore = 1.0;
    } else if (rating >= 4.0) {
      ratingScore = 0.75;
    } else if (rating >= 3.5) {
      ratingScore = 0.50;
    } else {
      ratingScore = 0.0;
    }
  } else {
    ratingScore = 0.75; // Default to neutral standing if rating is missing
  }
  const ratingPoints = ratingScore * scoreWeightRating;

  // 3. Vehicle handling compatibility score
  let vehicleMatchScore = 0;
  const vehicleHandling = driver.experience && driver.experience.vehicleHandling;
  if (Array.isArray(vehicleHandling) && vehicleHandling.includes(trip.vehicleType)) {
    vehicleMatchScore = 1.0;
  }
  const vehiclePoints = vehicleMatchScore * scoreWeightVehicleMatch;

  // 4. Platform experience score (tenure)
  let experienceScore = 0;
  const totalExp = driver.experience && driver.experience.totalExperience;
  if (totalExp === "3+" || totalExp === "5+") {
    experienceScore = 1.0;
  } else if (totalExp === "1-3") {
    experienceScore = 0.5;
  }
  const experiencePoints = experienceScore * scoreWeightExperience;

  // 5. Night driving capability score
  let nightDrivingScore = 1.0;
  if (trip.nightRide === true) {
    const nightDriving = driver.experience && driver.experience.nightDriving;
    nightDrivingScore = (nightDriving === true) ? 1.0 : 0.0;
  }
  const nightDrivingPoints = nightDrivingScore * scoreWeightNightDriving;

  // 6. Long distance capability score
  let longDistanceScore = 1.0;
  const estDist = parseFloat(trip.estimatedDistance) || 0;
  if (estDist > 50) {
    const longDistance = driver.experience && driver.experience.longDistance;
    longDistanceScore = (longDistance === true) ? 1.0 : 0.0;
  }
  const longDistancePoints = longDistanceScore * scoreWeightLongDistance;

  // 7. Acceptance rate score
  let acceptanceScore = 1.0;
  const accepted = driver.totalTripsAccepted || 0;
  const rejected = driver.totalTripsRejected || 0;
  const totalTrips = accepted + rejected;
  if (totalTrips > 0) {
    const ratio = accepted / totalTrips;
    if (ratio >= 0.5) {
      acceptanceScore = 1.0;
    } else if (ratio >= 0.3) {
      acceptanceScore = 0.5;
    } else {
      acceptanceScore = 0.0;
    }
  }
  const acceptancePoints = acceptanceScore * scoreWeightAcceptanceRate;

  // Compute final score
  const score = distancePoints
              + ratingPoints
              + vehiclePoints
              + experiencePoints
              + nightDrivingPoints
              + longDistancePoints
              + acceptancePoints;

  return Math.max(0, Math.min(100, score));
};

/**
 * Core engine logic to filter and rank drivers eligible for a trip.
 * @param {Object} trip - MongoDB Trip document
 * @param {number} attempt - Current match attempt count
 * @returns {Promise<Array<{ driverId: string, score: number, distanceKm: number, eta: number }>>}
 */
const findEligibleDrivers = async (trip, attempt) => {
  const tripIdStr = trip._id.toString();
  logger.info(`Starting findEligibleDrivers for trip ${tripIdStr}, attempt ${attempt}`);

  // STEP 1 — Get excluded drivers from Redis
  const excludedDrivers = await redisStateService.getExcludedDrivers(tripIdStr);

  // STEP 2 — Geo search for nearby drivers
  const [lon, lat] = trip.startLocation;
  const radius = MATCHING_CONFIG.SEARCH_RADIUS_KM || 10;
  const candidateList = await driverLocationService.findNearbyDrivers(lon, lat, radius, trip.regionCode);

  // STEP 3 — Remove excluded drivers from candidates
  const filteredCandidates = candidateList.filter(candidate => !excludedDrivers.has(candidate.driverId));

  // STEP 4 — If fewer than 1 candidate remains, log empty sets and return empty list
  if (filteredCandidates.length === 0) {
    logger.info(`No candidates after exclusion for trip ${tripIdStr} attempt ${attempt}`);
    const availableDriversLog = {
      timestamp: Date.now(),
      event: 'available_drivers',
      driver_count: 0,
      drivers: []
    };
    const rankedDriversLog = {
      timestamp: Date.now(),
      event: 'ranked_drivers',
      candidate_count: 0,
      top_drivers: []
    };
    if (mongoose.Types.ObjectId.isValid(tripIdStr)) {
      try {
        await tripService.appendMatchLog(tripIdStr, [availableDriversLog, rankedDriversLog]);
      } catch (err) {
        logger.error(`Failed to append match logs for trip ${tripIdStr}: ${err.message}`);
      }
    }
    return [];
  }

  // STEP 5 — Fetch full driver documents from MongoDB
  const candidateIds = filteredCandidates
    .map(c => c.driverId)
    .filter(id => mongoose.Types.ObjectId.isValid(id));
  const driverDocs = await Driver.find({ _id: { $in: candidateIds } });
  
  // Map candidate objects by driverId for fast lookup
  const candidateDistanceMap = new Map(filteredCandidates.map(c => [c.driverId, c.distanceKm]));
  const eligibleShortlist = [];

  // STEP 6 — Apply eligibility filters
  driverLoop: for (const driver of driverDocs) {
    const id = driver._id.toString();
    const distanceKm = candidateDistanceMap.get(id);

    // Filter A — isApproved check
    if (driver.isApproved !== true) {
      logger.info(`Driver ${id} failed: not approved`);
      continue;
    }

    // Filter B — isAvailable check
    if (driver.isAvailable !== true) {
      logger.info(`Driver ${id} failed: not available`);
      continue;
    }

    // Filter C — isBlocked check
    if (driver.isBlocked === true) {
      logger.info(`Driver ${id} failed: is blocked`);
      continue;
    }

    // Filter D — isDeleted check
    if (driver.isDeleted === true) {
      logger.info(`Driver ${id} failed: is deleted`);
      continue;
    }

    // Filter E — Online status check
    const status = driver.driverStatus && driver.driverStatus.status;
    if (status !== 'online') {
      logger.info(`Driver ${id} failed: status is ${status || 'undefined'}`);
      continue;
    }

    // Filter F — Trip status check
    if (driver.tripStatus !== 'NOTRIP') {
      logger.info(`Driver ${id} failed: tripStatus is ${driver.tripStatus}`);
      continue;
    }

    // Filter G — Role check
    const hasRole = driver.role === 'acting_driver';
    const hasMode = Array.isArray(driver.mode) && driver.mode.includes('acting_driver');
    if (!hasRole && !hasMode) {
      logger.info(`Driver ${id} failed: not an acting driver`);
      continue;
    }

    // Filter H — Vehicle type compatibility check
    const vehicleTypes = driver.experience && driver.experience.vehicleTypes;
    if (!Array.isArray(vehicleTypes) || !vehicleTypes.includes(trip.vehicleType)) {
      logger.info(`Driver ${id} failed: vehicle type ${trip.vehicleType} not in experience`);
      continue;
    }

    // Filter I — Active trip check (Redis check)
    const redisMeta = await driverLocationService.getDriverMeta(id);
    if (redisMeta && redisMeta.tripStatus === 'ONTRIP') {
      logger.info(`Driver ${id} failed: Redis meta shows ONTRIP`);
      continue;
    }

    // Filter J — Calendar conflict check (scheduled trips only)
    if (trip.isScheduledTrip && trip.scheduleDateTime) {
      const upcomingTrips = await Trip.find({
        _id: { $in: driver.upComingTrips },
        status: { $in: ["PENDING", "ACCEPTED", "MATCHING"] }
      });

      const {
        platformMinimumBufferMs,
        defaultBufferMs,
        maxBufferMs,
        averageSpeedKmph
      } = envConfig.matching;

      const driverBufferMs = (driver.calendarBufferMinutes || 0) * 60000;
      const effectiveBuffer = Math.min(
        Math.max(driverBufferMs || defaultBufferMs, platformMinimumBufferMs),
        maxBufferMs
      );

      for (const upTrip of upcomingTrips) {
        const existingTripDurationMs = (parseFloat(upTrip.estimatedDuration) || 0) * 60000;

        // Travel time from existing trip's drop-off to new trip's pickup
        const travelDistanceKm = haversineDistanceKm(upTrip.endLocation, trip.startLocation);
        const travelTimeMs = (travelDistanceKm / averageSpeedKmph) * 60 * 60 * 1000;

        const existingTripEnd = upTrip.scheduleDateTime
                              + existingTripDurationMs
                              + travelTimeMs
                              + effectiveBuffer;

        if (existingTripEnd > trip.scheduleDateTime) {
          logger.info(
            `Driver ${driver._id} failed: calendar conflict — ` +
            `existing trip ends at ${new Date(upTrip.scheduleDateTime + existingTripDurationMs).toISOString()}, ` +
            `travel time ${Math.round(travelDistanceKm)}km / ${Math.round(travelTimeMs/60000)}min, ` +
            `buffer ${Math.round(effectiveBuffer/3600000)}h, ` +
            `ready at ${new Date(existingTripEnd).toISOString()}, ` +
            `new trip starts at ${new Date(trip.scheduleDateTime).toISOString()}`
          );
          continue driverLoop;
        }
      }
    }

    // Passed all filters
    eligibleShortlist.push({ driver, distanceKm });
  }

  // STEP 7 — Score remaining eligible drivers
  const scoredDrivers = eligibleShortlist.map(({ driver, distanceKm }) => {
    const score = scoreDriver(driver, distanceKm, trip);
    return {
      driverId: driver._id.toString(),
      score,
      distanceKm
    };
  });

  // STEP 8 — Sort by score descending
  scoredDrivers.sort((a, b) => b.score - a.score);

  // STEP 9 — Take top SHORTLIST_SIZE (5) drivers
  const limitSize = MATCHING_CONFIG.SHORTLIST_SIZE || 5;
  const topCandidates = scoredDrivers.slice(0, limitSize);

  // STEP 10 — Estimate ETA for each shortlisted driver
  const shortlist = topCandidates.map(candidate => {
    const eta = Math.max(1, Math.min(30, Math.ceil((candidate.distanceKm / 20) * 60)));
    return {
      driverId: candidate.driverId,
      score: candidate.score,
      distanceKm: parseFloat(candidate.distanceKm.toFixed(2)),
      eta
    };
  });

  // STEP 10.5 — Append available_drivers and ranked_drivers logs to MongoDB
  const availableDriversLog = {
    timestamp: Date.now(),
    event: 'available_drivers',
    driver_count: driverDocs.length,
    drivers: driverDocs.map(d => ({
      driver_id: d._id.toString(),
      totalTripsRejected: d.totalTripsRejected,
      lastTripTime: d.lastTripTime,
      totalTripsAccepted: d.totalTripsAccepted,
      isAvailable: d.isAvailable,
      location: d.location
    }))
  };

  const rankedDriversLog = {
    timestamp: Date.now(),
    event: 'ranked_drivers',
    candidate_count: scoredDrivers.length,
    top_drivers: scoredDrivers.map((candidate, idx) => {
      const driverDoc = driverDocs.find(d => d._id.toString() === candidate.driverId);
      const reasonCodes = getScoringReasonCodes(driverDoc, candidate.distanceKm, trip);
      return {
        rank: idx + 1,
        driver_id: candidate.driverId,
        total_score: candidate.score,
        reason_codes: reasonCodes
      };
    })
  };

  if (mongoose.Types.ObjectId.isValid(tripIdStr)) {
    try {
      await tripService.appendMatchLog(tripIdStr, [availableDriversLog, rankedDriversLog]);
    } catch (err) {
      logger.error(`Failed to append match logs for trip ${tripIdStr}: ${err.message}`);
    }
  }

  // STEP 11 — Return final shortlist
  logger.info(`Matching search returned ${shortlist.length} drivers for trip ${tripIdStr}`);
  return shortlist;
};

/**
 * Builds a rideMatchLog entry object.
 * @param {string} event - Event type description
 * @param {string} driverId - Database driver ID
 * @param {Object} [extras] - Optional matching metadata
 * @returns {Object} - Formatted rideMatchLog object
 */
const buildMatchLog = (event, driverId, extras = {}) => {
  return {
    event,
    driver_id: driverId ? String(driverId) : null,
    timestamp: Date.now(),
    ...extras
  };
};

module.exports = {
  findEligibleDrivers,
  buildMatchLog
};
