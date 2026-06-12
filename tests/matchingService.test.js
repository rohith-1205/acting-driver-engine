// Unit Tests for Matching Service: verifies eligibility filtering, driver scoring, log shapes, and ride ID formatting.
const matchingService = require('../src/services/matchingService');
const driverLocationService = require('../src/services/driverLocationService');
const redisStateService = require('../src/services/redisStateService');
const Driver = require('../src/models/Driver');
const Trip = require('../src/models/Trip');
const { generateActingDriverRideId } = require('../src/utils/rideIdGenerator');

// Mock services and models
jest.mock('../src/services/driverLocationService');
jest.mock('../src/services/redisStateService');
jest.mock('../src/models/Driver');
jest.mock('../src/models/Trip');

describe('Matching Service & Utilities Unit Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // TEST 1 — scoreDriver: perfect driver scores near 100
  test('scoreDriver: perfect driver scores near 100', async () => {
    // Setup
    const trip = {
      _id: 'trip123',
      startLocation: [77.0, 11.0],
      regionCode: 'CMR',
      vehicleType: 'sedan',
      estimatedDistance: 10,
      isScheduledTrip: false
    };

    const mockDriver = {
      _id: 'perfect_driver',
      isApproved: true,
      isAvailable: true,
      isBlocked: false,
      isDeleted: false,
      driverStatus: { status: 'online' },
      tripStatus: 'NOTRIP',
      role: 'acting_driver',
      mode: ['acting_driver'],
      ratingData: { currentrating: 4.8 },
      experience: {
        vehicleTypes: ['sedan'],
        vehicleHandling: ['sedan'],
        totalExperience: '3+'
      },
      totalTripsAccepted: 10,
      totalTripsRejected: 2
    };

    redisStateService.getExcludedDrivers.mockResolvedValue(new Set());
    driverLocationService.findNearbyDrivers.mockResolvedValue([{ driverId: 'perfect_driver', distanceKm: 0.5 }]);
    Driver.find.mockResolvedValue([mockDriver]);
    driverLocationService.getDriverMeta.mockResolvedValue(null);

    // Act
    const shortlist = await matchingService.findEligibleDrivers(trip, 1);

    // Assert
    expect(shortlist).toHaveLength(1);
    expect(shortlist[0].driverId).toBe('perfect_driver');
    expect(shortlist[0].score).toBeGreaterThanOrEqual(90);
  });

  // TEST 2 — scoreDriver: poor driver scores low
  test('scoreDriver: poor driver scores low (high distance, low rating, penalty acceptance rate)', async () => {
    // Setup
    const trip = {
      _id: 'trip123',
      startLocation: [77.0, 11.0],
      regionCode: 'CMR',
      vehicleType: 'sedan',
      estimatedDistance: 10,
      isScheduledTrip: false
    };

    const mockDriver = {
      _id: 'poor_driver',
      isApproved: true,
      isAvailable: true,
      isBlocked: false,
      isDeleted: false,
      driverStatus: { status: 'online' },
      tripStatus: 'NOTRIP',
      role: 'acting_driver',
      ratingData: { currentrating: 2.5 },
      experience: {
        vehicleTypes: ['sedan'],
        vehicleHandling: ['hatchback'],
        totalExperience: '0-1'
      },
      totalTripsAccepted: 2,
      totalTripsRejected: 8 // ratio = 0.2
    };

    redisStateService.getExcludedDrivers.mockResolvedValue(new Set());
    driverLocationService.findNearbyDrivers.mockResolvedValue([{ driverId: 'poor_driver', distanceKm: 9.0 }]);
    Driver.find.mockResolvedValue([mockDriver]);
    driverLocationService.getDriverMeta.mockResolvedValue(null);

    // Act
    const shortlist = await matchingService.findEligibleDrivers(trip, 1);

    // Assert
    expect(shortlist).toHaveLength(1);
    expect(shortlist[0].score).toBeLessThanOrEqual(40);
  });

  // TEST 3 — findEligibleDrivers: filters out offline driver
  test('findEligibleDrivers: filters out offline driver', async () => {
    const trip = { _id: 'trip123', startLocation: [77.0, 11.0], regionCode: 'CMR', vehicleType: 'sedan' };
    const mockDriver = {
      _id: 'offline_driver',
      isApproved: true,
      isAvailable: true,
      driverStatus: { status: 'offline' },
      tripStatus: 'NOTRIP',
      role: 'acting_driver',
      experience: { vehicleTypes: ['sedan'] }
    };

    redisStateService.getExcludedDrivers.mockResolvedValue(new Set());
    driverLocationService.findNearbyDrivers.mockResolvedValue([{ driverId: 'offline_driver', distanceKm: 1.0 }]);
    Driver.find.mockResolvedValue([mockDriver]);
    driverLocationService.getDriverMeta.mockResolvedValue(null);

    const shortlist = await matchingService.findEligibleDrivers(trip, 1);
    expect(shortlist).toHaveLength(0);
  });

  // TEST 4 — findEligibleDrivers: filters out ONTRIP driver
  test('findEligibleDrivers: filters out ONTRIP driver', async () => {
    const trip = { _id: 'trip123', startLocation: [77.0, 11.0], regionCode: 'CMR', vehicleType: 'sedan' };
    const mockDriver = {
      _id: 'ontrip_driver',
      isApproved: true,
      isAvailable: true,
      driverStatus: { status: 'online' },
      tripStatus: 'ONTRIP',
      role: 'acting_driver',
      experience: { vehicleTypes: ['sedan'] }
    };

    redisStateService.getExcludedDrivers.mockResolvedValue(new Set());
    driverLocationService.findNearbyDrivers.mockResolvedValue([{ driverId: 'ontrip_driver', distanceKm: 1.0 }]);
    Driver.find.mockResolvedValue([mockDriver]);
    driverLocationService.getDriverMeta.mockResolvedValue(null);

    const shortlist = await matchingService.findEligibleDrivers(trip, 1);
    expect(shortlist).toHaveLength(0);
  });

  // TEST 5 — findEligibleDrivers: filters out wrong vehicle type
  test('findEligibleDrivers: filters out wrong vehicle type', async () => {
    const trip = { _id: 'trip123', startLocation: [77.0, 11.0], regionCode: 'CMR', vehicleType: 'suv' };
    const mockDriver = {
      _id: 'sedan_driver',
      isApproved: true,
      isAvailable: true,
      driverStatus: { status: 'online' },
      tripStatus: 'NOTRIP',
      role: 'acting_driver',
      experience: { vehicleTypes: ['sedan'] }
    };

    redisStateService.getExcludedDrivers.mockResolvedValue(new Set());
    driverLocationService.findNearbyDrivers.mockResolvedValue([{ driverId: 'sedan_driver', distanceKm: 1.0 }]);
    Driver.find.mockResolvedValue([mockDriver]);
    driverLocationService.getDriverMeta.mockResolvedValue(null);

    const shortlist = await matchingService.findEligibleDrivers(trip, 1);
    expect(shortlist).toHaveLength(0);
  });

  // TEST 6 — findEligibleDrivers: filters out excluded driver
  test('findEligibleDrivers: filters out excluded driver', async () => {
    const trip = { _id: 'trip123', startLocation: [77.0, 11.0], regionCode: 'CMR', vehicleType: 'sedan' };
    const mockDriver = {
      _id: 'excluded_driver',
      isApproved: true,
      isAvailable: true,
      driverStatus: { status: 'online' },
      tripStatus: 'NOTRIP',
      role: 'acting_driver',
      experience: { vehicleTypes: ['sedan'] }
    };

    redisStateService.getExcludedDrivers.mockResolvedValue(new Set(['excluded_driver']));
    driverLocationService.findNearbyDrivers.mockResolvedValue([{ driverId: 'excluded_driver', distanceKm: 1.0 }]);
    Driver.find.mockResolvedValue([mockDriver]);
    driverLocationService.getDriverMeta.mockResolvedValue(null);

    const shortlist = await matchingService.findEligibleDrivers(trip, 1);
    expect(shortlist).toHaveLength(0);
  });

  // TEST 7 — findEligibleDrivers: returns max 5 drivers
  test('findEligibleDrivers: returns max 5 drivers', async () => {
    const trip = { _id: 'trip123', startLocation: [77.0, 11.0], regionCode: 'CMR', vehicleType: 'sedan' };
    
    const candidates = [];
    const drivers = [];
    for (let i = 1; i <= 10; i++) {
      candidates.push({ driverId: `driver_${i}`, distanceKm: 1.0 + i * 0.1 });
      drivers.push({
        _id: `driver_${i}`,
        isApproved: true,
        isAvailable: true,
        isBlocked: false,
        isDeleted: false,
        driverStatus: { status: 'online' },
        tripStatus: 'NOTRIP',
        role: 'acting_driver',
        experience: { vehicleTypes: ['sedan'] }
      });
    }

    redisStateService.getExcludedDrivers.mockResolvedValue(new Set());
    driverLocationService.findNearbyDrivers.mockResolvedValue(candidates);
    Driver.find.mockResolvedValue(drivers);
    driverLocationService.getDriverMeta.mockResolvedValue(null);

    const shortlist = await matchingService.findEligibleDrivers(trip, 1);
    expect(shortlist).toHaveLength(5);
  });

  // TEST 8 — findEligibleDrivers: sorted by score descending
  test('findEligibleDrivers: sorted by score descending', async () => {
    const trip = { _id: 'trip123', startLocation: [77.0, 11.0], regionCode: 'CMR', vehicleType: 'sedan' };
    
    // Driver with 3+ experience should score higher than 0-1 experience
    const mockDriverHigh = {
      _id: 'high_score_driver',
      isApproved: true,
      isAvailable: true,
      driverStatus: { status: 'online' },
      tripStatus: 'NOTRIP',
      role: 'acting_driver',
      experience: { vehicleTypes: ['sedan'], totalExperience: '5+' }
    };
    
    const mockDriverLow = {
      _id: 'low_score_driver',
      isApproved: true,
      isAvailable: true,
      driverStatus: { status: 'online' },
      tripStatus: 'NOTRIP',
      role: 'acting_driver',
      experience: { vehicleTypes: ['sedan'], totalExperience: '0-1' }
    };

    redisStateService.getExcludedDrivers.mockResolvedValue(new Set());
    driverLocationService.findNearbyDrivers.mockResolvedValue([
      { driverId: 'low_score_driver', distanceKm: 4.0 },
      { driverId: 'high_score_driver', distanceKm: 1.0 }
    ]);
    Driver.find.mockResolvedValue([mockDriverLow, mockDriverHigh]);
    driverLocationService.getDriverMeta.mockResolvedValue(null);

    const shortlist = await matchingService.findEligibleDrivers(trip, 1);
    expect(shortlist).toHaveLength(2);
    expect(shortlist[0].driverId).toBe('high_score_driver');
    expect(shortlist[1].driverId).toBe('low_score_driver');
    expect(shortlist[0].score).toBeGreaterThan(shortlist[1].score);
  });

  // TEST 8.5 — findEligibleDrivers: filters out driver with calendar conflict including travel time
  test('findEligibleDrivers: filters out driver with calendar conflict including travel time', async () => {
    const trip = {
      _id: 'new_trip_123',
      startLocation: [77.0, 11.0],
      regionCode: 'CMR',
      vehicleType: 'sedan',
      isScheduledTrip: true,
      scheduleDateTime: 1780486955000
    };

    const mockDriverWithConflict = {
      _id: 'conflicted_driver',
      isApproved: true,
      isAvailable: true,
      isBlocked: false,
      isDeleted: false,
      driverStatus: { status: 'online' },
      tripStatus: 'NOTRIP',
      role: 'acting_driver',
      experience: { vehicleTypes: ['sedan'] },
      upComingTrips: ['existing_trip_abc'],
      calendarBufferMinutes: 60
    };

    const existingTrip = {
      _id: 'existing_trip_abc',
      scheduleDateTime: 1780486955000 - 85 * 60 * 1000,
      estimatedDuration: 20,
      endLocation: [77.05, 11.05],
      status: 'ACCEPTED'
    };

    redisStateService.getExcludedDrivers.mockResolvedValue(new Set());
    driverLocationService.findNearbyDrivers.mockResolvedValue([{ driverId: 'conflicted_driver', distanceKm: 1.0 }]);
    Driver.find.mockResolvedValue([mockDriverWithConflict]);
    driverLocationService.getDriverMeta.mockResolvedValue(null);
    Trip.find.mockResolvedValue([existingTrip]);

    const shortlist = await matchingService.findEligibleDrivers(trip, 1);
    expect(shortlist).toHaveLength(0);
  });

  // TEST 8.6 — findEligibleDrivers: allows driver when no conflict after travel time and buffer
  test('findEligibleDrivers: allows driver when no conflict after travel time and buffer', async () => {
    const trip = {
      _id: 'new_trip_123',
      startLocation: [77.0, 11.0],
      regionCode: 'CMR',
      vehicleType: 'sedan',
      isScheduledTrip: true,
      scheduleDateTime: 1780486955000
    };

    const mockDriverNoConflict = {
      _id: 'non_conflicted_driver',
      isApproved: true,
      isAvailable: true,
      isBlocked: false,
      isDeleted: false,
      driverStatus: { status: 'online' },
      tripStatus: 'NOTRIP',
      role: 'acting_driver',
      experience: { vehicleTypes: ['sedan'] },
      upComingTrips: ['existing_trip_abc'],
      calendarBufferMinutes: 60
    };

    const existingTrip = {
      _id: 'existing_trip_abc',
      scheduleDateTime: 1780486955000 - 100 * 60 * 1000,
      estimatedDuration: 20,
      endLocation: [77.05, 11.05],
      status: 'ACCEPTED'
    };

    redisStateService.getExcludedDrivers.mockResolvedValue(new Set());
    driverLocationService.findNearbyDrivers.mockResolvedValue([{ driverId: 'non_conflicted_driver', distanceKm: 1.0 }]);
    Driver.find.mockResolvedValue([mockDriverNoConflict]);
    driverLocationService.getDriverMeta.mockResolvedValue(null);
    Trip.find.mockResolvedValue([existingTrip]);

    const shortlist = await matchingService.findEligibleDrivers(trip, 1);
    expect(shortlist).toHaveLength(1);
    expect(shortlist[0].driverId).toBe('non_conflicted_driver');
  });

  // TEST 9 — buildMatchLog: returns correct shape
  test('buildMatchLog: returns correct shape', () => {
    const log = matchingService.buildMatchLog('trip_request_attempt', 'driver123', { fare: 64 });
    expect(log).toHaveProperty('event', 'trip_request_attempt');
    expect(log).toHaveProperty('driver_id', 'driver123');
    expect(log).toHaveProperty('timestamp');
    expect(log).toHaveProperty('fare', 64);
  });

  // TEST 10 — rideIdGenerator: produces correct format
  test('rideIdGenerator: produces correct format', () => {
    const id = generateActingDriverRideId('CMR');
    expect(id).toMatch(/^ADCMR\d{12}$/);
    expect(id.length).toBe(17); // AD (2) + CMR (3) + DDMMYY (6) + random (6) = 17
  });
});
