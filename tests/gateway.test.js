// Unit Tests for Part 5 REST APIs & Socket.IO Gateway.
const { bookTrip } = require('../src/api/controllers/tripController');
const { initSocketGateway } = require('../src/socket/gateway');
const Trip = require('../src/models/Trip');
const Driver = require('../src/models/Driver');
const redisStateService = require('../src/services/redisStateService');
const driverLocationService = require('../src/services/driverLocationService');
const rideIdGenerator = require('../src/utils/rideIdGenerator');
const mongoose = require('mongoose');

// Mock dependencies
jest.mock('../src/models/Trip');
jest.mock('../src/models/Driver');
jest.mock('../src/services/redisStateService');
jest.mock('../src/services/driverLocationService');
jest.mock('../src/utils/rideIdGenerator');
jest.mock('socket.io', () => {
  return {
    Server: jest.fn().mockImplementation(() => {
      return {
        on: jest.fn()
      };
    })
  };
});

describe('Part 5: REST API & Socket.IO Telemetry Gateway Unit Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ==========================================
  // REST Ingestion Tests
  // ==========================================
  describe('Trip Ingestion Controller', () => {
    test('bookTrip: returns 400 when startLocation is missing', async () => {
      const req = {
        body: {
          endLocation: [77.0, 11.0],
          vehicleType: 'sedan',
          userId: 'user123'
        }
      };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };

      await bookTrip(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.stringContaining('startLocation')
      }));
    });

    test('bookTrip: saves trip and returns 211 with immediate booking', async () => {
      const mockTripId = new mongoose.Types.ObjectId();
      const mockTripInstance = {
        _id: mockTripId,
        save: jest.fn().mockResolvedValue(true)
      };
      Trip.mockImplementation(() => mockTripInstance);

      rideIdGenerator.generateActingDriverRideId.mockReturnValue('ADCMR060326999999');
      redisStateService.addTripToScheduler.mockResolvedValue({});

      const req = {
        body: {
          startLocation: [77.0, 11.0],
          endLocation: [78.0, 12.0],
          vehicleType: 'sedan',
          userId: 'user123',
          isScheduledTrip: false
        }
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };

      await bookTrip(req, res);

      expect(rideIdGenerator.generateActingDriverRideId).toHaveBeenCalledWith('CMR');
      expect(mockTripInstance.save).toHaveBeenCalled();
      expect(redisStateService.addTripToScheduler).toHaveBeenCalledWith(
        mockTripId.toString(),
        expect.any(Number)
      );
      expect(res.status).toHaveBeenCalledWith(211);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        trip: mockTripInstance
      }));
    });

    test('bookTrip: saves trip and returns 211 with scheduled booking score', async () => {
      const mockTripId = new mongoose.Types.ObjectId();
      const mockTripInstance = {
        _id: mockTripId,
        save: jest.fn().mockResolvedValue(true)
      };
      Trip.mockImplementation(() => mockTripInstance);

      rideIdGenerator.generateActingDriverRideId.mockReturnValue('ADCMR060326999999');
      redisStateService.addTripToScheduler.mockResolvedValue({});

      const req = {
        body: {
          startLocation: [77.0, 11.0],
          endLocation: [78.0, 12.0],
          vehicleType: 'sedan',
          userId: 'user123',
          isScheduledTrip: true,
          scheduleDateTime: 1774880000000
        }
      };

      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };

      await bookTrip(req, res);

      expect(mockTripInstance.save).toHaveBeenCalled();
      expect(redisStateService.addTripToScheduler).toHaveBeenCalledWith(
        mockTripId.toString(),
        1774880000000
      );
      expect(res.status).toHaveBeenCalledWith(211);
    });
  });

  // ==========================================
  // Socket.IO Telemetry Gateway Tests
  // ==========================================
  describe('Socket.IO Gateway Hooks', () => {
    let mockIo;
    let mockSocket;
    let registeredEvents = {};

    beforeEach(() => {
      registeredEvents = {};
      mockSocket = {
        id: 'socket_session_99',
        join: jest.fn(),
        emit: jest.fn(),
        on: jest.fn().mockImplementation((event, cb) => {
          registeredEvents[event] = cb;
        })
      };

      const { Server } = require('socket.io');
      Server.mockImplementation(() => {
        mockIo = {
          on: jest.fn().mockImplementation((event, cb) => {
            if (event === 'connection') {
              // Trigger connection immediately
              cb(mockSocket);
            }
          })
        };
        return mockIo;
      });
    });

    test('connection: registers telemetry handlers and room joining logic', () => {
      initSocketGateway();

      expect(registeredEvents['driver_register_presence']).toBeDefined();
      expect(registeredEvents['driver_telemetry_ping']).toBeDefined();
      expect(registeredEvents['disconnect']).toBeDefined();
    });

    test('driver_register_presence: joins correct rooms and stores context details', async () => {
      initSocketGateway();

      const registerPresence = registeredEvents['driver_register_presence'];
      await registerPresence({ driverId: 'driver123', regionCode: 'CMR' });

      expect(mockSocket.driverId).toBe('driver123');
      expect(mockSocket.regionCode).toBe('CMR');
      expect(mockSocket.join).toHaveBeenCalledWith('driver:room:driver123');
      expect(mockSocket.join).toHaveBeenCalledWith('region:room:CMR');
    });

    test('driver_telemetry_ping: fires location upsert only if presence is registered', async () => {
      initSocketGateway();

      const telemetryPing = registeredEvents['driver_telemetry_ping'];
      
      // Ping without presence registration (no driverId on socket)
      await telemetryPing({ longitude: 77.1, latitude: 11.1 });
      expect(driverLocationService.upsertDriverLocation).not.toHaveBeenCalled();

      // Register presence, then ping
      mockSocket.driverId = 'driver_ok';
      mockSocket.regionCode = 'CMR';
      await telemetryPing({ longitude: 77.1, latitude: 11.1 });
      expect(driverLocationService.upsertDriverLocation).toHaveBeenCalledWith(
        'driver_ok',
        77.1,
        11.1,
        'CMR'
      );
    });

    test('disconnect: transitions driver to offline state in database', async () => {
      initSocketGateway();

      const disconnectHandler = registeredEvents['disconnect'];
      Driver.updateOne.mockResolvedValue({ nModified: 1 });

      // Disconnect without registered presence
      await disconnectHandler();
      expect(Driver.updateOne).not.toHaveBeenCalled();

      // Disconnect with presence
      mockSocket.driverId = 'driver_active';
      await disconnectHandler();
      expect(Driver.updateOne).toHaveBeenCalledWith(
        { _id: 'driver_active' },
        expect.objectContaining({
          $set: expect.objectContaining({ "driverStatus.status": "offline" })
        })
      );
    });
  });
});
