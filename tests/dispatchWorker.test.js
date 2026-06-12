// Unit Tests for Dispatch Worker & Socket handlers: verifies simultaneous alerts and driver accept race conditions.
const dispatchWorker = require('../src/workers/dispatchWorker');
const { registerHandlers } = require('../src/socket/handlers');
const { initSocketGateway, getIO } = require('../src/socket/gateway');
const tripService = require('../src/services/tripService');
const matchingService = require('../src/services/matchingService');
const redisStateService = require('../src/services/redisStateService');
const { addMatchingJob } = require('../src/queues/matchingQueue');
const { addCleanupJob } = require('../src/queues/cleanupQueue');
const Trip = require('../src/models/Trip');

// Mock dependencies
jest.mock('../src/services/tripService');
jest.mock('../src/services/matchingService');
jest.mock('../src/services/redisStateService');
jest.mock('../src/queues/matchingQueue');
jest.mock('../src/queues/cleanupQueue');
jest.mock('../src/socket/gateway', () => {
  const original = jest.requireActual('../src/socket/gateway');
  return {
    ...original,
    getIO: jest.fn()
  };
});
jest.mock('../src/models/Trip');

describe('Dispatch Worker & Handlers Unit Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await dispatchWorker.close();
  });

  // TEST 1 — Verify Simultaneous Broadcast
  test('Verify Simultaneous Broadcast: emits trip_request exactly 5 times', async () => {
    // Setup
    const tripId = 'trip123';
    const shortlistedDriverIds = ['driver1', 'driver2', 'driver3', 'driver4', 'driver5'];
    const mockTrip = {
      _id: tripId,
      status: 'MATCHING',
      estimatedFare: 64
    };

    tripService.getTripById.mockResolvedValue(mockTrip);
    tripService.appendMatchLog.mockResolvedValue({});
    matchingService.buildMatchLog.mockImplementation((event, driverId) => ({ event, driver_id: driverId }));
    addMatchingJob.mockResolvedValue({});

    // Mock IO object with fluent interface
    const mockIo = {
      to: jest.fn().mockReturnThis(),
      emit: jest.fn()
    };
    getIO.mockReturnValue(mockIo);

    const mockJob = {
      data: {
        tripId,
        shortlistedDriverIds,
        fareAmount: 64,
        attempt: 1
      }
    };

    // Act
    await dispatchWorker.processJob(mockJob);

    // Assert
    expect(tripService.getTripById).toHaveBeenCalledWith(tripId);
    expect(tripService.appendMatchLog).toHaveBeenCalled();
    
    // Ensure emit was called 5 times, once for each room
    expect(mockIo.to).toHaveBeenCalledTimes(5);
    shortlistedDriverIds.forEach(driverId => {
      expect(mockIo.to).toHaveBeenCalledWith(`driver:room:${driverId}`);
    });
    expect(mockIo.emit).toHaveBeenCalledTimes(5);
    expect(mockIo.emit).toHaveBeenCalledWith('trip_request', {
      tripId,
      fare: 64,
      currency: '₹',
      attempt: 1,
      timeoutMs: 15000
    });

    // Ensure delayed timeout check job was scheduled
    expect(addMatchingJob).toHaveBeenCalledWith(
      { tripId, attempt: 1, isTimeoutCheck: true },
      { delay: 15000, jobId: `${tripId}_timeout_1` }
    );
  });

  // TEST 2 — Race-Condition Resolution Test
  test('Race-Condition Resolution: only first driver acquires lock and is assigned', async () => {
    const tripId = 'trip_race_123';
    const driverIdA = 'driver_A';
    const driverIdB = 'driver_B';

    // Mock Redis Lock State
    let currentLockHolder = null;
    redisStateService.acquireTripLock.mockImplementation(async (tid, did) => {
      if (currentLockHolder) {
        return false;
      }
      currentLockHolder = did;
      return true;
    });

    let redisMatchingStatus = 'in_progress';
    redisStateService.getTripMatchingStatus.mockImplementation(async () => redisMatchingStatus);
    redisStateService.setTripMatchingStatus.mockImplementation(async (tid, status) => {
      redisMatchingStatus = status;
    });

    redisStateService.getShortlist.mockResolvedValue([driverIdA, driverIdB]);
    addCleanupJob.mockResolvedValue({});

    // Mock Mongoose model update
    Trip.findOneAndUpdate.mockImplementation(async (query, update) => {
      // Simulate MongoDB update condition
      if (query._id === tripId && query.status === 'MATCHING') {
        return { _id: tripId, status: 'ACCEPTED', driverId: query.driverId };
      }
      return null;
    });

    // Mock IO and Socket
    const mockIo = {
      to: jest.fn().mockReturnThis(),
      emit: jest.fn()
    };

    const socketA = {
      on: jest.fn(),
      emit: jest.fn()
    };
    const socketB = {
      on: jest.fn(),
      emit: jest.fn()
    };

    // Grab callback registered for accept
    let acceptCallback = null;
    socketA.on.mockImplementation((event, callback) => {
      if (event === 'driver_accept') {
        acceptCallback = callback;
      }
    });
    // Register handlers on socketA (which saves the callbacks)
    registerHandlers(mockIo, socketA);

    // Make socketB use the same registration function but bind its own emitter
    const registerHandlersForSocket = (ioRef, sockRef) => {
      let cb = null;
      sockRef.on.mockImplementation((event, callback) => {
        if (event === 'driver_accept') {
          cb = callback;
        }
      });
      registerHandlers(ioRef, sockRef);
      return cb;
    };
    const acceptCallbackB = registerHandlersForSocket(mockIo, socketB);

    // Verify registrations
    expect(acceptCallback).toBeDefined();
    expect(acceptCallbackB).toBeDefined();

    // Act: Simultaneously fire accept event from both drivers
    const pA = acceptCallback({ tripId, driverId: driverIdA });
    const pB = acceptCallbackB({ tripId, driverId: driverIdB });

    await Promise.all([pA, pB]);

    // Assertions
    // Only one should have successfully acquired the lock and been assigned
    expect(currentLockHolder).toBe(driverIdA); // Since Javascript promise resolves driver A first in Promise.all order here
    
    // One socket got the confirmed assignment and the other got ORDER_TAKEN
    const emittedToA = socketA.emit.mock.calls.find(call => call[0] === 'trip_error');
    const emittedToB = socketB.emit.mock.calls.find(call => call[0] === 'trip_error');

    // Driver B should fail with ORDER_TAKEN
    expect(emittedToB).toBeDefined();
    expect(emittedToB[1]).toEqual({ reason: 'ORDER_TAKEN' });

    // Driver A should not have received ORDER_TAKEN error
    expect(emittedToA).toBeUndefined();

    // IO should confirm the successful driver assignment
    expect(mockIo.to).toHaveBeenCalledWith(`driver:room:${driverIdA}`);
    expect(mockIo.emit).toHaveBeenCalledWith('trip_assignment_confirmed', { tripId });

    // IO should withdraw request from losing candidates
    expect(mockIo.to).toHaveBeenCalledWith(`driver:room:${driverIdB}`);
    expect(mockIo.emit).toHaveBeenCalledWith('trip_request_withdrawn', { tripId, reason: 'TAKEN' });

    // Cleanup queue should be triggered for allocation
    expect(addCleanupJob).toHaveBeenCalledWith({ tripId, reason: 'allocated' });
  });
});
