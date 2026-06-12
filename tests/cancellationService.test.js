// Unit Tests for Cancellation Service & workers: verifies timeout thresholds, cancellation loops, and cleanup functions.
const { handleDriverCancellation } = require('../src/services/cancellationService');
const { handleTimeoutCheck } = require('../src/workers/timeoutWorker');
const cleanupWorker = require('../src/workers/cleanupWorker');
const tripService = require('../src/services/tripService');
const redisStateService = require('../src/services/redisStateService');
const { addMatchingJob } = require('../src/queues/matchingQueue');
const { addCleanupJob } = require('../src/queues/cleanupQueue');
const Trip = require('../src/models/Trip');
const matchingService = require('../src/services/matchingService');

// Mock dependencies
jest.mock('../src/services/tripService');
jest.mock('../src/services/redisStateService');
jest.mock('../src/queues/matchingQueue');
jest.mock('../src/queues/cleanupQueue');
jest.mock('../src/models/Trip');
jest.mock('../src/services/matchingService');

describe('Part 4: Retries, Cancellation & Cleanup Unit Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await cleanupWorker.close();
  });

  // 1. cancellationService tests
  describe('Cancellation Service Tests', () => {
    test('handleDriverCancellation: triggers rematch under limit count (cancellations < 3)', async () => {
      const tripId = 'trip123';
      const driverId = 'driver456';
      const cancelReason = 'vehicle broke down';

      const mockTrip = {
        _id: tripId,
        tripTimeline: [
          { state: 'ACCEPTED', timestamp: Date.now() - 10000 }
        ]
      };

      tripService.getTripById.mockResolvedValue(mockTrip);
      redisStateService.clearDriverActiveTrip.mockResolvedValue({});
      Trip.findByIdAndUpdate.mockResolvedValue({});
      redisStateService.addExcludedDriver.mockResolvedValue({});
      redisStateService.getExcludedDrivers.mockResolvedValue(new Set(['driver456']));
      addMatchingJob.mockResolvedValue({});

      // Act
      const result = await handleDriverCancellation(tripId, driverId, cancelReason);

      // Assert
      expect(result.success).toBe(true);
      expect(result.reason).toBe('RematchTriggered');
      expect(redisStateService.clearDriverActiveTrip).toHaveBeenCalledWith(driverId);
      expect(redisStateService.addExcludedDriver).toHaveBeenCalledWith(tripId, driverId);
      
      // Check MongoDB timeline and status update
      expect(Trip.findByIdAndUpdate).toHaveBeenCalledWith(
        tripId,
        expect.objectContaining({
          $set: { status: 'MATCHING' },
          $push: expect.objectContaining({
            tripTimeline: expect.objectContaining({ state: 'CANCELLED_BY_DRIVER_BEFORE_PICKUP' }),
            rideMatchLog: expect.objectContaining({ event: 'rematch_triggered', driver_id: driverId, reason: cancelReason })
          })
        }),
        { new: true }
      );

      // Check re-queuing matching job
      expect(addMatchingJob).toHaveBeenCalledWith(
        { tripId, attempt: 1, excludedDriverIds: ['driver456'] },
        { priority: 1 }
      );
    });

    test('handleDriverCancellation: fails trip when cancellation limit is hit (cancellations >= 3)', async () => {
      const tripId = 'trip123';
      const driverId = 'driver456';
      const cancelReason = 'fatigue';

      const mockTrip = {
        _id: tripId,
        tripTimeline: [
          { state: 'CANCELLED_BY_DRIVER_BEFORE_PICKUP', timestamp: 1 },
          { state: 'CANCELLED_BY_DRIVER_BEFORE_PICKUP', timestamp: 2 },
          { state: 'CANCELLED_BY_DRIVER_BEFORE_PICKUP', timestamp: 3 }
        ]
      };

      tripService.getTripById.mockResolvedValue(mockTrip);
      tripService.markTripAsFailed.mockResolvedValue({});
      addCleanupJob.mockResolvedValue({});

      // Act
      const result = await handleDriverCancellation(tripId, driverId, cancelReason);

      // Assert
      expect(result.success).toBe(false);
      expect(result.reason).toBe('MaxRetriesExceeded');
      expect(tripService.markTripAsFailed).toHaveBeenCalledWith(tripId, 'MaxRetriesExceeded');
      expect(addCleanupJob).toHaveBeenCalledWith({ tripId, reason: 'failed' });
      expect(addMatchingJob).not.toHaveBeenCalled();
    });
  });

  // 2. timeoutWorker tests
  describe('Timeout Worker Tests', () => {
    test('handleTimeoutCheck: skips check if trip is already allocated in Redis', async () => {
      const mockJob = { data: { tripId: 'trip123', attempt: 1 } };
      tripService.getTripById.mockResolvedValue({ _id: 'trip123', status: 'MATCHING' });
      redisStateService.getTripMatchingStatus.mockResolvedValue('allocated');

      await handleTimeoutCheck(mockJob);

      expect(redisStateService.getAttemptCount).not.toHaveBeenCalled();
      expect(addMatchingJob).not.toHaveBeenCalled();
    });

    test('handleTimeoutCheck: increments attempt if attempt < 3', async () => {
      const mockJob = { data: { tripId: 'trip123', attempt: 1 } };
      tripService.getTripById.mockResolvedValue({ _id: 'trip123', status: 'MATCHING' });
      redisStateService.getTripMatchingStatus.mockResolvedValue('in_progress');
      redisStateService.getAttemptCount.mockResolvedValue(1);

      // shortlist contains driver1, responses contains nothing (timeout)
      redisStateService.getShortlist.mockResolvedValue(['driver1']);
      redisStateService.getDriverResponses.mockResolvedValue({});
      redisStateService.recordDriverResponse.mockResolvedValue({});
      redisStateService.addExcludedDriver.mockResolvedValue({});
      matchingService.buildMatchLog.mockReturnValue({ event: 'driver_trip_response' });
      tripService.appendMatchLog.mockResolvedValue({});
      redisStateService.getExcludedDrivers.mockResolvedValue(new Set(['driver1']));
      addMatchingJob.mockResolvedValue({});

      await handleTimeoutCheck(mockJob);

      // Non-responsive driver should be marked timeout and excluded
      expect(redisStateService.recordDriverResponse).toHaveBeenCalledWith('trip123', 'driver1', 'timeout');
      expect(redisStateService.addExcludedDriver).toHaveBeenCalledWith('trip123', 'driver1');
      expect(tripService.appendMatchLog).toHaveBeenCalled();
      
      // Re-trigger matching queue at attempt 2
      expect(addMatchingJob).toHaveBeenCalledWith({
        tripId: 'trip123',
        attempt: 2,
        excludedDriverIds: ['driver1']
      });
    });

    test('handleTimeoutCheck: fails trip and triggers cleanup if attempt === 3', async () => {
      const mockJob = { data: { tripId: 'trip123', attempt: 3 } };
      tripService.getTripById.mockResolvedValue({ _id: 'trip123', status: 'MATCHING' });
      redisStateService.getTripMatchingStatus.mockResolvedValue('in_progress');
      redisStateService.getAttemptCount.mockResolvedValue(3);

      tripService.markTripAsFailed.mockResolvedValue({});
      matchingService.buildMatchLog.mockReturnValue({ event: 'match_failed' });
      tripService.appendMatchLog.mockResolvedValue({});
      addCleanupJob.mockResolvedValue({});

      await handleTimeoutCheck(mockJob);

      expect(tripService.markTripAsFailed).toHaveBeenCalledWith('trip123', 'NoAvailableDrivers');
      expect(addCleanupJob).toHaveBeenCalledWith({ tripId: 'trip123', reason: 'failed' });
      expect(addMatchingJob).not.toHaveBeenCalled();
    });
  });

  // 3. cleanupWorker tests
  describe('Cleanup Worker Tests', () => {
    test('cleanupWorker: executes database key wipes and logs operation', async () => {
      const mockJob = { data: { tripId: 'trip123', reason: 'failed' } };
      redisStateService.cleanupAllTripKeys.mockResolvedValue({});

      // Run cleanup processor directly
      await cleanupWorker.processJob(mockJob);

      expect(redisStateService.cleanupAllTripKeys).toHaveBeenCalledWith('trip123');
    });
  });
});
